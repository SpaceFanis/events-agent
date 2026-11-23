import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { RunStats, Store } from "../../src/db/store.js";
import { createReplayDeps, MAX_ALERT_ATTEMPTS, runPipeline } from "../../src/scout.js";
import { CalendarError, type CalendarClient } from "../../src/calendar.js";
import type { Source } from "../../src/sources/types.js";
import { TelegramError, type Messenger } from "../../src/telegram.js";

const run = promisify(execFile);

/** Wraps a store, replacing one method (fault injection). */
function override<K extends keyof Store>(store: Store, key: K, impl: Store[K]): Store {
  return new Proxy(store, {
    get: (target, prop, receiver): unknown =>
      prop === key ? impl : Reflect.get(target, prop, receiver),
  });
}
const FIXTURE = "test/fixtures/replay-basic";

// docs/SPEC.md "End-to-end acceptance test", steps 1–5 (buttons arrive in M4):
// fetch → rules → dedupe → page extraction + score → calendar check → Telegram.
describe("scout pipeline in replay mode", () => {
  it("alerts the two worthwhile events with verified details, then dedupes", async () => {
    const deps = await createReplayDeps(FIXTURE);
    try {
      const first = await runPipeline(deps);
      expect(first).toMatchObject({
        mode: "replay",
        // 4 from Devpost, 3 from MLH; the MLH ones have ended or match no include keyword.
        itemsFetched: 7,
        itemsFiltered: 4,
        itemsNew: 3,
        // (a), (b) and (d) on Haiku; (b)'s unsure deadline escalates once to Sonnet.
        llmCalls: 4,
        alertsSent: 2,
        costUsd: 0.014675,
        errors: [],
      });
      expect(deps.llm.requests.map((r) => `${r.model} ${r.url}`)).toEqual([
        "claude-haiku-5-5 https://openai-builders.devpost.com/",
        "claude-haiku-5-5 https://athens-robotics.devpost.com/",
        "claude-sonnet-5-5 https://athens-robotics.devpost.com/",
        "claude-haiku-5-5 https://berlin-ai-meetup.devpost.com/",
      ]);
      // The page's own text reached the model; its scripts did not.
      expect(deps.llm.requests[0]?.prompt).toContain("Registration is open to everyone.");
      expect(deps.llm.requests[0]?.prompt).not.toContain("Ignore previous instructions");

      const sent = deps.messenger.sent.map((message) => message.html);
      expect(sent).toHaveLength(2);
      const [online, athens] = sent;
      // (a) online AI hackathon, open registration, times in the zone the page states
      expect(online).toContain("<b>Open AI Builders Hackathon</b>");
      expect(online).toContain("🎟 Access: Open");
      expect(online).toContain('<a href="https://openai-builders.devpost.com/register">');
      expect(online).toContain("🗓 10 Dec 2026, 18:00 – 15 Jan 2027, 17:00 (America/New_York)");
      expect(online).toContain("⭐ Worth it: 8/10");
      expect(online).not.toContain("unverified");
      // The fake calendar's dentist appointment (8 Dec) is before (a) starts: free.
      expect(online).toContain("📅 Calendar: free");
      // (b) application in Athens: deadline and results date, application form linked on the page
      expect(athens).toContain(
        "🎟 Access: Application required · deadline 31 Jan 2027, 23:59 · results 10 Feb 2027",
      );
      expect(athens).toContain(
        '<a href="https://forms.example.org/athens-robotics-apply">Apply</a>',
      );
      // The busy block on 21 Feb sits inside (b)'s 20–22 Feb span.
      expect(athens).toContain("📅 Calendar: conflicts with &quot;Thesis defence rehearsal&quot;");
      expect(deps.calendar.queries).toEqual([
        { start: "2026-12-10T23:00:00.000Z", end: "2027-01-15T22:00:00.000Z" },
        { start: "2027-02-20T07:00:00.000Z", end: "2027-02-22T16:00:00.000Z" },
      ]);
      // Sonnet's travel-support quote is not on the page: not shown, flagged instead.
      expect(athens).not.toContain("fully covered");
      expect(athens).toContain("⚠️ unverified: travel support");
      // (c) crypto: dropped by the exclude rule, never sent to the LLM
      expect(sent.join("\n")).not.toContain("Crypto");
      // (d) Berlin meetup scored 6: below the abroad minimum of 9
      expect(sent.join("\n")).not.toContain("Berlin");

      const second = await runPipeline(deps);
      expect(second).toMatchObject({ itemsNew: 0, llmCalls: 0, alertsSent: 0, costUsd: 0 });
      expect(deps.messenger.sent).toHaveLength(2);
    } finally {
      deps.store.close();
    }
  });

  it("still alerts when the calendar is down, saying it couldn't check, and stops asking", async () => {
    const deps = await createReplayDeps(FIXTURE);
    let calls = 0;
    const down: CalendarClient = {
      busy: () => {
        calls++;
        return Promise.reject(new CalendarError("google calendar: HTTP 503"));
      },
    };
    try {
      const run = await runPipeline({ ...deps, calendar: down });
      expect(run.alertsSent).toBe(2);
      expect(run.errors).toEqual(["calendar: google calendar: HTTP 503"]);
      expect(calls).toBe(1);
      for (const sent of deps.messenger.sent) {
        expect(sent.html).toContain("📅 Calendar: couldn't check (calendar unavailable)");
      }
    } finally {
      deps.store.close();
    }
  });

  it("retries alerts that failed to send on the next run, once", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const realMessenger = deps.messenger;
    const down: Messenger = {
      chatId: "replay-chat",
      send: () => Promise.reject(new TelegramError("telegram down", "systemic")),
    };
    try {
      // A systemic failure stops the loop after the first message and uses up no attempts,
      // however many days the outage lasts.
      for (let day = 0; day < MAX_ALERT_ATTEMPTS + 2; day++) {
        const failed = await runPipeline({ ...deps, messenger: down });
        expect(failed.alertsSent).toBe(0);
        expect(failed.errors).toHaveLength(1);
        // Telegram is the only interface, so the CLI exits non-zero and the cron run goes red.
        expect(failed.failed).toBe(true);
      }

      const retried = await runPipeline({ ...deps, messenger: realMessenger });
      expect(retried).toMatchObject({
        itemsNew: 0,
        llmCalls: 0,
        alertsSent: 2,
        errors: [],
        failed: false,
      });
      expect((await runPipeline(deps)).alertsSent).toBe(0);
    } finally {
      deps.store.close();
    }
  });

  it("gives up on a message Telegram keeps rejecting, and never alerts events that ended meanwhile", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const rejects: Messenger = {
      chatId: "c",
      send: () => Promise.reject(new TelegramError("can't parse entities", "message")),
    };
    const down: Messenger = {
      chatId: "c",
      send: () => Promise.reject(new TelegramError("telegram down", "systemic")),
    };
    try {
      for (let run = 0; run < MAX_ALERT_ATTEMPTS; run++) {
        // Message-specific: the loop carries on to the next event.
        expect((await runPipeline({ ...deps, messenger: rejects })).errors).toHaveLength(2);
      }
      expect((await runPipeline(deps)).alertsSent).toBe(0);
    } finally {
      deps.store.close();
    }

    const later = await createReplayDeps(FIXTURE);
    try {
      await runPipeline({ ...later, messenger: down });
      // Telegram back after the online hackathon (ends 15 Jan 2027) is over: only (b) goes out.
      const after = await runPipeline({ ...later, now: () => new Date("2027-01-20T09:00:00Z") });
      expect(after.alertsSent).toBe(1);
      expect(later.messenger.sent.map((m) => m.html).join("\n")).not.toContain("Open AI Builders");
    } finally {
      later.store.close();
    }
  });

  it("never re-sends an alert whose send succeeded but whose DB write failed", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const brokenWrite = override(deps.store, "completeAlert", () =>
      Promise.reject(new Error("turso 503")),
    );
    try {
      await expect(runPipeline({ ...deps, store: brokenWrite })).rejects.toThrow("turso 503");
      expect(deps.messenger.sent).toHaveLength(1);
      // The claim stays, so the next run does not send that event again.
      const next = await runPipeline(deps);
      expect(next.alertsSent).toBe(1);
      expect(new Set(deps.messenger.sent.map((m) => m.html)).size).toBe(2);
    } finally {
      deps.store.close();
    }
  });

  it("keeps the claim after a timeout (may have been delivered) and reports it on later runs", async () => {
    const deps = await createReplayDeps(FIXTURE);
    let calls = 0;
    const flaky: Messenger = {
      chatId: "c",
      send: (html) =>
        calls++ === 0
          ? Promise.reject(new TelegramError("timed out", "unknown"))
          : deps.messenger.send(html),
    };
    try {
      const first = await runPipeline({ ...deps, messenger: flaky });
      expect(first.alertsSent).toBe(1);
      const second = await runPipeline(deps);
      expect(second.alertsSent).toBe(0);
      expect(second.errors).toEqual([expect.stringMatching(/alert for event 1 is unknown since/)]);
      expect(deps.messenger.sent.map((m) => m.html).join("\n")).not.toContain("Open AI Builders");
    } finally {
      deps.store.close();
    }
  });

  it("names the stuck event when releasing a failed claim also fails", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const store = override(deps.store, "releaseAlert", () =>
      Promise.reject(new Error("turso 503")),
    );
    const down: Messenger = {
      chatId: "c",
      send: () => Promise.reject(new TelegramError("telegram down", "systemic")),
    };
    try {
      await expect(runPipeline({ ...deps, store, messenger: down })).rejects.toThrow("turso 503");
      // Not reported while it could still be an overlapping run's in-flight send...
      expect((await runPipeline({ ...deps, messenger: down })).errors).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/is claimed since/)]),
      );
      // ...but reported once stale.
      const later = new Date(deps.now().getTime() + 20 * 60 * 1000);
      const next = await runPipeline({ ...deps, now: () => later });
      expect(next.errors).toEqual([expect.stringMatching(/alert for event 1 is claimed since/)]);
      expect(next.alertsSent).toBe(1);
    } finally {
      deps.store.close();
    }
  });

  it("does not let one unformattable event block the others", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const badZone = override(deps.store, "eventsAwaitingAlert", async (...args) =>
      (await deps.store.eventsAwaitingAlert(...args)).map((e) =>
        e.id === 1 ? { ...e, timezone: "Not/AZone" } : e,
      ),
    );
    try {
      const first = await runPipeline({ ...deps, store: badZone });
      expect(first.alertsSent).toBe(1);
      expect(first.errors).toEqual([expect.stringMatching(/event 1: cannot format/)]);
      // Counted as an attempt each time, so it is dropped after MAX_ALERT_ATTEMPTS.
      for (let run = 1; run < MAX_ALERT_ATTEMPTS; run++)
        await runPipeline({ ...deps, store: badZone });
      expect((await runPipeline(deps)).alertsSent).toBe(0);
    } finally {
      deps.store.close();
    }
  });

  it("caps alerts per run and sends the rest next run", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const criteria = { ...deps.criteria, limits: { ...deps.criteria.limits, maxAlertsPerRun: 1 } };
    try {
      expect((await runPipeline({ ...deps, criteria })).alertsSent).toBe(1);
      expect((await runPipeline({ ...deps, criteria })).alertsSent).toBe(1);
      expect((await runPipeline({ ...deps, criteria })).alertsSent).toBe(0);
    } finally {
      deps.store.close();
    }
  });

  it("sends each alert once when two runs overlap", async () => {
    const deps = await createReplayDeps(FIXTURE);
    try {
      const [a, b] = await Promise.all([runPipeline(deps), runPipeline(deps)]);
      expect(a.alertsSent + b.alertsSent).toBe(2);
      expect(new Set(deps.messenger.sent.map((m) => m.html)).size).toBe(2);
      expect(deps.messenger.sent).toHaveLength(2);
    } finally {
      deps.store.close();
    }
  });

  it("records the run even when the store fails mid-run", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const finished: RunStats[] = [];
    let store = override(deps.store, "insertIfNew", () => Promise.reject(new Error("turso down")));
    store = override(store, "finishRun", (_id, stats) => {
      finished.push(stats);
      return Promise.resolve();
    });
    try {
      await expect(runPipeline({ ...deps, store })).rejects.toThrow("turso down");
      expect(finished).toHaveLength(1);
      expect(finished[0]?.errors).toEqual(["pipeline: turso down"]);
    } finally {
      deps.store.close();
    }
  });

  it("sends one 'source broken' notice per failure streak, after 3 failed runs", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const broken: Source = {
      name: "mlh",
      fetch: () => Promise.reject(new Error("mlh page 1: HTTP 503")),
    };
    const working = deps.sources;
    const failing = working.map((source) => (source.name === "mlh" ? broken : source));
    const notices = (): string[] =>
      deps.messenger.sent.filter((m) => m.html.includes("Hackscout: source")).map((m) => m.html);
    const day = (n: number): (() => Date) => {
      const at = new Date(deps.now().getTime() + n * 24 * 60 * 60 * 1000);
      return () => at;
    };
    try {
      // Devpost keeps working, so the alerts still go out on the first run.
      const first = await runPipeline({ ...deps, sources: failing });
      expect(first.alertsSent).toBe(2);
      expect(first.errors).toEqual(["mlh: mlh page 1: HTTP 503"]);
      await runPipeline({ ...deps, sources: failing, now: day(1) });
      expect(notices()).toEqual([]);
      await runPipeline({ ...deps, sources: failing, now: day(2) });
      expect(notices()).toEqual([
        "⚠️ Hackscout: source &quot;mlh&quot; has failed 3 runs in a row. Each run still tries it. Last error: mlh page 1: HTTP 503",
      ]);
      // Still broken: no second notice for the same streak.
      await runPipeline({ ...deps, sources: failing, now: day(3) });
      expect(notices()).toHaveLength(1);
      // It recovers, then breaks again: a new streak, reported again after 3 runs.
      await runPipeline({ ...deps, sources: working, now: day(4) });
      for (const n of [5, 6, 7]) await runPipeline({ ...deps, sources: failing, now: day(n) });
      expect(notices()).toHaveLength(2);
    } finally {
      deps.store.close();
    }
  });

  it("CLI runs offline and prints a single JSON summary", async () => {
    const { stdout } = await run("npx", ["tsx", "src/main.ts", "--replay", FIXTURE]);
    const summary = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(summary).toMatchObject({
      mode: "replay",
      sources: 2,
      alertsSent: 2,
      llmCalls: 4,
      costUsd: 0.014675,
    });
  });
});
