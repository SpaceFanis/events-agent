import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { escapeHtml, formatAlert } from "./alert.js";
import { keyboardFor } from "./buttons.js";
import {
  checkCalendar,
  FakeCalendar,
  GoogleCalendar,
  recordedCalendar,
  type BusyEvent,
  type CalendarClient,
  type CalendarStatus,
} from "./calendar.js";
import { loadCriteria, type Criteria } from "./config.js";
import { openStore, type Store } from "./db/store.js";
import { enrichPending } from "./enrich.js";
import { applyRules } from "./filter.js";
import { FetchHttp, ReplayHttp, type Http } from "./http.js";
import { AnthropicLlm, ReplayLlm, type LlmClient } from "./llm.js";
import { normalizeItem } from "./normalize.js";
import { sendNoticeOnce } from "./notices.js";
import { recheckThresholds } from "./recheck.js";
import { sendReminders } from "./reminders.js";
import { SETTING_TENTATIVE_HOLD } from "./settings.js";
import { buildSources } from "./sources/index.js";
import type { Source } from "./sources/types.js";
import { FakeMessenger, TelegramError, TelegramMessenger, type Messenger } from "./telegram.js";
import type { ScoutedEvent } from "./types.js";

export interface RunSummary {
  mode: "live" | "replay";
  sources: number;
  itemsFetched: number;
  itemsFiltered: number;
  itemsNew: number;
  llmCalls: number;
  alertsSent: number;
  /** Deadline reminders and results nudges. */
  remindersSent: number;
  costUsd: number;
  errors: string[];
  /**
   * A systemic failure (Telegram unreachable, or the run row could not be written): the CLI exits
   * non-zero so the scheduled run fails and GitHub emails me. Source or calendar errors don't count.
   */
  failed: boolean;
}

export interface PipelineDeps {
  criteria: Criteria;
  sources: Source[];
  store: Store;
  /** Event pages for extraction (sources hold their own Http). */
  http: Http;
  llm: LlmClient;
  messenger: Messenger;
  calendar: CalendarClient;
  now: () => Date;
  mode: RunSummary["mode"];
}

/** A `claimed` alert older than this is stuck, not just being sent by an overlapping run. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** Failed sends per event before we stop retrying (e.g. a message Telegram always rejects). */
export const MAX_ALERT_ATTEMPTS = 3;

/** Consecutive failed runs of one source before Telegram gets a "source broken" notice. */
export const SOURCE_BROKEN_AFTER = 3;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One scouting pass: fetch → normalize → rule filter → dedupe/store → page extraction + score →
 * calendar check → alert.
 */
