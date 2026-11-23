import { describe, expect, it } from "vitest";
import type { ReminderKind } from "../src/db/store.js";
import {
  dueReminder,
  formatReminder,
  sendReminders,
  timeLeft,
  type ReminderDeps,
} from "../src/reminders.js";
import { FakeMessenger, TelegramError, type Messenger } from "../src/telegram.js";
import { NO_DETAILS, type ActionableEvent } from "../src/types.js";

const event: ActionableEvent = {
  ...NO_DETAILS,
  id: 7,
  status: "watching",
  source: "devpost",
  sourceId: "7",
  canonicalUrl: "https://robotics.example.org/",
  dedupeHash: null,
  title: "Robotics <Challenge>",
  organiser: null,
  type: "competition",
  startsAt: "2027-02-20T07:00:00.000Z",
  endsAt: "2027-02-22T16:00:00.000Z",
  timezone: "Europe/Athens",
  locationText: "Athens, Greece",
  isOnline: false,
  locationTier: "local",
  accessType: "application",
  registerUrl: "https://forms.example.org/apply",
  prizes: null,
  tags: [],
  unverifiedFields: [],
  // A date-only deadline: 31 Jan 23:59:59 Athens time.
  applyDeadline: "2027-01-31T21:59:59.000Z",
  // Results by 10 Feb: a date-only results date is stored at 00:00 Athens time.
  resultsDate: "2027-02-09T22:00:00.000Z",
  calendarEventId: null,
  calendarState: null,
};

const at = (iso: string): Date => new Date(iso);

describe("dueReminder", () => {
  it("is due from the start of the local day 3 days, then 1 day before the deadline, never after", () => {
    // Deadline 31 Jan (Athens): 3-day reminder from 28 Jan 00:00, 1-day from 30 Jan 00:00 Athens.
    expect(dueReminder(event, at("2027-01-27T21:59:59Z"))).toBeNull();
    expect(dueReminder(event, at("2027-01-27T22:00:00Z"))).toEqual({
      kind: "deadline_3d",
      dueAt: "2027-01-27T22:00:00.000Z",
    });
    expect(dueReminder(event, at("2027-01-30T05:00:00Z"))).toEqual({
      kind: "deadline_1d",
      dueAt: "2027-01-29T22:00:00.000Z",
    });
    expect(dueReminder(event, at("2027-01-31T21:59:58Z"))).toMatchObject({ kind: "deadline_1d" });
    expect(dueReminder(event, at("2027-01-31T21:59:59Z"))).toBeNull();
  });

  it("reaches a daily cron 3 days and 1 day before the deadline day, whatever its hour", () => {
    for (const hourUtc of [0, 5, 12, 21]) {
      const days: string[] = [];
      let lastKind: string | null = null;
      for (let day = 20; day <= 31; day++) {
        const now = at(`2027-01-${String(day)}T${String(hourUtc).padStart(2, "0")}:00:00Z`);
        const due = dueReminder(event, now);
        if (due !== null && due.kind !== lastKind) {
          days.push(`${String(day)} ${formatReminder(event, due.kind, now).split("\n")[1] ?? ""}`);
          lastKind = due.kind;
        }
      }
      // At 22:00 UTC and later it is already the next day in Athens: none of these hours are.
      expect(days).toEqual([
        "28 Applications close in 3 days: 31 Jan 2027 (Europe/Athens)",
        "30 Applications close tomorrow: 31 Jan 2027 (Europe/Athens)",
      ]);
    }
  });

  it("counts down to the start when there is no deadline", () => {
    const open = { ...event, accessType: "open" as const, applyDeadline: null };
    // Starts 20 Feb 09:00 Athens: due from 17 Feb 00:00 Athens.
    expect(dueReminder(open, at("2027-02-17T08:00:00Z"))).toEqual({
      kind: "deadline_3d",
      dueAt: "2027-02-16T22:00:00.000Z",
    });
    expect(dueReminder({ ...open, startsAt: null }, at("2027-02-17T08:00:00Z"))).toBeNull();
  });

  it("nudges awaiting_result events once the results date passes, until the event ends", () => {
    const applied = { ...event, status: "awaiting_result" };
    expect(dueReminder(applied, at("2027-02-10T12:00:00Z"))).toBeNull();
    // Due once 10 Feb is over in Athens.
    expect(dueReminder(applied, at("2027-02-10T21:59:59Z"))).toBeNull();
    expect(dueReminder(applied, at("2027-02-11T08:00:00Z"))).toEqual({
      kind: "results",
      dueAt: "2027-02-10T22:00:00.000Z",
    });
    expect(dueReminder(applied, at("2027-02-23T08:00:00Z"))).toBeNull();
    expect(dueReminder({ ...applied, resultsDate: null }, at("2027-02-11T08:00:00Z"))).toBeNull();
  });

  it("ignores every other status", () => {
    for (const status of ["new", "going", "dismissed", "accepted", "rejected"]) {
      expect(dueReminder({ ...event, status }, at("2027-01-31T09:00:00Z"))).toBeNull();
    }
  });
});

