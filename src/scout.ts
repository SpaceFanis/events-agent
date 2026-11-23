import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { formatAlert } from "./alert.js";
import { loadCriteria, type Criteria } from "./config.js";
import { openStore, type Store } from "./db/store.js";
import { enrichPending } from "./enrich.js";
import { applyRules } from "./filter.js";
import { FetchHttp, ReplayHttp, type Http } from "./http.js";
import { AnthropicLlm, ReplayLlm, type LlmClient } from "./llm.js";
import { normalizeItem } from "./normalize.js";
import { buildSources } from "./sources/index.js";
import type { Source } from "./sources/types.js";
import { FakeMessenger, TelegramError, TelegramMessenger, type Messenger } from "./telegram.js";
import type { ScoutedEvent } from "./types.js";

export interface RunSummary {
  mode: "live" | "replay";
  sources: number;
  skippedSources: string[];
  itemsFetched: number;
  itemsFiltered: number;
  itemsNew: number;
  llmCalls: number;
  alertsSent: number;
  costUsd: number;
  errors: string[];
}

export interface PipelineDeps {
  criteria: Criteria;
  sources: Source[];
  skippedSources: string[];
  store: Store;
  /** Event pages for extraction (sources hold their own Http). */
  http: Http;
  llm: LlmClient;
  messenger: Messenger;
  now: () => Date;
  mode: RunSummary["mode"];
}

/** A `claimed` alert older than this is stuck, not just being sent by an overlapping run. */
const STALE_CLAIM_MS = 10 * 60 * 1000;

/** Failed sends per event before we stop retrying (e.g. a message Telegram always rejects). */
export const MAX_ALERT_ATTEMPTS = 3;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One scouting pass: fetch → normalize → rule filter → dedupe/store → page extraction + score →
 * alert. The calendar check (M3) slots in before the alert.
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
  // Filled in by the extraction stage as it goes, so failed runs still record their spend.
  const llm = { llmCalls: 0, costUsd: 0, extracted: 0 };

  // Each adapter fails alone; the run continues with the others.
  const survivors: ScoutedEvent[] = [];
  for (const source of deps.sources) {
    try {
      const result = await source.fetch();
      errors.push(...result.warnings);
      itemsFetched += result.items.length;
      for (const item of result.items) {
        const event = normalizeItem(item, criteria);
        if (applyRules(event, criteria, startedAt).keep) survivors.push(event);
        else itemsFiltered++;
      }
    } catch (error) {
      errors.push(`${source.name}: ${message(error)}`);
    }
  }

  try {
    for (const event of survivors) {
      if ((await store.insertIfNew(event, "pending_extraction", startedAt)) !== null) itemsNew++;
    }

    // Never alert from unextracted data: only events extraction moved to `new` reach the alert step.
    await enrichPending(deps, runId, errors, llm);

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
    for (const event of awaiting) {
      const claim = await store.claimAlert(event.id, messenger.chatId, deps.now());
      if (claim === null) continue; // another run got it first
      let html;
      try {
        html = formatAlert(event);
      } catch (error) {
        // This event's data is bad (e.g. an invalid time zone): count it against the event, don't block the rest.
        errors.push(`alert for event ${String(event.id)}: cannot format: ${message(error)}`);
        await store.releaseAlert(claim, event.id, true);
        continue;
      }
      let sent;
      try {
        sent = await messenger.send(html);
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
        if (failure === "systemic") break;
        continue;
      }
      alertsSent++;
      // If this write fails the claim row stays, so the event is never sent twice; the run errors out.
      await store.completeAlert(claim, sent.messageId, deps.now());
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
      });
  }

  return {
    mode: deps.mode,
    sources: criteria.sources.length,
    skippedSources: deps.skippedSources,
    itemsFetched,
    itemsFiltered,
    itemsNew,
    llmCalls: llm.llmCalls,
    alertsSent,
    costUsd: Math.round(llm.costUsd * 1e6) / 1e6,
    errors,
  };
}

const replayConfigSchema = z.strictObject({
  /** Frozen clock for the replay, so fixtures never go stale. */
  now: z.iso.datetime({ offset: true }),
});

/** Offline dependencies: recorded HTTP and LLM fixtures, in-memory DB, fake Telegram, frozen clock. */
export async function createReplayDeps(
  replayDir: string,
): Promise<PipelineDeps & { messenger: FakeMessenger; llm: ReplayLlm }> {
  const criteria = await loadCriteria(replayCriteriaPath(replayDir));
  const config = replayConfigSchema.parse(
    JSON.parse(await readFile(join(replayDir, "replay.json"), "utf8")),
  );
  const now = new Date(config.now);
  const http = new ReplayHttp(replayDir);
  const { sources, skipped } = buildSources(criteria, http);
  return {
    criteria,
    sources,
    skippedSources: skipped,
    store: await openStore(":memory:"),
    http,
    llm: new ReplayLlm(replayDir),
    messenger: new FakeMessenger(),
    now: () => now,
    mode: "replay",
  };
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
  const http = new FetchHttp();
  const { sources, skipped } = buildSources(criteria, http);
  return {
    criteria,
    sources,
    skippedSources: skipped,
    store: await openStore(dbUrl, authToken === "" ? undefined : authToken),
    http,
    llm: new AnthropicLlm(new Anthropic({ apiKey, timeout: 120_000 })),
    messenger: new TelegramMessenger(botToken, chatId),
    now: () => new Date(),
    mode: "live",
  };
}

export function replayCriteriaPath(replayDir: string): string {
  return join(replayDir, "criteria.yaml");
}
