# Events Agent — Spec

## Goal

A personal agent that scouts curated platforms daily for events, conferences, competitions, hackathons and opportunities. It keeps only those that match my YAML criteria. For each match it works out when it is, whether it is open or needs an application, how to register or apply, the deadlines, and whether my Google Calendar already has something at that time. Then it sends me an interactive Telegram alert. It must be **as cheap as possible** (target: under $1/month all-in) and **accurate**: no hallucinated dates or links.

## Users

One user (me). Production, solo, long-running. No web UI: Telegram is the whole interface.

## Core flow

1. **Daily cron (GitHub Actions)** runs the scout pipeline:
   1. **Fetch** from each source adapter (curated platforms) → raw items.
   2. **Normalize + dedupe** by canonical URL and a hash of title, date and organiser. Skip anything already in the DB.
   3. **Rule pre-filter (free):** keywords include/exclude, event type, date window, deadline not passed, location tier. Most items die here.
   4. **LLM extraction (Claude Haiku 5.5, once per new survivor, cached by URL):** fetch the event page, then extract structured fields with a JSON schema: dates, timezone, location, online/in-person, access type (`open` / `application` / `invite`), registration link, application deadline, results date, cost, eligibility, travel support, prizes. Each field carries `evidence` (a quote from the page) and `confidence`.
   5. **Worth score:** Haiku scores 0–10 against the profile in `criteria.yaml`, in the same call as the extraction (the page is paid for once). The minimum depends on the location tier: online ≥ 6, local ≥ 5, own country ≥ 7, abroad ≥ 9 (abroad needs to be "really really worth it"; travel funding counts in its favour).
   6. **Validation (code, not LLM):** every evidence quote must appear on the page as whole words; dates must parse, the quote must name the same day and month (and year, if it names one), and start ≤ end; the event must not have ended and its registration/application deadline must not have passed; the link must be linked from the page or on the page's own host; access, deadline and results date are required for application events. A field that fails keeps the listing's value (or none) and is flagged. Low confidence, a failed quote or an invalid value on a critical field (dates, access, application deadline/results date, score, and attendance when believing it would change the location tier) escalates once to Sonnet 5.5, whose answer is used only if it is at least as well supported. Escalation is only paid for events that could be alerted: Haiku's score must be at most 1 below the minimum of the event's tier (or of the tier the model's unverified location answer implies, if lower); an invalid score always escalates. Low scorers keep Haiku's answer with weak fields flagged. (First live trial, 2026-11-23: 19 of 41 events escalated, mostly scoring 0–3; Sonnet was 86% of the $0.50 run.) If it is still unclear, the alert is sent with "⚠️ unverified: <field>" rather than guessed. Status after extraction: `new` (alerted), `below_threshold`, `closed`, or `extraction_failed`.
   7. **Calendar check:** Google Calendar `freeBusy` for the event's time range (and multi-day spans). Lists conflicting event titles.
   8. **Telegram alert**, one message per match (format below), with buttons that depend on the event's status.
2. **Button presses → Cloudflare Worker webhook**: updates the event status in Turso, edits the message to show the next buttons, and writes to Google Calendar when needed.
3. **Daily reminders** (same cron): deadline reminders (3 days and 1 day before), and a "did you get results?" nudge once the results date passes for events in `awaiting_result`.

### Alert content

Title · type · organiser · when (local time + timezone) · where / online · **access**: Open / Application required (deadline, results date) · how to register / apply (link + steps) · cost / travel support / prizes · eligibility · calendar: free, or conflicts with "<event>" · why it matched (score + one line) · source link · ⚠️ unverified fields.

### Event status machine

```
new ──Going──────────────► going ──(calendar event created)
 │  ──Not interested─────► dismissed (reason optional)
 │  ──Remind me──────────► watching ──(deadline reminders; same buttons)
 └─ (application) I applied ► awaiting_result ──Accepted──► accepted (calendar event created)
                                             └─Rejected──► rejected
```

Open events show [Going] [Remind me] [Not interested]. Application events show [I applied] [Remind me] [Not interested]. Once an event is in `awaiting_result` the buttons become [Accepted] [Rejected]. An optional config flag (`calendar.tentativeHoldOnApply`, default off) adds a tentative "Applied: …" calendar hold.

## In scope (v1)

- Source adapters: **Devpost** (JSON API), **MLH** (season page), **Luma** (ICS or calendar pages per configured calendar/city), generic **RSS/ICS** adapter for any feed listed in config. The adapter interface makes adding a source a single file.
- `criteria.yaml`: profile text, interests, include/exclude keywords, event types, home city and country, location tiers (online, local, country, abroad) with minimum scores, calendar options, date window, eligibility facts (student, age, nationality), sources list.
- Turso (libSQL/SQLite) state: events, statuses, LLM extraction cache, sent messages, feedback.
- Telegram bot with inline buttons; Cloudflare Worker webhook.
- Google Calendar: freeBusy read, event insert for going / accepted.
- Deadline reminders and results nudges.
- Replay mode: run the whole pipeline offline against recorded fixtures with fake Telegram, Calendar and LLM.
- Cost log: tokens and $ per run, written to the DB and printed in the Actions summary.

## Out of scope (v1)

- Open web search, email newsletter ingestion, arbitrary "specific sites" scraping (possible v2 sources).
- Eventbrite and Meetup: their public search APIs are restricted. Revisit in v2.
- Web dashboard, multiple users, editing criteria via Telegram.
- Auto-applying or auto-registering for events.
- Learning from feedback automatically (v1 only stores "not interested" reasons; I tune the YAML myself).

## Architecture decisions

- **TypeScript everywhere (Node 26 + Cloudflare Worker):** one language, shared types between the pipeline and the webhook.
- **GitHub Actions cron for scouting:** free, no server. A headless browser is available later if a source needs it.
- **Cloudflare Worker for button webhooks:** free tier, always on, instant response. GitHub Actions can't receive webhooks.
- **Turso (libSQL) as the shared DB:** free tier, reachable from both Actions and the Worker over HTTP; SQLite semantics.
- **Rules first, LLM second:** free filters remove most items before any token is spent.
- **Claude Haiku 5.5 with structured outputs (`output_config.format` JSON schema), escalating to Sonnet 5.5 only on low confidence:** about $0.10/$0.50 per million tokens. Extraction runs once per URL and is cached forever.
- **Evidence-required extraction + code validation:** accuracy comes from refusing to guess, not from bigger models.
- **Telegram Bot API via plain fetch:** no SDK needed for sendMessage, editMessageReplyMarkup and setWebhook.
- **Google Calendar via REST + stored OAuth refresh token:** freeBusy plus events.insert. Scope is `calendar.events` + `calendar.freebusy`, the smallest that works.
- **No Playwright browser tests:** there is no UI. "E2E" is the full pipeline in replay mode (Vitest) plus a Worker webhook test.

## Data model (Turso)

Schema version is kept in `PRAGMA user_version` (currently 2). Older known versions are migrated in one write batch; the code refuses to run against an unknown version, or against an unversioned database that already has tables. Migration 2 moves M1 events that were stored as `new` but never alerted back to `pending_extraction`.

- `events`: id, source, source_id, canonical_url, dedupe_hash, title, organiser, type, starts_at, ends_at, timezone, location_text, country, city, is_online, location_tier, access_type, register_url, register_steps, apply_deadline, results_date, cost, travel_support, prizes, eligibility, score, score_reason, tags (json), unverified_fields (json), alert_attempts, extract_attempts, status (pending_extraction / new / below_threshold / closed / extraction_failed, then the status machine), first_seen_at, updated_at. A date-only deadline is stored at 23:59:59 local time and shown as a date. Unique on canonical_url, dedupe_hash and (source, source_id); dedupe_hash is NULL when the start date is unknown.
- `extractions`: url (pk), content_hash, model, raw_json, input_tokens, output_tokens, cost_usd, created_at
- `messages`: event_id, telegram_message_id, chat_id, kind (alert/reminder/nudge/notice), state (claimed/sent/unknown), claimed_at, sent_at, notice_key (unique; one notice per key, e.g. `budget:2026-12`). At most one alert row per event: it is inserted as `claimed` before sending and becomes `sent` with its Telegram id afterwards, so overlapping runs or a failed DB write never send twice. A failed send deletes the claim (see Failure handling).
- `actions`: event_id, action, reason, at (feedback and audit log)
- `reminders`: event_id, due_at, kind, sent_at
- `runs`: id, started_at, finished_at, items_fetched, items_new, items_llm, alerts_sent, cost_usd, errors (json)
- `llm_calls` (cost log): run_id, url, model, outcome (ok/refusal/max_tokens/invalid/error), input_tokens, output_tokens, cost_usd, at. One row per call, paid or not; the monthly cap sums it.

## External services

| Service              | Use                  | Access                       | Cost                |
| -------------------- | -------------------- | ---------------------------- | ------------------- |
| Anthropic API        | extraction + scoring | API key (GitHub secret)      | ~$0.50/mo est.      |
| Telegram Bot API     | alerts + buttons     | bot token, chat id           | free                |
| Google Calendar API  | freeBusy + insert    | OAuth client + refresh token | free                |
| Turso                | shared SQLite DB     | DB URL + auth token          | free tier           |
| Cloudflare Workers   | button webhook       | wrangler + API token         | free tier           |
| GitHub Actions       | daily cron           | repo secrets                 | free (≈1–3 min/day) |
| Devpost / MLH / Luma | sources              | public endpoints/pages       | free                |

## Failure handling

- **Source down or changed HTML:** that adapter fails alone. The run continues and the error goes into `runs.errors`. After 3 consecutive failures of one adapter, Telegram gets a single "source broken" message.
- **LLM error, timeout or refusal:** SDK retries, then the item stays `pending_extraction` and is retried next run. Never alert from unextracted data. An outage (5xx, 429, auth, network) stops LLM work for the run without using attempts. A refusal, cut-off or invalid answer counts one `extract_attempts`; after 3 the event is `extraction_failed`. A 400 counts only if another call in the same run worked; two 400s in a row are treated as a setup error (stop, nothing counted). Events whose page or call failed without counting move to the back of the queue (ordered by updated_at), so they can't block newer events.
- **Event page gone or down:** a 404/410 counts one extraction attempt; other fetch errors are retried next run. Pages over 60k characters of text are cut and the run notes it.
- **Bad or ambiguous page data:** mark the fields unverified instead of guessing. Dates without a timezone use the event location's zone and are flagged.
- **Calendar API down:** send the alert with "calendar: couldn't check".
- **Telegram down or misconfigured** (network, 5xx, 401/403, long 429, or any 400 that is not a known content error, e.g. chat not found, not enough rights, chat upgraded to supergroup): the run stops sending and every unsent alert is retried next run, with no attempt used up. Only a known content error (can't parse entities, message too long, empty text) or an event that can't be formatted counts as one attempt for that event; after 3 the event is not alerted. Events that have ended, or whose registration/application deadline has passed, are never alerted late. A timeout or an unreadable 2xx response may mean the message was delivered, so that alert is kept as `unknown` and not resent. Unknown alerts, and `claimed` alerts older than 10 minutes (crash or failed write), are reported in `runs.errors` each run until fixed by hand. Sends are paced at ~1/s, 429 back-offs up to 30 s are waited out, and `limits.maxAlertsPerRun` (default 20) caps alerts per run, with the rest waiting for the next run.
- **Webhook replay or double press:** status transitions are validated and calendar inserts are idempotent (event id stored).
- **Cost guard:** hard cap on LLM calls per run (config, default 60) and a monthly $ cap (default $1), checked before each call against its worst case (1 token per character of prompt + max output). Monthly spend is the larger of the `llm_calls` sum and the `runs.cost_usd` sum, so a failed cost-log write can't hide spend. If a Haiku call doesn't fit, LLM work stops and I get a Telegram notice (budget: once per month; call cap: once per run). Haiku's answer is cached as soon as it is paid for. If the Sonnet escalation hits the call cap or an outage, the event stays pending and escalates from the cached answer next run; if it doesn't fit the budget, it is skipped and Haiku's answer is used with its weak fields flagged.

## Risks

- Platform page or API changes break adapters → fixture tests per adapter, broken-source alert.
- Luma has no official public search → per-calendar ICS feeds configured manually.
- Google OAuth refresh tokens expire after 7 days while the app is in "Testing" mode → publish the OAuth app in production mode (personal use, unverified is fine).
- "Worth it" scoring is subjective → the score reason is shown in each alert, and thresholds live in YAML.

## Milestones

1. **M1 Pipeline skeleton (done 2026-11-23):** config loader, Devpost adapter, dedupe, rule filter, Turso schema, replay mode, Telegram send-only alert. Until M2, every rule survivor is alerted (no score threshold yet), Devpost's date-only submission period is read in the home zone (UTC when abroad) and flagged "unverified: time", and access is flagged unverified.
2. **M2 Accurate extraction (done 2026-11-23):** page fetch, Haiku structured extraction with evidence plus worth score, code validation, Sonnet escalation, `llm_calls` cost log + caps, score thresholds per location tier. Replay mode uses recorded pages and LLM responses (`llm.json`). Known gap until M6: two overlapping runs can both pay for the same page (alerts are still sent once); the M6 Actions concurrency group prevents overlaps.
3. **M3 Calendar:** freeBusy conflicts in alerts.
4. **M4 Interactive:** Cloudflare Worker webhook, status machine, calendar insert on going / accepted.
5. **M5 Reminders + more sources:** deadline reminders, results nudges, MLH, Luma and RSS/ICS adapters, broken-source alerts.
6. **M6 Production:** GitHub Actions daily cron, secrets, Worker deploy, a week of real runs reviewed.

## End-to-end acceptance test

Replay mode (offline, deterministic), run by `npm run e2e`:

1. Seed `criteria.yaml` fixture: interests "AI, robotics", home Athens, Greece; abroad minimum 9.
2. Fixtures for Devpost return 4 hackathons: (a) an online AI hackathon with open registration; (b) an in-person robotics competition in Athens that requires an application with a deadline and results date; (c) an unrelated crypto event; (d) a mediocre AI meetup in Berlin, score 6.
3. The fake LLM returns recorded extractions. The fake calendar has a busy block overlapping (b).
4. Run the pipeline → assert exactly 2 Telegram messages are sent: (a) shows "Open", the register link, "calendar: free" and the Going / Remind / Not-interested buttons; (b) shows "Application required", the deadline, the results date, "conflicts with <busy event>" and the I-applied buttons. (c) is filtered by rules and (d) by the abroad threshold; neither hits Telegram.
5. Run again → 0 new messages (dedupe).
6. Simulate the webhook callback "I applied" on (b) → status `awaiting_result`, message buttons become Accepted / Rejected.
7. Simulate "Accepted" → status `accepted`, the fake calendar receives exactly one insert with the right start/end. Pressing it again → no second insert.
8. Advance the clock to 3 days before (a)'s deadline after "Remind me" → one reminder message.