describe("formatReminder", () => {
  it("names the deadline, the time left and the apply link", () => {
    expect(formatReminder(event, "deadline_3d", at("2027-01-28T06:00:00Z"))).toBe(
      [
        "🔔 <b>Reminder: Robotics &lt;Challenge&gt;</b>",
        "Applications close in 3 days: 31 Jan 2027 (Europe/Athens)",
        '🔗 <a href="https://forms.example.org/apply">Apply</a>',
        'Source: <a href="https://robotics.example.org/">Devpost</a>',
      ].join("\n"),
    );
  });

  it("counts down to the start of an open event without a deadline", () => {
    const open = { ...event, accessType: "open" as const, applyDeadline: null };
    expect(formatReminder(open, "deadline_1d", at("2027-02-19T09:00:00Z"))).toContain(
      "Starts tomorrow: 20 Feb 2027, 09:00 (Europe/Athens)",
    );
    // Times the page didn't state are shown as dates.
    expect(
      formatReminder(
        { ...open, unverifiedFields: ["time"] },
        "deadline_1d",
        at("2027-02-19T09:00:00Z"),
      ),
    ).toContain("Starts tomorrow: 20 Feb 2027 (Europe/Athens)");
  });

  it("asks about results", () => {
    expect(
      formatReminder(
        { ...event, status: "awaiting_result" },
        "results",
        at("2027-02-11T08:00:00Z"),
      ),
    ).toBe(
      [
        "📬 <b>Did you get results? Robotics &lt;Challenge&gt;</b>",
        "Results were due 10 Feb 2027. Tap Accepted or Rejected to update it.",
        'Source: <a href="https://robotics.example.org/">Devpost</a>',
      ].join("\n"),
    );
  });

  it("counts the time left in calendar days of the event's zone", () => {
    const deadline = "2027-01-31T21:59:59.000Z"; // 31 Jan, 23:59:59 Athens
    expect(timeLeft(deadline, at("2027-01-28T06:00:00Z"), "Europe/Athens")).toBe("in 3 days");
    expect(timeLeft(deadline, at("2027-01-30T23:00:00Z"), "Europe/Athens")).toBe("today");
    expect(timeLeft(deadline, at("2027-01-30T21:00:00Z"), "Europe/Athens")).toBe("tomorrow");
  });
});

type ReminderStore = ReminderDeps["store"];

/** In-memory reminders table, enough to check claim handling. */
class FakeReminders implements ReminderStore {
  readonly rows = new Map<string, { id: number; sentAt: Date | null }>();
  constructor(private readonly events: ActionableEvent[]) {}
  eventsForReminders(): Promise<ActionableEvent[]> {
    return Promise.resolve(this.events);
  }
  claimReminder(eventId: number, kind: ReminderKind, dueAt: string): Promise<number | null> {
    const key = `${String(eventId)} ${kind} ${dueAt}`;
    if (this.rows.has(key)) return Promise.resolve(null);
    const id = this.rows.size + 1;
    this.rows.set(key, { id, sentAt: null });
    return Promise.resolve(id);
  }
  completeReminder(
    id: number,
    _e: number,
    _k: ReminderKind,
    _c: string,
    _m: number,
    sentAt: Date,
  ): Promise<void> {
    for (const row of this.rows.values()) if (row.id === id) row.sentAt = sentAt;
    return Promise.resolve();
  }
  releaseReminder(id: number): Promise<void> {
    for (const [key, row] of this.rows) if (row.id === id) this.rows.delete(key);
    return Promise.resolve();
  }
}

describe("sendReminders", () => {
  const now = at("2027-01-31T09:00:00Z");
  const second = { ...event, id: 8, canonicalUrl: "https://other.example.org/" };

  it("sends each due reminder once, with the event's buttons", async () => {
    const store = new FakeReminders([event, second]);
    const messenger = new FakeMessenger();
    const errors: string[] = [];
    expect(await sendReminders({ store, messenger, now: () => now }, errors)).toBe(2);
    expect(await sendReminders({ store, messenger, now: () => now }, errors)).toBe(0);
    expect(errors).toEqual([]);
    expect(messenger.sent.map((m) => m.keyboard?.map((row) => row.map((b) => b.text)))).toEqual([
      [["🔔 Reminders on"], ["✍️ I applied", "🙅 Not interested"]],
      [["🔔 Reminders on"], ["✍️ I applied", "🙅 Not interested"]],
    ]);
  });

  it("releases the claim and stops on a Telegram outage; keeps it after a timeout", async () => {
    const store = new FakeReminders([event, second]);
    const errors: string[] = [];
    const down: Messenger = {
      chatId: "c",
      send: () => Promise.reject(new TelegramError("telegram down", "systemic")),
    };
    expect(await sendReminders({ store, messenger: down, now: () => now }, errors)).toBe(0);
    expect(store.rows.size).toBe(0);
    expect(errors).toEqual(["reminder for event 7: telegram down"]);

    const timeout: Messenger = {
      chatId: "c",
      send: () => Promise.reject(new TelegramError("timed out", "unknown")),
    };
    await sendReminders({ store, messenger: timeout, now: () => now }, errors);
    // Both kept (may have been delivered): never sent again.
    expect(store.rows.size).toBe(2);
    const messenger = new FakeMessenger();
    expect(await sendReminders({ store, messenger, now: () => now }, errors)).toBe(0);
  });
});
