import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { RunStats, Store } from "../../src/db/store.js";
import { createReplayDeps, MAX_ALERT_ATTEMPTS, runPipeline } from "../../src/scout.js";
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

// docs/SPEC.md "End-to-end acceptance test", M1 slice: fetch → rules → dedupe → Telegram.
// Step 4's abroad threshold (score), calendar and buttons arrive with M2–M4; (d) is still alerted in M1.
describe("scout pipeline in replay mode", () => {
  it("alerts rule survivors once, then dedupes on the next run", async () => {
    const deps = await createReplayDeps(FIXTURE);
    try {
      const first = await runPipeline(deps);
      expect(first).toMatchObject({
        mode: "replay",
        skippedSources: ["mlh"],
        itemsFetched: 4,
        itemsFiltered: 1,
        itemsNew: 3,
        alertsSent: 3,
        llmCalls: 0,
        costUsd: 0,
        errors: [],
      });

      const sent = deps.messenger.sent.map((message) => message.html);
      expect(sent).toHaveLength(3);
      const [online, athens, berlin] = sent;
      // (a) online AI hackathon, open registration
      expect(online).toContain("<b>Open AI Builders Hackathon</b>");
      expect(online).toContain("🎟 Access: Open");
      expect(online).toContain(
        '<a href="https://openai-builders.devpost.com/?utm_source=devpost">',
      );
      expect(online).toContain("🗓 10 Dec 2026 – 15 Jan 2027 (Europe/Athens)");
      // (b) in-person in Athens
      expect(athens).toContain("📍 Athens, Greece");
      // (c) crypto: dropped by the exclude rule
      expect(sent.join("\n")).not.toContain("Crypto");
      // (d) abroad: no zone known yet, so shown in UTC and flagged
      expect(berlin).toContain("(UTC)");
      expect(berlin).toContain("⚠️ unverified: access, time, timezone");

      const second = await runPipeline(deps);
      expect(second).toMatchObject({ itemsFetched: 4, itemsNew: 0, alertsSent: 0 });
      expect(deps.messenger.sent).toHaveLength(3);
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
      }

      const retried = await runPipeline({ ...deps, messenger: realMessenger });
      expect(retried).toMatchObject({ itemsNew: 0, alertsSent: 3, errors: [] });
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
        expect((await runPipeline({ ...deps, messenger: rejects })).errors).toHaveLength(3);
      }
      expect((await runPipeline(deps)).alertsSent).toBe(0);
    } finally {
      deps.store.close();
    }

    const later = await createReplayDeps(FIXTURE);
    try {
      await runPipeline({ ...later, messenger: down });
      // Telegram back after the online hackathon (ends 15 Jan 2027) is over: only the other two go out.
      const after = await runPipeline({ ...later, now: () => new Date("2027-01-20T09:00:00Z") });
      expect(after.alertsSent).toBe(2);
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
      expect(next.alertsSent).toBe(2);
      expect(new Set(deps.messenger.sent.map((m) => m.html)).size).toBe(3);
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
      expect(first.alertsSent).toBe(2);
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
      expect(next.alertsSent).toBe(2);
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
      expect(first.alertsSent).toBe(2);
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
    const criteria = { ...deps.criteria, limits: { ...deps.criteria.limits, maxAlertsPerRun: 2 } };
    try {
      expect((await runPipeline({ ...deps, criteria })).alertsSent).toBe(2);
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
      expect(a.alertsSent + b.alertsSent).toBe(3);
      expect(new Set(deps.messenger.sent.map((m) => m.html)).size).toBe(3);
      expect(deps.messenger.sent).toHaveLength(3);
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

  it("CLI runs offline and prints a single JSON summary", async () => {
    const { stdout } = await run("npx", ["tsx", "src/main.ts", "--replay", FIXTURE]);
    const summary = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(summary).toMatchObject({
      mode: "replay",
      sources: 2,
      alertsSent: 3,
      llmCalls: 0,
      costUsd: 0,
    });
  });
});
