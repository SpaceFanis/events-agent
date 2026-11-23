import { describe, expect, it } from "vitest";
import type { Store } from "../../src/db/store.js";
import { MAX_EXTRACT_ATTEMPTS } from "../../src/enrich.js";
import { HttpError, type Http } from "../../src/http.js";
import { LlmError, type LlmClient } from "../../src/llm.js";
import { createReplayDeps, runPipeline } from "../../src/scout.js";

const FIXTURE = "test/fixtures/replay-basic";
const ATHENS = "https://athens-robotics.devpost.com/";

function override<T extends object, K extends keyof T>(target: T, key: K, impl: T[K]): T {
  return new Proxy(target, {
    get: (obj, prop, receiver): unknown => (prop === key ? impl : Reflect.get(obj, prop, receiver)),
  });
}

type Deps = Awaited<ReturnType<typeof createReplayDeps>>;

function withLimits(deps: Deps, limits: Partial<Deps["criteria"]["limits"]>): Deps {
  return {
    ...deps,
    criteria: { ...deps.criteria, limits: { ...deps.criteria.limits, ...limits } },
  };
}

describe("extraction stage (M2) in replay mode", () => {
  it("stops LLM work at the monthly budget and sends one notice per month", async () => {
    const deps = withLimits(await createReplayDeps(FIXTURE), { monthlyBudgetUsd: 0.000001 });
    try {
      const first = await runPipeline(deps);
      expect(first).toMatchObject({ itemsNew: 3, llmCalls: 0, alertsSent: 0, costUsd: 0 });
      expect(first.errors).toEqual(["LLM budget cap reached after 0 calls"]);
      expect(deps.messenger.sent.map((m) => m.html)).toEqual([
        expect.stringContaining("monthly LLM budget ($0.00) is reached"),
      ]);
      // Same month: still capped, no second notice, and nothing is alerted unextracted.
      const second = await runPipeline(deps);
      expect(second).toMatchObject({ llmCalls: 0, alertsSent: 0 });
      expect(deps.messenger.sent).toHaveLength(1);
      // Budget raised: the waiting events are extracted and alerted.
      const third = await runPipeline(withLimits(deps, { monthlyBudgetUsd: 1 }));
      expect(third).toMatchObject({ llmCalls: 4, alertsSent: 2 });
    } finally {
      deps.store.close();
    }
  });

  it("skips only the Sonnet escalation when the budget can't cover it, and keeps going", async () => {
    // Haiku's worst case (~$0.006) fits; Sonnet's (~$0.07) does not.
    const deps = withLimits(await createReplayDeps(FIXTURE), { monthlyBudgetUsd: 0.02 });
    try {
      const run = await runPipeline(deps);
      expect(run).toMatchObject({ llmCalls: 3, alertsSent: 2 });
      expect(run.errors).toEqual([
        expect.stringMatching(/event 2: escalation skipped \(budget cap\)/),
      ]);
      const athens = deps.messenger.sent.find((m) => m.html.includes("Athens Robotics"))?.html;
      // Haiku was unsure of the deadline: it is not shown, it is flagged.
      expect(athens).toContain("🎟 Access: Application required · results 10 Feb 2027");
      expect(athens).toContain("⚠️ unverified: deadline");
      // Not a budget stop: no "paused" notice, and Berlin was still extracted.
      expect(deps.messenger.sent.some((m) => m.html.includes("monthly LLM budget"))).toBe(false);
      expect(await deps.store.eventsPendingExtraction(deps.now(), 10)).toEqual([]);
    } finally {
      deps.store.close();
    }
  });

  it("treats 400s on every request as a setup error and charges no attempts", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const broken: LlmClient = {
      complete: () => Promise.reject(new LlmError("anthropic: model not found", "request")),
    };
    try {
      for (let day = 0; day < MAX_EXTRACT_ATTEMPTS + 1; day++) {
        const run = await runPipeline({ ...deps, llm: broken });
        expect(run.llmCalls).toBe(2);
        expect(run.errors.at(-1)).toMatch(/rejected twice in a row/);
      }
      expect((await runPipeline(deps)).alertsSent).toBe(2);
    } finally {
      deps.store.close();
    }
  });

  it("charges a 400 to its page only when other calls in the run work", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const rejectsAthens: LlmClient = {
      complete: (request) =>
        request.url === ATHENS
          ? Promise.reject(new LlmError("anthropic: prompt too long", "request"))
          : deps.llm.complete(request),
    };
    const charged: number[] = [];
    const store = override<Store, "failExtraction">(deps.store, "failExtraction", (id, ...rest) => {
      charged.push(id);
      return deps.store.failExtraction(id, ...rest);
    });
    try {
      // (a) and (d) work in the same run, so the 400 is (b)'s own fault: one attempt.
      expect((await runPipeline({ ...deps, store, llm: rejectsAthens })).alertsSent).toBe(1);
      expect(charged).toEqual([2]);
      // Next run (b) is the only call: nothing proves the API works, so nothing is charged.
      await runPipeline({ ...deps, store, llm: rejectsAthens });
      expect(charged).toEqual([2]);
      expect((await runPipeline(deps)).alertsSent).toBe(1);
    } finally {
      deps.store.close();
    }
  });

  it("gives up on a page that is gone (404) after the attempt cap", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const http = override<Http, "getText">(deps.http, "getText", (url) =>
      url === ATHENS ? Promise.reject(new HttpError("HTTP 404", 404)) : deps.http.getText(url),
    );
    try {
      for (let run = 0; run < MAX_EXTRACT_ATTEMPTS; run++) await runPipeline({ ...deps, http });
      expect(await deps.store.eventsPendingExtraction(deps.now(), 10)).toEqual([]);
      expect((await runPipeline(deps)).alertsSent).toBe(0);
    } finally {
      deps.store.close();
    }
  });

  it("caps LLM calls per run and carries on next run", async () => {
    const deps = withLimits(await createReplayDeps(FIXTURE), { maxLlmCallsPerRun: 1 });
    try {
      const first = await runPipeline(deps);
      expect(first).toMatchObject({ llmCalls: 1, alertsSent: 1 });
      expect(deps.messenger.sent.map((m) => m.html)).toEqual([
        expect.stringContaining("cap of 1 LLM calls"),
        expect.stringContaining("Open AI Builders"),
      ]);
      // (b): Haiku is cached, but its escalation has no call slot left; it waits for the next run.
      const second = await runPipeline(deps);
      expect(second).toMatchObject({ llmCalls: 1, alertsSent: 0 });
      // The postponed escalation runs from the cached Haiku answer: no second Haiku call.
      const third = await runPipeline(deps);
      expect(third).toMatchObject({ llmCalls: 1, alertsSent: 1 });
      const athens = deps.messenger.sent.find((m) => m.html.includes("Athens Robotics"))?.html;
      expect(athens).toContain("deadline 31 Jan 2027, 23:59");
      expect(deps.llm.requests.filter((r) => r.url === ATHENS).map((r) => r.model)).toEqual([
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
      ]);
    } finally {
      deps.store.close();
    }
  });

  it("logs every call's cost in the DB for the monthly cap", async () => {
    const deps = await createReplayDeps(FIXTURE);
    try {
      const run = await runPipeline(deps);
      expect(await deps.store.llmSpendSince(new Date("2026-12-01T00:00:00Z"))).toBeCloseTo(
        run.costUsd,
        9,
      );
      expect(await deps.store.llmSpendSince(new Date("2027-01-01T00:00:00Z"))).toBe(0);
      const cached = await deps.store.getExtraction(ATHENS);
      expect(cached).toMatchObject({
        model: "claude-sonnet-5-5",
        inputTokens: 4200,
        outputTokens: 1550,
      });
    } finally {
      deps.store.close();
    }
  });

  it("reuses the cached extraction when saving the result failed, instead of paying again", async () => {
    const deps = await createReplayDeps(FIXTURE);
    let failures = 1;
    const store = override<Store, "applyExtraction">(deps.store, "applyExtraction", (...args) =>
      failures-- > 0 ? Promise.reject(new Error("turso 503")) : deps.store.applyExtraction(...args),
    );
    try {
      await expect(runPipeline({ ...deps, store })).rejects.toThrow("turso 503");
      expect(deps.llm.requests).toHaveLength(1);
      const next = await runPipeline(deps);
      // (a) comes from the cache; only (b) and (d) are new calls.
      expect(next).toMatchObject({ llmCalls: 3, alertsSent: 2 });
      expect(deps.llm.requests.filter((r) => r.url.includes("openai-builders"))).toHaveLength(1);
    } finally {
      deps.store.close();
    }
  });

  it("never alerts from a refused extraction, retries it, and gives up after the attempt cap", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const refuses: LlmClient = {
      complete: (request) =>
        request.url === ATHENS
          ? Promise.resolve({
              text: null,
              stopReason: "refusal",
              usage: { inputTokens: 1000, outputTokens: 5 },
            })
          : deps.llm.complete(request),
    };
    try {
      const first = await runPipeline({ ...deps, llm: refuses });
      expect(first.alertsSent).toBe(1);
      expect(first.errors).toEqual([
        expect.stringMatching(/event 2: .*no usable extraction \(refusal\)/),
      ]);
      // Refused calls still count toward spend.
      expect(first.costUsd).toBeGreaterThan(0.0005);
      for (let run = 1; run < MAX_EXTRACT_ATTEMPTS; run++)
        await runPipeline({ ...deps, llm: refuses });
      expect(await deps.store.eventsPendingExtraction(deps.now(), 10)).toEqual([]);
      // Given up: even a working model is not asked again.
      const after = await runPipeline(deps);
      expect(after).toMatchObject({ llmCalls: 0, alertsSent: 0 });
      expect(deps.messenger.sent.some((m) => m.html.includes("Athens Robotics"))).toBe(false);
    } finally {
      deps.store.close();
    }
  });

  it("stops LLM work on an outage without using up attempts", async () => {
    const deps = await createReplayDeps(FIXTURE);
    let calls = 0;
    const down: LlmClient = {
      complete: () => {
        calls++;
        return Promise.reject(new LlmError("anthropic: overloaded", "systemic"));
      },
    };
    try {
      for (let day = 0; day < MAX_EXTRACT_ATTEMPTS + 1; day++) {
        const run = await runPipeline({ ...deps, llm: down });
        expect(run).toMatchObject({ alertsSent: 0 });
        expect(run.errors).toEqual([expect.stringMatching(/overloaded; LLM work stopped/)]);
      }
      expect(calls).toBe(MAX_EXTRACT_ATTEMPTS + 1); // one call per run, then stop
      expect((await runPipeline(deps)).alertsSent).toBe(2);
    } finally {
      deps.store.close();
    }
  });

  it("keeps the paid Haiku answer when Sonnet is down, and escalates next run", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const sonnetDown: LlmClient = {
      complete: (request) =>
        request.model === "claude-sonnet-5-5"
          ? Promise.reject(new LlmError("anthropic: overloaded", "systemic"))
          : deps.llm.complete(request),
    };
    try {
      const first = await runPipeline({ ...deps, llm: sonnetDown });
      expect(first).toMatchObject({ llmCalls: 3, alertsSent: 1 });
      const second = await runPipeline(deps);
      expect(second).toMatchObject({ llmCalls: 2, alertsSent: 1 }); // Sonnet for (b), Haiku for (d)
      expect(deps.llm.requests.filter((r) => r.url === ATHENS).map((r) => r.model)).toEqual([
        // Haiku once (cached); the failed Sonnet call never reached the recorded fake.
        "claude-haiku-5-5",
        "claude-sonnet-5-5",
      ]);
    } finally {
      deps.store.close();
    }
  });

  it("does not pay Sonnet to re-check an event that scores too low to be alerted", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const BERLIN = "https://berlin-ai-meetup.devpost.com/";
    // Berlin's Haiku answer, but unsure of the start date: weak, yet 6 is far below abroad's 9.
    const unsureBerlin: LlmClient = {
      complete: async (request) => {
        const response = await deps.llm.complete(request);
        if (request.url !== BERLIN || response.text === null) return response;
        const output = JSON.parse(response.text) as { start: { confidence: string } };
        output.start.confidence = "low";
        return { ...response, text: JSON.stringify(output) };
      },
    };
    try {
      const run = await runPipeline({ ...deps, llm: unsureBerlin });
      expect(run).toMatchObject({ llmCalls: 4, alertsSent: 2 }); // only Athens escalates
      expect(deps.llm.requests.filter((r) => r.url === BERLIN).map((r) => r.model)).toEqual([
        "claude-haiku-5-5",
      ]);
    } finally {
      deps.store.close();
    }
  });

  it("keeps an event pending while its page can't be fetched", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const http = override<Http, "getText">(deps.http, "getText", (url) =>
      url === ATHENS ? Promise.reject(new Error("HTTP 503")) : deps.http.getText(url),
    );
    try {
      const first = await runPipeline({ ...deps, http });
      expect(first.alertsSent).toBe(1);
      expect(first.errors).toEqual([expect.stringMatching(/event 2: page fetch failed: HTTP 503/)]);
      const second = await runPipeline(deps);
      expect(second).toMatchObject({ llmCalls: 2, alertsSent: 1, errors: [] });
    } finally {
      deps.store.close();
    }
  });

  it("extracts from Devpost's listing data when the event page is blocked (403)", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const OPENAI = "https://openai-builders.devpost.com/";
    const http = override<Http, "getText">(deps.http, "getText", (url) =>
      url === OPENAI
        ? Promise.reject(new HttpError(`GET ${url} failed: HTTP 403`, 403))
        : deps.http.getText(url),
    );
    const field = (value: string | null, evidence: string | null) => ({
      value,
      evidence,
      confidence: "high",
    });
    // Quotes from the listing text the Devpost adapter builds; nothing the listing doesn't state.
    const listingAnswer = {
      organiser: field("OpenBuild", "Organiser: OpenBuild"),
      start: field("2026-12-10", "Submission period: Dec 10, 2026 - Jan 15, 2027"),
      end: field("2027-01-15", "Submission period: Dec 10, 2026 - Jan 15, 2027"),
      timezone: field(null, null),
      location: field("Online", "Location: Online"),
      city: field(null, null),
      country: field(null, null),
      attendance: field("online", "Location: Online"),
      // The model over-reaches: a listing can't show who may join, so this must not verify access.
      access: field("open", "Submission period: Dec 10, 2026 - Jan 15, 2027"),
      register_url: field(
        "https://openai-builders.devpost.com/?utm_source=devpost",
        "Hackathon page: https://openai-builders.devpost.com/?utm_source=devpost",
      ),
      register_steps: field(null, null),
      apply_deadline: field(null, null),
      results_date: field(null, null),
      cost: field(null, null),
      travel_support: field(null, null),
      prizes: field("$5,000", "Total prizes: $5,000"),
      eligibility: field(null, null),
      worth: { score: 8, reason: "Online AI hackathon, strong fit." },
    };
    const prompts: string[] = [];
    const llm = override<LlmClient, "complete">(deps.llm, "complete", (request) => {
      if (request.url !== `${OPENAI}#listing`) return deps.llm.complete(request);
      prompts.push(request.prompt);
      return Promise.resolve({
        text: JSON.stringify(listingAnswer),
        stopReason: "end_turn",
        usage: { inputTokens: 500, outputTokens: 400 },
      });
    });
    try {
      const first = await runPipeline({ ...deps, http, llm });
      expect(first.alertsSent).toBe(2);
      expect(first.errors).toEqual([
        "1 event pages blocked (HTTP 401/403): fell back to the source's listing data",
      ]);
      // The model is told it reads listing data, and the listing holds Devpost's facts.
      expect(prompts[0]).toContain("listing data for the event, not its page");
      expect(prompts[0]).toContain("Submission period: Dec 10, 2026 - Jan 15, 2027");
      const alert = deps.messenger.sent.find((sent) => sent.html.includes("Open AI Builders"));
      expect(alert?.html).toMatch(/unverified[^\n]*\baccess\b/);
      // Access was ignored, not "weak": no paid Sonnet re-check of what a listing can't settle.
      expect(first.llmCalls).toBe(4);
      // Cached under the listing key only: a later real page extraction would not reuse it.
      expect(await deps.store.getExtraction(`${OPENAI}#listing`)).not.toBeNull();
      expect(await deps.store.getExtraction(OPENAI)).toBeNull();

      // Cached under its own key: the next run neither refetches nor pays again.
      const before = deps.llm.requests.length + prompts.length;
      const second = await runPipeline({ ...deps, http, llm });
      expect(second).toMatchObject({ llmCalls: 0, alertsSent: 0, errors: [] });
      expect(deps.llm.requests.length + prompts.length).toBe(before);
    } finally {
      deps.store.close();
    }
  });

  it("sends one 'pages blocked' notice a month when blocked pages have no listing to fall back on", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const http = override<Http, "getText">(deps.http, "getText", (url) =>
      url.includes(".devpost.com/")
        ? Promise.reject(new HttpError(`GET ${url} failed: HTTP 403`, 403))
        : deps.http.getText(url),
    );
    // A source without listing text (like a feed): blocked pages leave nothing to read.
    const sources = deps.sources.map((source) => ({
      name: source.name,
      fetch: async () => {
        const result = await source.fetch();
        return {
          ...result,
          items: result.items.map((item) => {
            const copy = { ...item };
            delete copy.listingText;
            return copy;
          }),
        };
      },
    }));
    try {
      const first = await runPipeline({ ...deps, http, sources });
      expect(first).toMatchObject({ llmCalls: 0, alertsSent: 0 });
      const notices = () =>
        deps.messenger.sent.filter((sent) => sent.html.includes("refused us this run"));
      expect(notices()).toHaveLength(1);
      expect(notices()[0]?.html).toContain("3 event pages from source &quot;devpost&quot;");
      await runPipeline({ ...deps, http, sources });
      expect(notices()).toHaveLength(1);
    } finally {
      deps.store.close();
    }
  });
});
