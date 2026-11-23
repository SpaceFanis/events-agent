import { createClient, type Client, type Row, type Value } from "@libsql/client";
import { z } from "zod";
import { eventTypeSchema } from "../config.js";
import type {
  AccessType,
  EventDetails,
  EventStatus,
  LocationTier,
  ScoutedEvent,
  StoredEvent,
} from "../types.js";
import { MIGRATIONS, SCHEMA, SCHEMA_VERSION } from "./schema.js";

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

/** A cached LLM extraction for one page URL (SPEC: extract once per URL, cached forever). */
export interface CachedExtraction {
  url: string;
  contentHash: string;
  model: string;
  rawJson: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LlmCallRecord {
  runId: number;
  url: string;
  model: string;
  /** ok, or why the output was unusable (refusal, max_tokens, invalid, error). */
  outcome: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  at: Date;
}

/** What the extraction stage writes back onto an event. */
export type ExtractionUpdate = Pick<
  ScoutedEvent,
  | "organiser"
  | "startsAt"
  | "endsAt"
  | "timezone"
  | "locationText"
  | "isOnline"
  | "locationTier"
  | "accessType"
  | "registerUrl"
  | "prizes"
  | "unverifiedFields"
> &
  EventDetails;

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
  /** Events waiting for page extraction that haven't ended, least recently tried first. */
  eventsPendingExtraction(now: Date, limit: number): Promise<StoredEvent[]>;
  getExtraction(url: string): Promise<CachedExtraction | null>;
  /** Saves (or replaces) the cached extraction for a URL. */
  saveExtraction(extraction: CachedExtraction, now: Date): Promise<void>;
  /** Writes extracted fields and the resulting status, if the event is still pending extraction. */
  applyExtraction(
    eventId: number,
    update: ExtractionUpdate,
    status: EventStatus,
    now: Date,
  ): Promise<void>;
  /** Moves an event to the back of the extraction queue (its page or call failed, not counted). */
  deferExtraction(eventId: number, now: Date): Promise<void>;
  /** Counts an unusable LLM answer for the event; after `maxAttempts` it becomes extraction_failed. */
  failExtraction(eventId: number, maxAttempts: number, now: Date): Promise<void>;
  recordLlmCall(call: LlmCallRecord): Promise<void>;
  /**
   * LLM spend (USD) since `since`: the larger of the per-call log and the per-run totals, so a
   * failed cost-log write can't hide spend from the monthly cap.
   */
  llmSpendSince(since: Date): Promise<number>;
  noticeSent(key: string): Promise<boolean>;
  recordNotice(key: string, chatId: string, telegramMessageId: number, now: Date): Promise<void>;
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

function numberOrNull(row: Row, column: string): number | null {
  const value: Value | undefined = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`events.${column}: expected number or null`);
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
    city: textOrNull(row, "city"),
    country: textOrNull(row, "country"),
    registerSteps: textOrNull(row, "register_steps"),
    applyDeadline: textOrNull(row, "apply_deadline"),
    resultsDate: textOrNull(row, "results_date"),
    cost: textOrNull(row, "cost"),
    travelSupport: textOrNull(row, "travel_support"),
    eligibility: textOrNull(row, "eligibility"),
    score: numberOrNull(row, "score"),
    scoreReason: textOrNull(row, "score_reason"),
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
    } else if (version > 0 && version < SCHEMA_VERSION) {
      const steps: string[] = [];
      for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
        const migration = MIGRATIONS[next];
        if (migration === undefined)
          throw new Error(`no migration to schema version ${String(next)}`);
        steps.push(...migration);
      }
      // One write batch: the database is either fully migrated or untouched.
      await this.client.batch(
        [...steps, `PRAGMA user_version = ${String(SCHEMA_VERSION)}`],
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
         AND (e.apply_deadline IS NULL OR e.apply_deadline >= ?)
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.event_id = e.id AND m.kind = 'alert')
       ORDER BY e.id
       LIMIT ?`,
      args: [maxAttempts, now.toISOString(), now.toISOString(), limit],
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

  async eventsPendingExtraction(now: Date, limit: number): Promise<StoredEvent[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM events
            WHERE status = 'pending_extraction' AND (ends_at IS NULL OR ends_at >= ?)
            ORDER BY updated_at, id LIMIT ?`,
      args: [now.toISOString(), limit],
    });
    return result.rows.map(toStoredEvent);
  }

  async getExtraction(url: string): Promise<CachedExtraction | null> {
    const result = await this.client.execute({
      sql: `SELECT * FROM extractions WHERE url = ?`,
      args: [url],
    });
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      url: text(row, "url"),
      contentHash: text(row, "content_hash"),
      model: text(row, "model"),
      rawJson: text(row, "raw_json"),
      inputTokens: integer(row, "input_tokens"),
      outputTokens: integer(row, "output_tokens"),
      costUsd: numberOrNull(row, "cost_usd") ?? 0,
    };
  }

  async saveExtraction(extraction: CachedExtraction, now: Date): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO extractions (url, content_hash, model, raw_json, input_tokens, output_tokens, cost_usd, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (url) DO UPDATE SET content_hash = excluded.content_hash, model = excluded.model,
              raw_json = excluded.raw_json, input_tokens = excluded.input_tokens,
              output_tokens = excluded.output_tokens, cost_usd = excluded.cost_usd, created_at = excluded.created_at`,
      args: [
        extraction.url,
        extraction.contentHash,
        extraction.model,
        extraction.rawJson,
        extraction.inputTokens,
        extraction.outputTokens,
        extraction.costUsd,
        now.toISOString(),
      ],
    });
  }

  async applyExtraction(
    eventId: number,
    update: ExtractionUpdate,
    status: EventStatus,
    now: Date,
  ): Promise<void> {
    await this.client.execute({
      sql: `UPDATE events SET organiser = ?, starts_at = ?, ends_at = ?, timezone = ?, location_text = ?,
              city = ?, country = ?, is_online = ?, location_tier = ?, access_type = ?, register_url = ?,
              register_steps = ?, apply_deadline = ?, results_date = ?, cost = ?, travel_support = ?,
              prizes = ?, eligibility = ?, score = ?, score_reason = ?, unverified_fields = ?,
              status = ?, updated_at = ?
            WHERE id = ? AND status = 'pending_extraction'`,
      args: [
        update.organiser,
        update.startsAt,
        update.endsAt,
        update.timezone,
        update.locationText,
        update.city,
        update.country,
        update.isOnline ? 1 : 0,
        update.locationTier,
        update.accessType,
        update.registerUrl,
        update.registerSteps,
        update.applyDeadline,
        update.resultsDate,
        update.cost,
        update.travelSupport,
        update.prizes,
        update.eligibility,
        update.score,
        update.scoreReason,
        JSON.stringify(update.unverifiedFields),
        status,
        now.toISOString(),
        eventId,
      ],
    });
  }

  async deferExtraction(eventId: number, now: Date): Promise<void> {
    await this.client.execute({
      sql: `UPDATE events SET updated_at = ? WHERE id = ? AND status = 'pending_extraction'`,
      args: [now.toISOString(), eventId],
    });
  }

  async failExtraction(eventId: number, maxAttempts: number, now: Date): Promise<void> {
    await this.client.execute({
      sql: `UPDATE events SET extract_attempts = extract_attempts + 1,
              status = CASE WHEN extract_attempts + 1 >= ? THEN 'extraction_failed' ELSE status END,
              updated_at = ?
            WHERE id = ? AND status = 'pending_extraction'`,
      args: [maxAttempts, now.toISOString(), eventId],
    });
  }

  async recordLlmCall(call: LlmCallRecord): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO llm_calls (run_id, url, model, outcome, input_tokens, output_tokens, cost_usd, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        call.runId,
        call.url,
        call.model,
        call.outcome,
        call.inputTokens,
        call.outputTokens,
        call.costUsd,
        call.at.toISOString(),
      ],
    });
  }

  async llmSpendSince(since: Date): Promise<number> {
    const result = await this.client.execute({
      sql: `SELECT MAX(
              (SELECT COALESCE(SUM(cost_usd), 0) FROM llm_calls WHERE at >= ?),
              (SELECT COALESCE(SUM(cost_usd), 0) FROM runs WHERE started_at >= ?)
            ) AS total`,
      args: [since.toISOString(), since.toISOString()],
    });
    const row = result.rows[0];
    return row === undefined ? 0 : (numberOrNull(row, "total") ?? 0);
  }

  async noticeSent(key: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: `SELECT 1 FROM messages WHERE notice_key = ?`,
      args: [key],
    });
    return result.rows.length > 0;
  }

  async recordNotice(
    key: string,
    chatId: string,
    telegramMessageId: number,
    now: Date,
  ): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO messages (chat_id, kind, state, telegram_message_id, claimed_at, sent_at, notice_key)
            VALUES (?, 'notice', 'sent', ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [chatId, telegramMessageId, now.toISOString(), now.toISOString(), key],
    });
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
