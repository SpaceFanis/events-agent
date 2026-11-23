/**
 * Turso (libSQL) schema, docs/SPEC.md "Data model". Idempotent: safe to run at the start of every run.
 * Times are UTC ISO strings; `events.timezone` holds the event's IANA zone.
 */
/** Bump on any schema change and add a migration; migrate() refuses unknown versions. */
export const SCHEMA_VERSION = 5;

/**
 * The schema version, one row. Turso's server refuses `PRAGMA user_version = N`, so since
 * version 5 the version lives here; versions 1–4 (local databases only) are read from the PRAGMA.
 */
const SCHEMA_META = `CREATE TABLE IF NOT EXISTS schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
)`;

/** Records SCHEMA_VERSION; runs in the same write batch as the schema change it describes. */
export const SET_SCHEMA_VERSION = `INSERT INTO schema_meta (id, version) VALUES (1, ${String(SCHEMA_VERSION)})
  ON CONFLICT (id) DO UPDATE SET version = excluded.version`;

/**
 * Consecutive failed fetches per source adapter (by its configured name). Reset by a success;
 * `failing_since` names the current streak, so each streak sends at most one "source broken" notice.
 */
const SOURCE_HEALTH = `CREATE TABLE IF NOT EXISTS source_health (
    name TEXT PRIMARY KEY,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failing_since TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  )`;

/** Small key/value settings the cron publishes for the Worker (it has no criteria.yaml). */
const SETTINGS = `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
const ACTIONS_INDEX = `CREATE INDEX IF NOT EXISTS actions_event ON actions (event_id, action)`;

/** Cost log: one row per LLM call, paid or failed. The monthly budget cap sums this table. */
const LLM_CALLS = `CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER REFERENCES runs (id),
    url TEXT NOT NULL,
    model TEXT NOT NULL,
    outcome TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    at TEXT NOT NULL
  )`;
const LLM_CALLS_INDEX = `CREATE INDEX IF NOT EXISTS llm_calls_at ON llm_calls (at)`;

export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    canonical_url TEXT NOT NULL UNIQUE,
    -- NULL when the start date is unknown: title + organiser alone is too weak to dedupe on.
    dedupe_hash TEXT UNIQUE,
    title TEXT NOT NULL,
    organiser TEXT,
    type TEXT NOT NULL,
    starts_at TEXT,
    ends_at TEXT,
    timezone TEXT NOT NULL,
    location_text TEXT,
    country TEXT,
    city TEXT,
    is_online INTEGER NOT NULL,
    location_tier TEXT NOT NULL,
    access_type TEXT,
    register_url TEXT,
    register_steps TEXT,
    apply_deadline TEXT,
    results_date TEXT,
    cost TEXT,
    travel_support TEXT,
    prizes TEXT,
    eligibility TEXT,
    score REAL,
    score_reason TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    unverified_fields TEXT NOT NULL DEFAULT '[]',
    alert_attempts INTEGER NOT NULL DEFAULT 0,
    -- LLM calls on this page that returned nothing usable (refusal, cut off, bad JSON).
    extract_attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    -- Google Calendar entry created by a button press (going / accepted / tentative hold).
    calendar_event_id TEXT,
    calendar_state TEXT CHECK (calendar_state IN ('tentative', 'confirmed')),
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (source, source_id)
  )`,
  `CREATE INDEX IF NOT EXISTS events_status ON events (status)`,
  `CREATE TABLE IF NOT EXISTS extractions (
    url TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER REFERENCES events (id),
    -- NULL until Telegram confirms the send.
    telegram_message_id INTEGER,
    chat_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('alert', 'reminder', 'nudge', 'notice')),
    -- claimed: about to send; sent: confirmed; unknown: may have been delivered (timeout), not resent.
    state TEXT NOT NULL DEFAULT 'sent' CHECK (state IN ('claimed', 'sent', 'unknown')),
    claimed_at TEXT,
    sent_at TEXT,
    -- Notices only: one message per key (e.g. budget:2026-11), so a cap notice is not repeated.
    notice_key TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS messages_event ON messages (event_id, kind)`,
  // At most one alert per event, even if two runs overlap.
  `CREATE UNIQUE INDEX IF NOT EXISTS messages_one_alert ON messages (event_id) WHERE kind = 'alert'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS messages_notice_key ON messages (notice_key) WHERE notice_key IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events (id),
    action TEXT NOT NULL,
    reason TEXT,
    at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events (id),
    due_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    sent_at TEXT,
    UNIQUE (event_id, kind, due_at)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    items_fetched INTEGER NOT NULL DEFAULT 0,
    items_new INTEGER NOT NULL DEFAULT 0,
    items_llm INTEGER NOT NULL DEFAULT 0,
    alerts_sent INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    errors TEXT NOT NULL DEFAULT '[]'
  )`,
  LLM_CALLS,
  LLM_CALLS_INDEX,
  ACTIONS_INDEX,
  SETTINGS,
  SOURCE_HEALTH,
  SCHEMA_META,
];

/** Statements that bring a database from version N-1 up to N, keyed by N. */
export const MIGRATIONS: Readonly<Record<number, readonly string[]>> = {
  2: [
    `ALTER TABLE events ADD COLUMN register_steps TEXT`,
    `ALTER TABLE events ADD COLUMN extract_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE messages ADD COLUMN notice_key TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS messages_notice_key ON messages (notice_key) WHERE notice_key IS NOT NULL`,
    LLM_CALLS,
    LLM_CALLS_INDEX,
    // M1 stored rule survivors as `new` without extraction; never alert those unextracted.
    `UPDATE events SET status = 'pending_extraction'
      WHERE status = 'new' AND id NOT IN (SELECT event_id FROM messages WHERE kind = 'alert' AND event_id IS NOT NULL)`,
  ],
  3: [
    `ALTER TABLE events ADD COLUMN calendar_event_id TEXT`,
    `ALTER TABLE events ADD COLUMN calendar_state TEXT CHECK (calendar_state IN ('tentative', 'confirmed'))`,
    ACTIONS_INDEX,
    SETTINGS,
  ],
  4: [SOURCE_HEALTH],
  5: [SCHEMA_META],
};
