import type { Criteria } from "./config.js";
import type { Store } from "./db/store.js";
import {
  buildPrompt,
  decideStatus,
  extractionSchema,
  parseExtraction,
  validateExtraction,
  worthEscalating,
  type Extraction,
} from "./extract.js";
import { HttpError, type Http } from "./http.js";
import {
  costUsd,
  HAIKU,
  LlmError,
  SONNET,
  worstCaseCostUsd,
  type LlmClient,
  type LlmModel,
} from "./llm.js";
import { sendNoticeOnce } from "./notices.js";
import { escapeHtml } from "./alert.js";
import { listingPage, readPage, type Page } from "./page.js";
import type { Messenger } from "./telegram.js";
import type { StoredEvent } from "./types.js";

/** Unusable LLM answers per page before the event is given up on (each one costs money). */
export const MAX_EXTRACT_ATTEMPTS = 3;

/** Per model: output cap and effort. Haiku is the workhorse; Sonnet only re-checks weak fields. */
const CALL_SETTINGS: Record<LlmModel, { maxTokens: number; effort: "low" | "medium" }> = {
  [HAIKU]: { maxTokens: 6_000, effort: "low" },
  [SONNET]: { maxTokens: 6_000, effort: "medium" },
};

export type CapHit = "calls" | "budget";

/** Run and month caps from criteria.yaml `limits` (SPEC: cost guard). */
export class LlmBudget {
  calls = 0;
  spentThisRun = 0;

  constructor(
    private readonly maxCalls: number,
    private readonly monthlyBudgetUsd: number,
    private readonly spentThisMonth: number,
  ) {}

  /** Null if a call with this worst-case cost fits under both caps. */
  check(worstCaseUsd: number): CapHit | null {
    if (this.calls >= this.maxCalls) return "calls";
    if (this.spentThisMonth + this.spentThisRun + worstCaseUsd > this.monthlyBudgetUsd)
      return "budget";
    return null;
  }

  record(costUsd: number): void {
    this.calls++;
    this.spentThisRun += costUsd;
  }
}

export interface EnrichDeps {
  criteria: Criteria;
  store: Store;
  http: Http;
  llm: LlmClient;
  messenger: Messenger;
  now: () => Date;
}

/** Updated as calls are made, so the run row records the spend even if a later step throws. */
export interface EnrichStats {
  llmCalls: number;
  costUsd: number;
  /** Events that left pending_extraction this run. */
  extracted: number;
}

/** A gone page won't come back: counted like an unusable LLM answer. Other failures are retried. */
const GONE_STATUSES = new Set([404, 410]);

/** The site refuses automated readers: fall back to the listing text when the source gave one. */
const BLOCKED_STATUSES = new Set([401, 403]);

/** Blocked pages (with no listing to fall back on) of one source in one run before a notice. */
export const PAGES_BLOCKED_NOTICE_AFTER = 3;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

type CallResult =
  | {
      kind: "ok";
      extraction: Extraction;
      rawJson: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }
  | { kind: "unusable"; reason: string }
  /** The API rejected the request (400): this page's fault, or a setup error hitting every page. */
  | { kind: "rejected"; reason: string }
  | { kind: "capped"; cap: CapHit };

/**
 * SPEC core flow steps 4–6 for every event waiting for extraction: fetch the page, extract with
 * Haiku (or reuse the cached extraction), validate in code, escalate weak critical fields once to
 * Sonnet, then score against the location tier's minimum. Errors go into `errors`; an event whose
 * page or LLM call failed stays pending and is retried next run. Never throws for LLM or page errors.
 */
