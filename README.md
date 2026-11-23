# Hackscout

A personal scout that checks hackathon and event platforms every day, keeps only what matches your criteria, works out the real dates, deadlines and how to apply, checks your Google Calendar for clashes, and sends you a Telegram message with buttons.

It is built to be **cheap** (target: under $1/month) and **accurate**: every date and link it shows is backed by a quote from the event page, and anything it can't verify is marked "⚠️ unverified" instead of guessed.

## How it works

```
GitHub Actions (daily)                          Cloudflare Worker
  fetch sources ─► rule filter ─► Claude ─►        Telegram button press
  calendar check ─► Telegram alert                 ─► update status, add to calendar
                 └──────── Turso (shared SQLite) ─────────┘
```

1. **Fetch** from Devpost, MLH, Luma calendars and any RSS/Atom or ICS feed you list.
2. **Free rule filter** (keywords, event type, date window, deadline, location) drops most items before any money is spent.
3. **Claude Haiku** reads each surviving event page once, extracts the dates, access type (open / application), deadline, results date, cost, travel support and eligibility, each with a quote from the page as evidence, and scores how worth it the event is for your profile. Code checks every quote and date; unclear critical fields escalate once to Claude Sonnet.
4. **Score thresholds** depend on location: online, local, same country, abroad (abroad must be really worth it).
5. **Google Calendar** is checked for conflicts over the event's span.
6. **Telegram alert** with buttons: Going, I applied, Remind me, Not interested. Later presses move the event through Accepted / Rejected, add it to your calendar, and send deadline reminders and "did you get results?" nudges.

## Commands

| Command                                          | What it does                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `npm run scout -- --criteria criteria.yaml`      | One live scouting run (uses `.env`)                                  |
| `npm run replay`                                 | The whole pipeline offline on recorded fixtures: no network, no cost |
| `npm run check`                                  | Typecheck, lint, unit tests, build and a Worker bundle check         |
| `npm run e2e`                                    | End-to-end tests in replay mode                                      |
| `npm run google:auth`                            | Get a Google Calendar refresh token                                  |
| `npm run worker:deploy`                          | Deploy the Telegram button webhook to Cloudflare                     |
| `npm run telegram:webhook -- --url <worker url>` | Point the Telegram bot at the Worker                                 |

## Setup

Requires Node 26.

```bash
npm ci
```

```bash
cp criteria.example.yaml criteria.yaml
```

```bash
cp .env.example .env
```

Edit `criteria.yaml` (your profile, interests, keywords, home city, score thresholds, sources, budget caps) and fill in `.env`. Both are git-ignored. Try it offline first with `npm run replay`.

Production runs on GitHub Actions (daily) and a Cloudflare Worker (buttons). The full checklist is in [docs/DEPLOY.md](docs/DEPLOY.md).

## Cost guard

`criteria.yaml` `limits` caps LLM calls per run and spend per month (default $1). Every call is logged with its tokens and cost, checked against its worst case before it is made, and each run's cost is shown in the Actions summary. Each event page is extracted once and cached.

## Stack

TypeScript (Node 26 and Cloudflare Workers) · Claude Haiku / Sonnet with structured outputs · Turso (libSQL) · Telegram Bot API · Google Calendar API · GitHub Actions · Vitest

## Docs

- [docs/SPEC.md](docs/SPEC.md): full specification, failure handling and milestones
- [docs/DEPLOY.md](docs/DEPLOY.md): deploy runbook