export async function runPipeline(deps: PipelineDeps): Promise<RunSummary> {
  const { criteria, store, messenger } = deps;
  const startedAt = deps.now();
  const runId = await store.startRun(startedAt);
  const errors: string[] = [];
  let itemsFetched = 0;
  let itemsFiltered = 0;
  let itemsNew = 0;
  let alertsSent = 0;
  let remindersSent = 0;
  let failed = false;
  // Filled in by the extraction stage as it goes, so failed runs still record their spend.
  const llm = { llmCalls: 0, costUsd: 0, extracted: 0 };

  // Each adapter fails alone; the run continues with the others.
  const survivors: ScoutedEvent[] = [];
  const fetchErrors = new Map<string, string | null>();
  for (const source of deps.sources) {
    try {
      const result = await source.fetch();
      fetchErrors.set(source.name, null);
      errors.push(...result.warnings);
      itemsFetched += result.items.length;
      for (const item of result.items) {
        const event = normalizeItem(item, criteria);
        if (applyRules(event, criteria, startedAt).keep) survivors.push(event);
        else itemsFiltered++;
      }
    } catch (error) {
      fetchErrors.set(source.name, message(error));
      errors.push(`${source.name}: ${message(error)}`);
    }
  }

  try {
    // Published every run, so the Worker follows the latest criteria.yaml.
    await store.saveSetting(
      SETTING_TENTATIVE_HOLD,
      String(criteria.calendar.tentativeHoldOnApply),
      startedAt,
    );

    for (const [name, error] of fetchErrors) {
      const health = await store.recordSourceRun(name, error, startedAt);
      if (error !== null && health.consecutiveFailures >= SOURCE_BROKEN_AFTER) {
        // One notice per failure streak: a source that recovers and breaks again is reported again.
        await sendNoticeOnce(
          deps,
          `source-broken:${name}:${health.failingSince ?? startedAt.toISOString()}`,
          // Sent in HTML mode: the error text may contain markup characters.
          escapeHtml(
            `⚠️ Hackscout: source "${name}" has failed ${String(health.consecutiveFailures)} runs in a row. Each run still tries it. Last error: ${error.slice(0, 500)}`,
          ),
          errors,
        );
      }
    }

    for (const event of survivors) {
      if ((await store.insertIfNew(event, "pending_extraction", startedAt)) !== null) itemsNew++;
      // Events stored before their source gave listing text (or whose listing changed) get it now.
      else await store.refreshListingText(event);
    }

    // Never alert from unextracted data: only events extraction moved to `new` reach the alert step.
    await enrichPending(deps, runId, errors, llm);

    // Thresholds may have been lowered since these events were scored (free: scores are stored).
    const promoted = await recheckThresholds(store, criteria, startedAt);
    if (promoted > 0) {
      errors.push(
        `${String(promoted)} earlier-scored events now meet the minScore thresholds: moved to new (alerts are capped at maxAlertsPerRun per run)`,
      );
    }

    // Alert claims from earlier runs that were never confirmed (crash, timeout, failed write) need a
    // human look. Checked before this run claims anything; recent `claimed` rows may belong to an
    // overlapping run that is still sending, so only stale ones count.
    for (const stuck of await store.unconfirmedAlerts(
      new Date(startedAt.getTime() - STALE_CLAIM_MS),
    )) {
      errors.push(
        `alert for event ${String(stuck.eventId)} is ${stuck.state} since ${stuck.claimedAt}: check Telegram, then delete its messages row to resend or set state='sent'`,
      );
    }

    // Includes events whose alert failed on an earlier run (Telegram outage) until they end, or until
    // Telegram rejected that message MAX_ALERT_ATTEMPTS times. Capped per run so a backlog never floods the chat.
    const awaiting = await store.eventsAwaitingAlert(
      startedAt,
      MAX_ALERT_ATTEMPTS,
      criteria.limits.maxAlertsPerRun,
    );
    // After the first failed calendar check the rest of the run skips it: an outage or bad token
    // would fail every call, and the alert goes out with "couldn't check" instead of waiting.
    let calendarDown = false;
    // A Telegram outage during alerts skips the reminders too; both are retried next run.
    let telegramDown = false;
    for (const event of awaiting) {
      const claim = await store.claimAlert(event.id, messenger.chatId, deps.now());
      if (claim === null) continue; // another run got it first
      let calendar: CalendarStatus = { kind: "unknown", reason: "calendar unavailable" };
      if (!calendarDown) {
        try {
          calendar = await checkCalendar(deps.calendar, event);
        } catch (error) {
          calendarDown = true;
          errors.push(`calendar: ${message(error)}`);
        }
      }
      let html;
      try {
        html = formatAlert(event, calendar);
      } catch (error) {
        // This event's data is bad (e.g. an invalid time zone): count it against the event, don't block the rest.
        errors.push(`alert for event ${String(event.id)}: cannot format: ${message(error)}`);
        await store.releaseAlert(claim, event.id, true);
        continue;
      }
      let sent;
      try {
        // A just-alerted event is `new` with no calendar entry: Going/I applied, Remind me, Not interested.
        sent = await messenger.send(
          html,
          keyboardFor({ ...event, calendarState: null, calendarEventId: null }, null),
        );
      } catch (error) {
        const failure = error instanceof TelegramError ? error.failure : "systemic";
        errors.push(`alert for event ${String(event.id)}: ${message(error)}`);
        if (failure === "unknown") {
          // Might have reached the chat: keep the claim so it is never sent twice; reported each run.
          await store.markAlertUnknown(claim).catch((markError: unknown) => {
            // The claim stays "claimed" and is reported as stale on later runs; still never resent.
            errors.push(
              `alert for event ${String(event.id)}: could not mark unknown: ${message(markError)}`,
            );
          });
          continue;
        }
        try {
          await store.releaseAlert(claim, event.id, failure === "message");
        } catch (releaseError) {
          errors.push(
            `alert for event ${String(event.id)} stays claimed but unsent (release failed: ${message(releaseError)}); delete its messages row to resend`,
          );
          throw releaseError;
        }
        // Outage or bad config: no other message would get through either. Retry everything next run.
        if (failure === "systemic") {
          telegramDown = true;
          failed = true;
          break;
        }
        continue;
      }
      alertsSent++;
      // If this write fails the claim row stays, so the event is never sent twice; the run errors out.
      await store.completeAlert(claim, sent.messageId, deps.now());
    }

    if (!telegramDown) {
      remindersSent = await sendReminders(deps, errors, () => {
        failed = true;
      });
    }
  } catch (error) {
    errors.push(`pipeline: ${message(error)}`);
    throw error;
  } finally {
    // Always close the run row, so failures are visible in runs.errors.
    await store
      .finishRun(
        runId,
        {
          itemsFetched,
          itemsNew,
          itemsLlm: llm.llmCalls,
          alertsSent,
          costUsd: llm.costUsd,
          errors,
        },
        deps.now(),
      )
      .catch((error: unknown) => {
        errors.push(`finishRun: ${message(error)}`);
        failed = true;
      });
  }

  return {
    mode: deps.mode,
    sources: criteria.sources.length,
    itemsFetched,
    itemsFiltered,
    itemsNew,
    llmCalls: llm.llmCalls,
    alertsSent,
    remindersSent,
    costUsd: Math.round(llm.costUsd * 1e6) / 1e6,
    errors,
    failed,
  };
}

