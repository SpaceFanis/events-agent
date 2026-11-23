/**
 * Turso (libSQL) schema, docs/SPEC.md "Data model". Idempotent: safe to run at the start of every run.
 * Times are UTC ISO strings; `events.timezone` holds the event's IANA zone.
 */
/** Bump on any schema change and add a migration; migrate() refuses unknown versions. */
export const SCHEMA_VERSION = 1;

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
    status TEXT NOT NULL,
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
    sent_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS messages_event ON messages (event_id, kind)`,
  // At most one alert per event, even if two runs overlap.
  `CREATE UNIQUE INDEX IF NOT EXISTS messages_one_alert ON messages (event_id) WHERE kind = 'alert'`,
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
];
