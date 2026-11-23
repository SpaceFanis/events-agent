# Deploy (M6)

Two pieces share one Turso database: the daily scout (GitHub Actions, `.github/workflows/scout.yml`) and the button webhook (Cloudflare Worker, `wrangler.toml` → `worker/index.ts`). The scout migrates the schema; the Worker refuses to run against another version, so **run the scout once before the Worker gets its first press** after a schema change.

**After any merge that bumps `SCHEMA_VERSION`** (`src/db/schema.ts`): run the scout (`gh workflow run scout.yml`) and then `npm run worker:deploy` right after. Until both are done, button presses get a "schema mismatch" error and Telegram retries them later, so nothing is lost.

## 1. Secrets you need

| Name                      | Scout (Actions) | Worker | Where it comes from                                       |
| ------------------------- | --------------- | ------ | --------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | ✓               |        | console.anthropic.com                                     |
| `TELEGRAM_BOT_TOKEN`      | ✓               | ✓      | @BotFather                                                |
| `TELEGRAM_CHAT_ID`        | ✓               | ✓      | your chat with the bot                                    |
| `TELEGRAM_WEBHOOK_SECRET` |                 | ✓      | `openssl rand -hex 32` (16–256 chars of A-Z a-z 0-9 \_ -) |
| `TURSO_DATABASE_URL`      | ✓               | ✓      | `turso db show --url <db>`                                |
| `TURSO_AUTH_TOKEN`        | ✓               | ✓      | `turso db tokens create <db>`                             |
| `GOOGLE_CLIENT_ID`        | ✓               | ✓      | Google Cloud OAuth client (Desktop app)                   |
| `GOOGLE_CLIENT_SECRET`    | ✓               | ✓      | same                                                      |
| `GOOGLE_REFRESH_TOKEN`    | ✓               | ✓      | `npm run google:auth` (OAuth app in **production** mode)  |
| `CRITERIA_YAML`           | ✓               |        | the whole contents of your local `criteria.yaml`          |

Google is required in production: the scout stops and the Worker answers 500 if any of the three is missing.

## 2. GitHub Actions

Set each scout secret by name (gh prompts for the value). Use the remote Turso URL, not a local `file:` one: the scout refuses a local DB in Actions, because it would start empty every day.

```bash
for name in ANTHROPIC_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TURSO_DATABASE_URL TURSO_AUTH_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN; do gh secret set "$name"; done
```

```bash
gh secret set CRITERIA_YAML < criteria.yaml
```

The daily `schedule` trigger only runs from the **default branch**, so `scout.yml` must be merged there (check which branch that is with `gh repo view --json defaultBranchRef`). `gh workflow run` works from any branch with `--ref`. Trigger a first run by hand and read its summary:

```bash
gh workflow run scout.yml
```

```bash
gh run watch
```

The repository is public, so Actions logs are public: the run prints counts, cost and error text only (feed URLs are redacted, and a YAML error gives a line and column, not the text). The job fails, and GitHub emails you, when the run crashes or Telegram is unreachable; a broken source or calendar only shows up in the summary's errors. After editing `criteria.yaml`, upload it again with the `CRITERIA_YAML` command.

GitHub pauses scheduled workflows in public repositories after 60 days without commits; re-enable it from the Actions tab if that happens.

## 3. Cloudflare Worker

```bash
npx wrangler login
```

Set each Worker secret (wrangler prompts for the value, so it never lands in shell history):

```bash
for name in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TELEGRAM_WEBHOOK_SECRET TURSO_DATABASE_URL TURSO_AUTH_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REFRESH_TOKEN; do npx wrangler secret put "$name"; done
```

```bash
npm run worker:deploy
```

It prints the Worker URL (`https://events-agent-webhook.<account>.workers.dev`; the Worker keeps the project's first name so its URL stays stable).

## 4. Telegram webhook

```bash
npm run telegram:webhook -- --url https://events-agent-webhook.<account>.workers.dev/
```

Uses `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` from `.env` (the same secret the Worker has).

## 5. Smoke test

1. `gh workflow run scout.yml`, then check the run summary (sources, alerts, cost, errors).
2. Press a button on an alert: the buttons change and a toast appears. If nothing happens, `npx wrangler tail` shows the Worker's errors (`worker misconfigured: missing …` names a missing secret).
3. Press Going on a test event: an entry appears in Google Calendar.

## 6. First week

Review each daily run for a week (SPEC M6): run summaries (`gh run list --workflow scout.yml`), cost against the $1/month cap, false positives and misses in the alerts, and any "source broken" notices. Tune `criteria.yaml` and re-upload it.