const replayConfigSchema = z.strictObject({
  /** Frozen clock for the replay, so fixtures never go stale. */
  now: z.iso.datetime({ offset: true }),
});

/** Offline dependencies: recorded HTTP and LLM fixtures, in-memory DB, fake Telegram, frozen clock. */
export async function createReplayDeps(
  replayDir: string,
): Promise<PipelineDeps & { messenger: FakeMessenger; llm: ReplayLlm; calendar: FakeCalendar }> {
  const criteria = await loadCriteria(replayCriteriaPath(replayDir));
  const config = replayConfigSchema.parse(
    JSON.parse(await readFile(join(replayDir, "replay.json"), "utf8")),
  );
  const now = new Date(config.now);
  const http = new ReplayHttp(replayDir);
  return {
    criteria,
    sources: buildSources(criteria, http, () => now),
    store: await openStore(":memory:"),
    http,
    llm: new ReplayLlm(replayDir),
    messenger: new FakeMessenger(),
    calendar: new FakeCalendar(await loadRecordedBusy(replayDir)),
    now: () => now,
    mode: "replay",
  };
}

/**
 * Google Calendar is required in production (M6): a missing credential stops the run instead of
 * silently sending every alert with "calendar: couldn't check".
 */
function calendarFromEnv(env: NodeJS.ProcessEnv, criteria: Criteria): CalendarClient {
  return new GoogleCalendar(
    {
      clientId: requireEnv(env, "GOOGLE_CLIENT_ID"),
      clientSecret: requireEnv(env, "GOOGLE_CLIENT_SECRET"),
      refreshToken: requireEnv(env, "GOOGLE_REFRESH_TOKEN"),
    },
    criteria.calendar.check,
  );
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`missing environment variable ${name}`);
  return value;
}

/** Live dependencies from environment variables (see .env.example). */
export async function createLiveDeps(
  criteriaPath: string,
  env: NodeJS.ProcessEnv,
): Promise<PipelineDeps> {
  const criteria = await loadCriteria(criteriaPath);
  const botToken = requireEnv(env, "TELEGRAM_BOT_TOKEN");
  const chatId = requireEnv(env, "TELEGRAM_CHAT_ID");
  const dbUrl = requireEnv(env, "TURSO_DATABASE_URL");
  const authToken = env.TURSO_AUTH_TOKEN;
  const apiKey = requireEnv(env, "ANTHROPIC_API_KEY");
  // A local DB on a runner starts empty every day: everything is re-alerted and re-paid, and the
  // monthly cost cap never sees earlier runs.
  if (env.GITHUB_ACTIONS === "true" && /^(file:|:memory:)/.test(dbUrl)) {
    throw new Error(
      "TURSO_DATABASE_URL must be a remote database in GitHub Actions, not a local one",
    );
  }
  const calendar = calendarFromEnv(env, criteria);
  const http = new FetchHttp();
  const now = (): Date => new Date();
  return {
    criteria,
    sources: buildSources(criteria, http, now),
    store: await openStore(dbUrl, authToken === "" ? undefined : authToken),
    http,
    llm: new AnthropicLlm(new Anthropic({ apiKey, timeout: 120_000 })),
    messenger: new TelegramMessenger(botToken, chatId),
    calendar,
    now,
    mode: "live",
  };
}

/** Busy blocks from `<dir>/calendar.json` (an empty calendar when the file is missing). */
export async function loadRecordedBusy(dir: string): Promise<BusyEvent[]> {
  let text: string;
  try {
    text = await readFile(join(dir, "calendar.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return recordedCalendar.parse(JSON.parse(text)).busy;
}

export function replayCriteriaPath(replayDir: string): string {
  return join(replayDir, "criteria.yaml");
}
