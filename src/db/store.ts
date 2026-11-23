import { createClient, type Client, type Row, type Value } from "@libsql/client";
import { z } from "zod";
import { eventTypeSchema } from "../event-type.js";
import type {
  AccessType,
  ActionableEvent,
  CalendarState,
  EventDetails,
  EventStatus,
  LocationTier,
  ScoutedEvent,
  StoredEvent,
} from "../types.js";
import { MIGRATIONS, SCHEMA, SCHEMA_VERSION, SET_SCHEMA_VERSION } from "./schema.js";

const locationTierSchema = z.enum([
  "online",
  "local",
  "country",
  "abroad",
] satisfies LocationTier[]);
const accessTypeSchema = z.enum(["open", "application", "invite"] satisfies AccessType[]);

export type MessageKind = "alert" | "reminder" | "nudge" | "notice";

/** A source adapter's failure streak after this run. */
export interface SourceHealth {
  consecutiveFailures: number;
  /** When the current streak started (null after a success); names the streak's single notice. */
  failingSince: string | null;
}

/**
 * Deadline reminders for `watching` events (3 days and 1 day before) and the one-off
 * "did you get results?" nudge for `awaiting_result` events.
 */
export type ReminderKind = "deadline_3d" | "deadline_1d" | "results";

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
  /** Updates the listing text of an already stored event that is still waiting for extraction. */
  refreshListingText(event: ScoutedEvent): Promise<void>;
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
  /** Records one fetch of a source (`error` null on success) and returns its failure streak. */
  recordSourceRun(name: string, error: string | null, now: Date): Promise<SourceHealth>;

  // Reminders and results nudges (same cron).
  /**
   * `watching` events whose deadline (or, without one, start) is still ahead, and `awaiting_result`
   * events whose results date has passed and that haven't ended.
   */
  eventsForReminders(now: Date): Promise<ActionableEvent[]>;
  /**
   * Claims one reminder before sending it (unique on event, kind and due time). Returns the row id,
   * or null if it was already claimed: sent, in flight in an overlapping run, or possibly delivered.
   */
  claimReminder(eventId: number, kind: ReminderKind, dueAt: string): Promise<number | null>;
  /** Marks a claimed reminder as sent and logs its Telegram message. */
  completeReminder(
    reminderId: number,
    eventId: number,
    kind: ReminderKind,
    chatId: string,
    telegramMessageId: number,
    sentAt: Date,
  ): Promise<void>;
  /** Drops an unsent claim so the next run retries it (Telegram was down). */
  releaseReminder(reminderId: number): Promise<void>;

  // Button presses (Worker webhook).
  /** Throws unless the database is at exactly this code's schema version. Never migrates. */
  checkSchema(): Promise<void>;
  getEvent(eventId: number): Promise<ActionableEvent | null>;
  /**
   * Moves the event from `from` to `to` and logs `action` in `actions`, only if it is still in `from`
   * (compare-and-set: a double press or a replayed update changes nothing). Returns whether it moved.
   */
  transitionStatus(
    eventId: number,
    from: string,
    to: EventStatus,
    action: string,
    now: Date,
  ): Promise<boolean>;
  /** Logs the optional "not interested" reason, only if none is stored yet. Returns whether it did. */
  recordDismissReason(eventId: number, reason: string, now: Date): Promise<boolean>;
  /** The reason of the latest `action` row with one, or null. */
  latestReason(eventId: number, action: string): Promise<string | null>;
  /** Records (or, with nulls, clears) the Google Calendar entry created for the event. */
  setCalendarEntry(
    eventId: number,
    calendarEventId: string | null,
    state: CalendarState | null,
    now: Date,
  ): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  saveSetting(key: string, value: string, now: Date): Promise<void>;
  close(): void;
}

const stringArray = z.array(z.string());
const calendarStateSchema = z.enum(["tentative", "confirmed"] satisfies CalendarState[]);

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

