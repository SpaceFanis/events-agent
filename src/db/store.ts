import { createClient, type Client, type Row, type Value } from "@libsql/client";
import { z } from "zod";
import { eventTypeSchema } from "../config.js";
import type { AccessType, LocationTier, ScoutedEvent, StoredEvent } from "../types.js";
import { SCHEMA, SCHEMA_VERSION } from "./schema.js";

const locationTierSchema = z.enum([
  "online",
  "local",
  "country",
  "abroad",
] satisfies LocationTier[]);
const accessTypeSchema = z.enum(["open", "application", "invite"] satisfies AccessType[]);

export type MessageKind = "alert" | "reminder" | "nudge" | "notice";

export interface UnconfirmedAlert {
  eventId: number;
  state: string;
  claimedAt: string;
}

export interface RunStats {
  itemsFetched: number;
  itemsNew: number;
  itemsLlm: number;
  alertsSent: number;
  costUsd: number;
  errors: string[];
}

/** Persistence used by the pipeline. One implementation over libSQL serves Turso, files and :memory:. */
export interface Store {
  migrate(): Promise<void>;
  /** Inserts the event unless its URL, dedupe hash or source id is already known. Returns the new id or null. */
  insertIfNew(event: ScoutedEvent, status: string, now: Date): Promise<number | null>;
  /**
   * Events in status `new` with no alert claimed yet, not ended, and fewer than `maxAttempts` failed sends.
   * Includes retries after a failed send.
   */
  eventsAwaitingAlert(now: Date, maxAttempts: number, limit: number): Promise<StoredEvent[]>;
  /**
   * Atomically claims the alert for an event by inserting its message row before sending. Returns the row id,
   * or null if another run already claimed it. A crash after the claim leaves a row with no Telegram id:
   * reported by unconfirmedAlerts() and never re-sent automatically.
   */
  claimAlert(eventId: number, chatId: string, now: Date): Promise<number | null>;
  /** Marks a claimed alert as sent. */
  completeAlert(messageRowId: number, telegramMessageId: number, sentAt: Date): Promise<void>;
  /** Keeps the claim but records that the send may have been delivered (timeout); never resent. */
  markAlertUnknown(messageRowId: number): Promise<void>;
  /**
   * Releases a claim after a failed send so the next run retries it. `countAttempt` is true only when
   * Telegram rejected this particular message; outages don't use up an event's attempts.
   */
  releaseAlert(messageRowId: number, eventId: number, countAttempt: boolean): Promise<void>;
  /**
   * Alerts never confirmed sent: every `unknown` one (timeout), plus `claimed` ones older than
   * `claimedBefore` (crash or failed write; newer ones may still be in flight in an overlapping run).
   */
  unconfirmedAlerts(claimedBefore: Date): Promise<UnconfirmedAlert[]>;
  startRun(now: Date): Promise<number>;
  finishRun(runId: number, stats: RunStats, now: Date): Promise<void>;
  close(): void;
}

const stringArray = z.array(z.string());

function text(row: Row, column: string): string {
  const value: Value | undefined = row[column];
  if (typeof value !== "string") throw new Error(`events.${column}: expected text`);
  return value;
}

function textOrNull(row: Row, column: string): string | null {
  const value: Value | undefined = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`events.${column}: expected text or null`);
  return value;
}

function integer(row: Row, column: string): number {
  const value: Value | undefined = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`events.${column}: expected integer`);
}

function toStoredEvent(row: Row): StoredEvent {
  return {
    id: integer(row, "id"),
    status: text(row, "status"),
    source: text(row, "source"),
    sourceId: text(row, "source_id"),
    canonicalUrl: text(row, "canonical_url"),
    dedupeHash: textOrNull(row, "dedupe_hash"),
    title: text(row, "title"),
    organiser: textOrNull(row, "organiser"),
    type: eventTypeSchema.parse(text(row, "type")),
    startsAt: textOrNull(row, "starts_at"),
    endsAt: textOrNull(row, "ends_at"),
    timezone: text(row, "timezone"),
    locationText: textOrNull(row, "location_text") ?? "",
    isOnline: integer(row, "is_online") === 1,
    locationTier: locationTierSchema.parse(text(row, "location_tier")),
    accessType: accessTypeSchema.nullable().parse(textOrNull(row, "access_type")),
    registerUrl: textOrNull(row, "register_url"),
    prizes: textOrNull(row, "prizes"),
    tags: stringArray.parse(JSON.parse(text(row, "tags"))),
    unverifiedFields: stringArray.parse(JSON.parse(text(row, "unverified_fields"))),
  };
}

export class LibsqlStore implements Store {
  constructor(private readonly client: Client) {}