export async function enrichPending(
  deps: EnrichDeps,
  runId: number,
  errors: string[],
  stats: EnrichStats,
): Promise<void> {
  const { criteria, store } = deps;
  const startedAt = deps.now();
  const budget = new LlmBudget(
    criteria.limits.maxLlmCallsPerRun,
    criteria.limits.monthlyBudgetUsd,
    await store.llmSpendSince(monthStart(startedAt)),
  );
  let capHit: CapHit | null = null;
  // 400s are only charged to their events once another call this run worked; two in a row
  // means the request itself is broken (retired model, bad parameter) and nothing is charged.
  let rejectedEvents: number[] = [];
  // Mutated inside call(); an object so control-flow narrowing doesn't assume it never changes.
  const health = { consecutiveRejections: 0, anyCallWorked: false };

  const record = (cost: number): void => {
    budget.record(cost);
    stats.llmCalls = budget.calls;
    stats.costUsd = budget.spentThisRun;
  };
  const logCall = async (call: Parameters<Store["recordLlmCall"]>[0]): Promise<void> => {
    try {
      await store.recordLlmCall(call);
    } catch (error) {
      // The run row still has the spend (stats); only the per-call log entry is missing.
      errors.push(`cost log: ${message(error)}`);
    }
  };

  /** One paid call, logged whatever the outcome. Throws LlmError("systemic") on outages. */
  const call = async (model: LlmModel, event: StoredEvent, page: Page): Promise<CallResult> => {
    const { system, prompt } = buildPrompt(event, page, criteria, deps.now());
    const settings = CALL_SETTINGS[model];
    const cap = budget.check(
      worstCaseCostUsd(model, system.length + prompt.length, settings.maxTokens),
    );
    if (cap !== null) return { kind: "capped", cap };
    let response;
    try {
      response = await deps.llm.complete({
        model,
        url: page.cacheKey,
        system,
        prompt,
        schema: extractionSchema,
        maxTokens: settings.maxTokens,
        effort: settings.effort,
      });
    } catch (error) {
      // Count the call (a rejected request is billed nothing, but it used a slot).
      record(0);
      if (error instanceof LlmError && error.failure === "request") {
        await logCall({
          runId,
          url: page.cacheKey,
          model,
          outcome: "error",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          at: deps.now(),
        });
        return { kind: "rejected", reason: error.message };
      }
      throw error;
    }
    const cost = costUsd(model, response.usage);
    record(cost);
    health.anyCallWorked = true;
    health.consecutiveRejections = 0;
    const extraction =
      response.text !== null && response.stopReason === "end_turn"
        ? parseExtraction(response.text)
        : null;
    const outcome =
      extraction !== null
        ? "ok"
        : response.stopReason === "end_turn"
          ? "invalid"
          : (response.stopReason ?? "no_output");
    await logCall({
      runId,
      url: page.cacheKey,
      model,
      outcome,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: cost,
      at: deps.now(),
    });
    if (extraction === null || response.text === null) {
      return { kind: "unusable", reason: `${model} returned no usable extraction (${outcome})` };
    }
    return {
      kind: "ok",
      extraction,
      rawJson: response.text,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: cost,
    };
  };

  // Bounded so a large backlog is worked through over several runs.
  const pending = await store.eventsPendingExtraction(
    startedAt,
    criteria.limits.maxLlmCallsPerRun * 2,
  );
  // Pages that refused us (401/403): read from listing text, or (no listing) stuck, per source.
  let fromListing = 0;
  const blockedBySource = new Map<string, number>();
  for (const event of pending) {
    const label = `extract event ${String(event.id)}`;
    const now = (): Date => deps.now();
    let page: Page;
    try {
      page = readPage(event.canonicalUrl, await deps.http.getText(event.canonicalUrl));
    } catch (error) {
      const blocked = error instanceof HttpError && BLOCKED_STATUSES.has(error.status);
      if (blocked && event.listingText !== undefined) {
        // Weaker evidence than the page, but real data: fields it lacks stay unverified.
        page = listingPage(event.canonicalUrl, event.listingText);
        fromListing++;
      } else {
        errors.push(`${label}: page fetch failed: ${message(error)}`);
        if (blocked)
          blockedBySource.set(event.source, (blockedBySource.get(event.source) ?? 0) + 1);
        // A gone page counts against the event; anything else (site down today) is just retried.
        if (error instanceof HttpError && GONE_STATUSES.has(error.status)) {
          await store.failExtraction(event.id, MAX_EXTRACT_ATTEMPTS, now());
        } else {
          await store.deferExtraction(event.id, now());
        }
        continue;
      }
    }
    if (page.truncated) {
      errors.push(`${label}: page text cut at ${String(page.text.length)} characters`);
    }

    // 1. Haiku's answer: from the cache (extract once per URL) or a new call.
    const stored = await store.getExtraction(page.cacheKey);
    // Listing text is refreshed while the event waits; an answer about an older listing is stale.
    const cached =
      stored !== null && page.kind === "listing" && stored.contentHash !== page.contentHash
        ? null
        : stored;
    const cachedExtraction = cached === null ? null : parseExtraction(cached.rawJson);
    let answer: { model: LlmModel; rawJson: string; extraction: Extraction };
    let spent: { inputTokens: number; outputTokens: number; costUsd: number };
    if (cached !== null && cachedExtraction !== null) {
      answer = {
        model: cached.model === SONNET ? SONNET : HAIKU,
        rawJson: cached.rawJson,
        extraction: cachedExtraction,
      };
      spent = {
        inputTokens: cached.inputTokens,
        outputTokens: cached.outputTokens,
        costUsd: cached.costUsd,
      };
    } else {
      let first: CallResult;
      try {
        first = await call(HAIKU, event, page);
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        // Outage, auth or rate limit: no other call would work either. Retry everything next run.
        errors.push(`${label}: ${error.message}; LLM work stopped for this run`);
        break;
      }
      if (first.kind === "capped") {
        capHit = first.cap;
        break;
      }
      if (first.kind === "rejected") {
        errors.push(`${label}: ${first.reason}`);
        rejectedEvents.push(event.id);
        // To the back of the queue, so pages that always get a 400 can't block the others.
        await store.deferExtraction(event.id, now());
        if (++health.consecutiveRejections >= 2) {
          errors.push(
            "LLM requests rejected twice in a row: treating it as a setup error; LLM work stopped for this run",
          );
          rejectedEvents = [];
          break;
        }
        continue;
      }
      if (first.kind === "unusable") {
        errors.push(`${label}: ${first.reason}`);
        await store.failExtraction(event.id, MAX_EXTRACT_ATTEMPTS, now());
        continue;
      }
      answer = { model: HAIKU, rawJson: first.rawJson, extraction: first.extraction };
      spent = {
        inputTokens: first.inputTokens,
        outputTokens: first.outputTokens,
        costUsd: first.costUsd,
      };
      // Paid for: cache it now, so a failure below never pays for this page's Haiku call again.
      await store.saveExtraction(
        { url: page.cacheKey, contentHash: page.contentHash, ...answer, ...spent },
        now(),
      );
    }
    let validated = validateExtraction(answer.extraction, event, page, criteria);

    // 2. One Sonnet escalation for weak critical fields of an event that could be alerted (also for
    //    a cached Haiku answer whose escalation was postponed by the call cap or an outage).
    if (answer.model === HAIKU && worthEscalating(validated, criteria)) {
      let second: CallResult;
      try {
        second = await call(SONNET, event, page);
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        // Haiku's answer is cached; the event stays pending and escalates next run.
        errors.push(`${label}: escalation: ${error.message}; LLM work stopped for this run`);
        break;
      }
      if (second.kind === "ok") {
        spent = {
          inputTokens: spent.inputTokens + second.inputTokens,
          outputTokens: spent.outputTokens + second.outputTokens,
          costUsd: spent.costUsd + second.costUsd,
        };
        const rechecked = validateExtraction(second.extraction, event, page, criteria);
        // Sonnet's answer replaces Haiku's only if it is at least as well supported.
        const better = validated.scoreValid
          ? rechecked.scoreValid && rechecked.weak.length <= validated.weak.length
          : rechecked.scoreValid;
        if (better) {
          validated = rechecked;
          answer = { model: SONNET, rawJson: second.rawJson, extraction: second.extraction };
        }
        // Either way the escalation is done: record it so it isn't repeated.
        await store.saveExtraction(
          {
            url: page.cacheKey,
            contentHash: page.contentHash,
            model: SONNET,
            rawJson: answer.rawJson,
            ...spent,
          },
          now(),
        );
      } else if (second.kind === "capped" && second.cap === "calls") {
        // Next run has fresh call slots: escalate then (Haiku's answer is cached).
        capHit = "calls";
        break;
      } else if (second.kind === "capped") {
        // Budget: Haiku calls may still fit. Keep its answer (weak fields flagged) and carry on.
        errors.push(`${label}: escalation skipped (budget cap)`);
      } else {
        errors.push(`${label}: escalation: ${second.reason}`);
      }
    }

    if (!validated.scoreValid) {
      errors.push(`${label}: no valid worth score`);
      await store.failExtraction(event.id, MAX_EXTRACT_ATTEMPTS, now());
      continue;
    }
    const status = decideStatus(validated.update, criteria, now());
    await store.applyExtraction(event.id, validated.update, status, now());
    stats.extracted++;
  }

  if (health.anyCallWorked) {
    for (const eventId of rejectedEvents) {
      await store.failExtraction(eventId, MAX_EXTRACT_ATTEMPTS, deps.now());
    }
  }
  if (fromListing > 0) {
    errors.push(
      `${String(fromListing)} event pages blocked (HTTP 401/403): fell back to the source's listing data`,
    );
  }
  for (const [source, count] of blockedBySource) {
    if (count < PAGES_BLOCKED_NOTICE_AFTER) continue;
    // Once a month per source: these events wait (retried every run) until the sites let us in.
    await sendNoticeOnce(
      deps,
      `pages-blocked:${source}:${startedAt.toISOString().slice(0, 7)}`,
      escapeHtml(
        `⚠️ Events agent: ${String(count)} event pages from source "${source}" refused us this run (HTTP 401/403), so those events can't be checked or alerted. They are retried every run.`,
      ),
      errors,
    );
  }
  if (capHit !== null) await sendCapNotice(deps, capHit, runId, budget, errors);
}

/** SPEC: "If either is exceeded, LLM work stops and I get a Telegram notice." Budget: once a month. */
async function sendCapNotice(
  deps: EnrichDeps,
  cap: CapHit,
  runId: number,
  budget: LlmBudget,
  errors: string[],
): Promise<void> {
  const now = deps.now();
  const { limits } = deps.criteria;
  const key =
    cap === "budget" ? `budget:${now.toISOString().slice(0, 7)}` : `calls:run-${String(runId)}`;
  const text =
    cap === "budget"
      ? `⚠️ Events agent: the monthly LLM budget ($${limits.monthlyBudgetUsd.toFixed(2)}) is reached. Extraction is paused until next month; raise limits.monthlyBudgetUsd to resume sooner.`
      : `⚠️ Events agent: hit the cap of ${String(limits.maxLlmCallsPerRun)} LLM calls this run. The remaining events wait for the next run.`;
  errors.push(`LLM ${cap} cap reached after ${String(budget.calls)} calls`);
  await sendNoticeOnce(deps, key, text, errors);
}