function listingTextOf(row: Row): { listingText?: string } {
  const value = textOrNull(row, "listing_text");
  return value === null ? {} : { listingText: value };
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
    ...listingTextOf(row),
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

function toActionableEvent(row: Row): ActionableEvent {
  return {
    ...toStoredEvent(row),
    calendarEventId: textOrNull(row, "calendar_event_id"),
    calendarState: calendarStateSchema.nullable().parse(textOrNull(row, "calendar_state")),
  };
}

function unversionedTables(tables: readonly string[]): string {
  return `database has tables but no schema version (${tables.join(", ")}); refusing to guess. If it is a new database left half-created by a failed first run, drop these tables and run the scout again`;
}

/** The database is at another schema version than this code (not a connection failure). */
export class SchemaMismatchError extends Error {
  override name = "SchemaMismatchError";
}

export class LibsqlStore implements Store {
  constructor(private readonly client: Client) {}

  /** User tables in the database (SQLite and Turso internals excluded). */
  private async tableNames(): Promise<string[]> {
    const tables = await this.client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%'",
    );
    return tables.rows.map((r) => text(r, "name"));
  }

  /** The version row in `schema_meta` (schema 5+), or null when the table is empty. */
  private async metaRowVersion(): Promise<number | null> {
    const row = (await this.client.execute("SELECT version FROM schema_meta WHERE id = 1")).rows[0];
    return row === undefined ? null : integer(row, "version");
  }

  private async metaVersion(): Promise<number> {
    const version = await this.metaRowVersion();
    if (version === null) throw new Error("schema_meta has no version row; refusing to guess");
    return version;
  }

  /**
   * The schema version: from `schema_meta`, or for databases made before version 5 (local SQLite
   * only; Turso never accepted the PRAGMA write) from `PRAGMA user_version`. 0 means empty.
   */
  private async schemaVersion(tables: readonly string[]): Promise<number> {
    if (tables.includes("schema_meta")) return this.metaVersion();
    if (tables.length === 0) return 0;
    let result;
    try {
      result = await this.client.execute("PRAGMA user_version");
    } catch (error) {
      // Turso may refuse the PRAGMA altogether; a Turso database never had a PRAGMA version.
      throw new Error(
        `${unversionedTables(tables)} (reading PRAGMA user_version failed: ${error instanceof Error ? error.message : String(error)})`,
        { cause: error },
      );
    }
    const row = result.rows[0];
    if (row === undefined) throw new Error("PRAGMA user_version returned no row");
    return integer(row, "user_version");
  }

  async migrate(): Promise<void> {
    const tables = await this.tableNames();
    const version = await this.schemaVersion(tables);
    if (version === 0) {
      if (tables.length > 0) throw new Error(unversionedTables(tables));
      await this.client.batch([...SCHEMA, SET_SCHEMA_VERSION], "write");
    } else if (version > 0 && version < SCHEMA_VERSION) {
      const steps: string[] = [];
      for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
        const migration = MIGRATIONS[next];
        if (migration === undefined)
          throw new Error(`no migration to schema version ${String(next)}`);
        steps.push(...migration);
      }
      // One write batch: the database is either fully migrated or untouched.
      await this.client.batch([...steps, SET_SCHEMA_VERSION], "write");
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
        unverified_fields, listing_text, status, first_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        event.listingText ?? null,
        status,
        at,
        at,
      ],
    });
    const row = result.rows[0];
    return row === undefined ? null : integer(row, "id");
  }

  async refreshListingText(event: ScoutedEvent): Promise<void> {
    if (event.listingText === undefined) return;
    // Only while it can still be used: an extracted event keeps the evidence it was judged on.
    await this.client.execute({
      sql: `UPDATE events SET listing_text = ?
       WHERE source = ? AND source_id = ? AND status = 'pending_extraction'
         AND listing_text IS NOT ?`,
      args: [event.listingText, event.source, event.sourceId, event.listingText],
    });
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

  async recordSourceRun(name: string, error: string | null, now: Date): Promise<SourceHealth> {
    const at = now.toISOString();
    // On conflict, bare column names are the stored row's values.
    const result = await this.client.execute(
      error === null
        ? {
            sql: `INSERT INTO source_health (name, consecutive_failures, failing_since, last_error, updated_at)
                  VALUES (?, 0, NULL, NULL, ?)
                  ON CONFLICT (name) DO UPDATE SET consecutive_failures = 0, failing_since = NULL,
                    last_error = NULL, updated_at = excluded.updated_at
                  RETURNING consecutive_failures, failing_since`,
            args: [name, at],
          }
        : {
            sql: `INSERT INTO source_health (name, consecutive_failures, failing_since, last_error, updated_at)
                  VALUES (?, 1, ?, ?, ?)
                  ON CONFLICT (name) DO UPDATE SET consecutive_failures = consecutive_failures + 1,
                    failing_since = COALESCE(failing_since, excluded.failing_since),
                    last_error = excluded.last_error, updated_at = excluded.updated_at
                  RETURNING consecutive_failures, failing_since`,
            args: [name, at, error, at],
          },
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("source_health upsert returned no row");
    return {
      consecutiveFailures: integer(row, "consecutive_failures"),
      failingSince: textOrNull(row, "failing_since"),
    };
  }

  async eventsForReminders(now: Date): Promise<ActionableEvent[]> {
    const at = now.toISOString();
    const result = await this.client.execute({
      sql: `SELECT * FROM events
            WHERE (status = 'watching' AND COALESCE(apply_deadline, starts_at) > ?)
               OR (status = 'awaiting_result' AND results_date IS NOT NULL AND results_date <= ?
                   AND (ends_at IS NULL OR ends_at >= ?))
            ORDER BY id`,
      args: [at, at, at],
    });
    return result.rows.map(toActionableEvent);
  }

  async claimReminder(eventId: number, kind: ReminderKind, dueAt: string): Promise<number | null> {
    const result = await this.client.execute({
      sql: `INSERT INTO reminders (event_id, due_at, kind) VALUES (?, ?, ?)
            ON CONFLICT DO NOTHING RETURNING id`,
      args: [eventId, dueAt, kind],
    });
    const row = result.rows[0];
    return row === undefined ? null : integer(row, "id");
  }

  async completeReminder(
    reminderId: number,
    eventId: number,
    kind: ReminderKind,
    chatId: string,
    telegramMessageId: number,
    sentAt: Date,
  ): Promise<void> {
    const at = sentAt.toISOString();
    await this.client.batch(
      [
        { sql: `UPDATE reminders SET sent_at = ? WHERE id = ?`, args: [at, reminderId] },
        {
          sql: `INSERT INTO messages (event_id, telegram_message_id, chat_id, kind, state, claimed_at, sent_at)
                VALUES (?, ?, ?, ?, 'sent', ?, ?)`,
          args: [
            eventId,
            telegramMessageId,
            chatId,
            kind === "results" ? "nudge" : "reminder",
            at,
            at,
          ],
        },
      ],
      "write",
    );
  }

  async releaseReminder(reminderId: number): Promise<void> {
    await this.client.execute({
      sql: `DELETE FROM reminders WHERE id = ? AND sent_at IS NULL`,
      args: [reminderId],
    });
  }

  async checkSchema(): Promise<void> {
    // Read-only, and only the table the cron writes: the Worker never touches the PRAGMA.
    const meta = await this.client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
    );
    const version = meta.rows.length === 0 ? null : await this.metaRowVersion();
    if (version !== SCHEMA_VERSION) {
      throw new SchemaMismatchError(
        `database schema is ${version === null ? "unversioned" : `version ${String(version)}`}, code expects ${String(SCHEMA_VERSION)}; run a scout to migrate`,
      );
    }
  }

  async getEvent(eventId: number): Promise<ActionableEvent | null> {
    const result = await this.client.execute({
      sql: `SELECT * FROM events WHERE id = ?`,
      args: [eventId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toActionableEvent(row);
  }

  async transitionStatus(
    eventId: number,
    from: string,
    to: EventStatus,
    action: string,
    now: Date,
  ): Promise<boolean> {
    const at = now.toISOString();
    // One write transaction: the audit row is written only if this press changed the status.
    const [update] = await this.client.batch(
      [
        {
          sql: `UPDATE events SET status = ?, updated_at = ? WHERE id = ? AND status = ?`,
          args: [to, at, eventId, from],
        },
        {
          sql: `INSERT INTO actions (event_id, action, reason, at) SELECT ?, ?, NULL, ? WHERE changes() = 1`,
          args: [eventId, action, at],
        },
      ],
      "write",
    );
    return update !== undefined && update.rowsAffected === 1;
  }

  async recordDismissReason(eventId: number, reason: string, now: Date): Promise<boolean> {
    // One statement, so a double tap or a redelivered update can't log two reasons.
    const result = await this.client.execute({
      sql: `INSERT INTO actions (event_id, action, reason, at)
            SELECT ?, 'dismiss_reason', ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM actions WHERE event_id = ? AND action = 'dismiss_reason')`,
      args: [eventId, reason, now.toISOString(), eventId],
    });
    return result.rowsAffected === 1;
  }

  async latestReason(eventId: number, action: string): Promise<string | null> {
    const result = await this.client.execute({
      sql: `SELECT reason FROM actions WHERE event_id = ? AND action = ? AND reason IS NOT NULL
            ORDER BY id DESC LIMIT 1`,
      args: [eventId, action],
    });
    const row = result.rows[0];
    return row === undefined ? null : textOrNull(row, "reason");
  }

  async setCalendarEntry(
    eventId: number,
    calendarEventId: string | null,
    state: CalendarState | null,
    now: Date,
  ): Promise<void> {
    await this.client.execute({
      sql: `UPDATE events SET calendar_event_id = ?, calendar_state = ?, updated_at = ? WHERE id = ?`,
      args: [calendarEventId, state, now.toISOString(), eventId],
    });
  }

  async getSetting(key: string): Promise<string | null> {
    const result = await this.client.execute({
      sql: `SELECT value FROM settings WHERE key = ?`,
      args: [key],
    });
    const row = result.rows[0];
    return row === undefined ? null : text(row, "value");
  }

  async saveSetting(key: string, value: string, now: Date): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [key, value, now.toISOString()],
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