  async migrate(): Promise<void> {
    const row = (await this.client.execute("PRAGMA user_version")).rows[0];
    if (row === undefined) throw new Error("PRAGMA user_version returned no row");
    const version = integer(row, "user_version");
    if (version === 0) {
      const tables = await this.client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%'",
      );
      if (tables.rows.length > 0) {
        throw new Error(
          `database has tables but no schema version (${tables.rows.map((r) => text(r, "name")).join(", ")}); refusing to guess`,
        );
      }
      await this.client.batch(
        [...SCHEMA, `PRAGMA user_version = ${String(SCHEMA_VERSION)}`],
        "write",
      );
    } else if (version !== SCHEMA_VERSION) {
      throw new Error(
        `database schema is version ${String(version)}, code expects ${String(SCHEMA_VERSION)}`,
      );
    }
  }

  async insertIfNew(event: ScoutedEvent, status: string, now: Date): Promise<number | null> {
    const at = now.toISOString();
    const result = await this.client.execute({
      sql: `INSERT INTO events (
        source, source_id, canonical_url, dedupe_hash, title, organiser, type, starts_at, ends_at,
        timezone, location_text, is_online, location_tier, access_type, register_url, prizes, tags,
        unverified_fields, status, first_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING RETURNING id`,
      args: [
        event.source,
        event.sourceId,
        event.canonicalUrl,
        event.dedupeHash,
        event.title,
        event.organiser,
        event.type,
        event.startsAt,
        event.endsAt,
        event.timezone,
        event.locationText,
        event.isOnline ? 1 : 0,
        event.locationTier,
        event.accessType,
        event.registerUrl,
        event.prizes,
        JSON.stringify(event.tags),
        JSON.stringify(event.unverifiedFields),
        status,
        at,
        at,
      ],
    });
    const row = result.rows[0];
    return row === undefined ? null : integer(row, "id");
  }

  async eventsAwaitingAlert(now: Date, maxAttempts: number, limit: number): Promise<StoredEvent[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM events e
       WHERE e.status = 'new'
         AND e.alert_attempts < ?
         AND (e.ends_at IS NULL OR e.ends_at >= ?)
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.event_id = e.id AND m.kind = 'alert')
       ORDER BY e.id
       LIMIT ?`,
      args: [maxAttempts, now.toISOString(), limit],
    });
    return result.rows.map(toStoredEvent);
  }

  async claimAlert(eventId: number, chatId: string, now: Date): Promise<number | null> {
    // The partial unique index messages_one_alert makes this the single point of truth across runs.
    // ON CONFLICT (unlike OR IGNORE) only absorbs uniqueness conflicts; other violations still throw.
    const result = await this.client.execute({
      sql: `INSERT INTO messages (event_id, chat_id, kind, state, claimed_at) VALUES (?, ?, 'alert', 'claimed', ?)
            ON CONFLICT DO NOTHING RETURNING id`,
      args: [eventId, chatId, now.toISOString()],
    });
    const row = result.rows[0];
    return row === undefined ? null : integer(row, "id");
  }

  async completeAlert(
    messageRowId: number,
    telegramMessageId: number,
    sentAt: Date,
  ): Promise<void> {
    await this.client.execute({
      sql: `UPDATE messages SET state = 'sent', telegram_message_id = ?, sent_at = ? WHERE id = ?`,
      args: [telegramMessageId, sentAt.toISOString(), messageRowId],
    });
  }

  async markAlertUnknown(messageRowId: number): Promise<void> {
    await this.client.execute({
      sql: `UPDATE messages SET state = 'unknown' WHERE id = ? AND state = 'claimed'`,
      args: [messageRowId],
    });
  }

  async releaseAlert(messageRowId: number, eventId: number, countAttempt: boolean): Promise<void> {
    await this.client.batch(
      [
        { sql: `DELETE FROM messages WHERE id = ? AND state = 'claimed'`, args: [messageRowId] },
        {
          sql: `UPDATE events SET alert_attempts = alert_attempts + ? WHERE id = ?`,
          args: [countAttempt ? 1 : 0, eventId],
        },
      ],
      "write",
    );
  }

  async unconfirmedAlerts(claimedBefore: Date): Promise<UnconfirmedAlert[]> {
    const result = await this.client.execute({
      sql: `SELECT event_id, state, claimed_at FROM messages
            WHERE kind = 'alert' AND (state = 'unknown' OR (state = 'claimed' AND claimed_at < ?))
            ORDER BY event_id`,
      args: [claimedBefore.toISOString()],
    });
    return result.rows.map((row) => ({
      eventId: integer(row, "event_id"),
      state: text(row, "state"),
      claimedAt: text(row, "claimed_at"),
    }));
  }

  async startRun(now: Date): Promise<number> {
    const result = await this.client.execute({
      sql: `INSERT INTO runs (started_at) VALUES (?) RETURNING id`,
      args: [now.toISOString()],
    });
    const row = result.rows[0];
    if (row === undefined) throw new Error("runs insert returned no id");
    return integer(row, "id");
  }

  async finishRun(runId: number, stats: RunStats, now: Date): Promise<void> {
    await this.client.execute({
      sql: `UPDATE runs SET finished_at = ?, items_fetched = ?, items_new = ?, items_llm = ?,
              alerts_sent = ?, cost_usd = ?, errors = ? WHERE id = ?`,
      args: [
        now.toISOString(),
        stats.itemsFetched,
        stats.itemsNew,
        stats.itemsLlm,
        stats.alertsSent,
        stats.costUsd,
        JSON.stringify(stats.errors),
        runId,
      ],
    });
  }

  close(): void {
    this.client.close();
  }
}

/** Opens a store; `url` is a Turso libsql:// URL, a file: path, or ":memory:" for replay and tests. */
export async function openStore(url: string, authToken?: string): Promise<LibsqlStore> {
  const store = new LibsqlStore(
    createClient(authToken === undefined ? { url } : { url, authToken }),
  );
  await store.migrate();
  return store;
}
