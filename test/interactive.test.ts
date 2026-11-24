import { describe, expect, it } from "vitest";
import { keyboardFor, type ButtonEvent } from "../src/buttons.js";
import {
  calendarEntryFor,
  calendarEntryId,
  CalendarError,
  FakeCalendar,
  GoogleCalendar,
  type CalendarEntry,
  type CalendarWriter,
} from "../src/calendar.js";
import { parseCriteria } from "../src/config.js";
import { createClient, type Client } from "@libsql/client";
import { LibsqlStore, SchemaMismatchError } from "../src/db/store.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizeItem } from "../src/normalize.js";
import { SETTING_TENTATIVE_HOLD } from "../src/settings.js";
import { decodePress, encodePress, type Press } from "../src/status.js";
import { FakeCallbackApi, TelegramCallbackApi, setWebhook } from "../src/telegram.js";
import type { SourceItem } from "../src/types.js";
import { handleWebhook, type WebhookDeps } from "../src/webhook.js";

const criteria = parseCriteria(`
profile: x
interests: [AI]
eventTypes: [hackathon]
home: { city: Athens, country: Greece, timezone: Europe/Athens }
sources: [{ kind: devpost }]
`);
const now = new Date("2026-12-01T09:00:00Z");
const SECRET = "test-secret-0123456789";
const CHAT = "4242";

const item: SourceItem = {
  source: "devpost",
  sourceId: "1",
  url: "https://a.devpost.com/",
  title: "AI Hackathon",
  organiser: "Org",
  type: "hackathon",
  startDate: "2026-12-10",
  endDate: "2026-12-12",
  locationText: "Online",
  isOnline: true,
  accessType: "open",
  registerUrl: "https://a.devpost.com/register",
  prizes: null,
  tags: [],
  unverifiedFields: [],
};

function texts(keyboard: { text: string }[][]): string[][] {
  return keyboard.map((row) => row.map((button) => button.text));
}

describe("callback data", () => {
  it("round-trips every press and rejects anything else", () => {
    const presses: Press[] = [
      { kind: "status", action: "going", eventId: 1 },
      { kind: "status", action: "remind", eventId: 22 },
      { kind: "status", action: "dismiss", eventId: 3 },
      { kind: "status", action: "applied", eventId: 4 },
      { kind: "status", action: "accepted", eventId: 5 },
      { kind: "status", action: "rejected", eventId: 6 },
      { kind: "reason", reason: "location", eventId: 7 },
      { kind: "calendar", eventId: 8 },
      { kind: "info", eventId: 9 },
    ];
    for (const press of presses) {
      const data = encodePress(press);
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      expect(decodePress(data)).toEqual(press);
    }
    for (const bad of ["", "g", "g:", "g:0", "g:01", "q:1", "g:1:t", "w:1", "w:1:z", "g:1;drop"]) {
      expect(decodePress(bad)).toBeNull();
    }
  });
});

describe("buttons per status", () => {
  const base: ButtonEvent = {
    id: 1,
    status: "new",
    accessType: "open",
    startsAt: "2026-12-10T00:00:00Z",
    endsAt: "2026-12-12T00:00:00Z",
    calendarState: null,
    calendarEventId: null,
  };

  it("follows the SPEC status machine", () => {
    expect(texts(keyboardFor(base, null))).toEqual([
      ["✅ Going", "🔔 Remind me"],
      ["🙅 Not interested"],
    ]);
    expect(texts(keyboardFor({ ...base, accessType: "application" }, null))).toEqual([
      ["✍️ I applied", "🔔 Remind me"],
      ["🙅 Not interested"],
    ]);
    expect(texts(keyboardFor({ ...base, status: "watching" }, null))).toEqual([
      ["🔔 Reminders on"],
      ["✅ Going", "🙅 Not interested"],
    ]);
    expect(texts(keyboardFor({ ...base, status: "awaiting_result" }, null))).toEqual([
      ["⏳ Applied · waiting for results"],
      ["🎉 Accepted", "❌ Rejected"],
    ]);
    expect(texts(keyboardFor({ ...base, status: "rejected" }, null))).toEqual([["❌ Rejected"]]);
    // No "why?" buttons any more: the answers weren't used for anything.
    expect(texts(keyboardFor({ ...base, status: "dismissed" }, null))).toEqual([
      ["🙅 Not interested"],
    ]);
    // A reason given on an older message (whose buttons still work) is still shown.
    expect(texts(keyboardFor({ ...base, status: "dismissed" }, "dates"))).toEqual([
      ["🙅 Not interested · Dates"],
    ]);
    expect(texts(keyboardFor({ ...base, status: "below_threshold" }, null))).toEqual([]);
  });

  it("offers a calendar retry only for going/accepted events with dates and no confirmed entry", () => {
    const going = { ...base, status: "going" };
    expect(texts(keyboardFor(going, null))).toEqual([["✅ Going"], ["📅 Add to calendar"]]);
    expect(texts(keyboardFor({ ...going, calendarState: "confirmed" }, null))).toEqual([
      ["✅ Going"],
    ]);
    expect(texts(keyboardFor({ ...going, startsAt: null }, null))).toEqual([["✅ Going"]]);
    // Accepted after a tentative hold: the hold still needs confirming.
    expect(
      texts(keyboardFor({ ...base, status: "accepted", calendarState: "tentative" }, null)),
    ).toEqual([["🎉 Accepted"], ["📅 Add to calendar"]]);
  });
});

describe("calendar entries", () => {
  const event = {
    canonicalUrl: "https://a.devpost.com/",
    title: "AI Hackathon",
    startsAt: "2026-12-10T16:00:00.000Z",
    endsAt: "2026-12-12T15:00:00.000Z",
    timezone: "Europe/Athens",
    isOnline: false,
    locationText: "Athens, Greece",
    registerUrl: "https://a.devpost.com/register",
    unverifiedFields: [] as string[],
  };

  it("uses a stable base32hex id per URL", async () => {
    const id = await calendarEntryId(event.canonicalUrl);
    expect(id).toMatch(/^ea[0-9a-v]{26}$/);
    expect(await calendarEntryId(event.canonicalUrl)).toBe(id);
    expect(await calendarEntryId("https://b.devpost.com/")).not.toBe(id);
  });

  it("writes timed entries in the event's zone, and date-only events as all-day", async () => {
    expect(await calendarEntryFor(event, "confirmed")).toMatchObject({
      summary: "AI Hackathon",
      location: "Athens, Greece",
      state: "confirmed",
      start: { dateTime: "2026-12-10T16:00:00.000Z", timeZone: "Europe/Athens" },
      end: { dateTime: "2026-12-12T15:00:00.000Z", timeZone: "Europe/Athens" },
      description:
        "Register / apply: https://a.devpost.com/register\nDetails: https://a.devpost.com/\nAdded by Hackscout.",
    });
    // Stored as local midnight → 23:59:59; the end date is exclusive in Google.
    const dateOnly = {
      ...event,
      startsAt: "2026-12-30T22:00:00.000Z",
      endsAt: "2026-12-31T21:59:59.000Z",
      unverifiedFields: ["time"],
    };
    expect(await calendarEntryFor(dateOnly, "tentative")).toMatchObject({
      summary: "Applied: AI Hackathon",
      state: "tentative",
      start: { date: "2026-12-31" },
      end: { date: "2027-01-01" },
    });
    expect(await calendarEntryFor({ ...event, startsAt: null }, "confirmed")).toBeNull();
  });
});

describe("GoogleCalendar writes", () => {
  const credentials = { clientId: "id", clientSecret: "secret", refreshToken: "refresh" };
  const entry: CalendarEntry = {
    id: "ea0123456789abcdefghijklmn",
    summary: "AI Hackathon",
    description: "d",
    location: "Online",
    state: "confirmed",
    start: { dateTime: "2026-12-10T16:00:00.000Z", timeZone: "Europe/Athens" },
    end: { dateTime: "2026-12-12T15:00:00.000Z", timeZone: "Europe/Athens" },
  };

  function fakeGoogle(respond: (method: string, url: string) => Response): {
    fetchFn: typeof fetch;
    calls: { method: string; url: string; body: unknown }[];
  } {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = init?.method ?? "GET";
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return Promise.resolve(Response.json({ access_token: "at", expires_in: 3600 }));
      }
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      calls.push({ method, url, body });
      return Promise.resolve(respond(method, url));
    };
    return { fetchFn, calls };
  }

  it("inserts into the primary calendar with the entry's id", async () => {
    const google = fakeGoogle(() => Response.json({ id: entry.id }));
    await new GoogleCalendar(credentials, ["primary"], google.fetchFn).upsert(entry);
    expect(google.calls).toEqual([
      {
        method: "POST",
        url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        body: {
          id: entry.id,
          summary: "AI Hackathon",
          description: "d",
          location: "Online",
          start: entry.start,
          end: entry.end,
          status: "confirmed",
        },
      },
    ]);
  });

  it("updates in place when the id already exists (double press, hold → confirmed)", async () => {
    const google = fakeGoogle((method) =>
      method === "POST"
        ? Response.json({ error: { code: 409 } }, { status: 409 })
        : Response.json({}),
    );
    await new GoogleCalendar(credentials, ["primary"], google.fetchFn).upsert(entry);
    expect(google.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://www.googleapis.com/calendar/v3/calendars/primary/events",
      `PUT https://www.googleapis.com/calendar/v3/calendars/primary/events/${entry.id}`,
    ]);
    // A full replacement, so all-day ↔ timed changes don't merge into an invalid start/end.
    expect(google.calls[1]?.body).toMatchObject({ start: entry.start, end: entry.end });
    expect(google.calls[1]?.body).not.toHaveProperty("id");
  });

  it("treats an already-deleted entry as removed, and reports other failures", async () => {
    const gone = fakeGoogle(() => new Response(null, { status: 410 }));
    await new GoogleCalendar(credentials, ["primary"], gone.fetchFn).remove(entry.id);
    expect(gone.calls.map((c) => c.method)).toEqual(["DELETE"]);

    const down = fakeGoogle(() => new Response("oops", { status: 503 }));
    const calendar = new GoogleCalendar(credentials, ["primary"], down.fetchFn);
    await expect(calendar.upsert(entry)).rejects.toThrow("google calendar insert: HTTP 503");
    await expect(calendar.remove(entry.id)).rejects.toThrow("google calendar delete: HTTP 503");
  });
});

describe("TelegramCallbackApi", () => {
  function fakeTelegram(reply: unknown): {
    fetchFn: typeof fetch;
    calls: { url: string; body: unknown }[];
  } {
    const calls: { url: string; body: unknown }[] = [];
    const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({
        url: input instanceof Request ? input.url : input.toString(),
        body: JSON.parse(typeof init?.body === "string" ? init.body : "null") as unknown,
      });
      return Promise.resolve(Response.json(reply));
    };
    return { fetchFn, calls };
  }

  it("answers presses and edits buttons", async () => {
    const telegram = fakeTelegram({ ok: true, result: true });
    const api = new TelegramCallbackApi("TOKEN", telegram.fetchFn);
    await api.answer("q1", "Saved.");
    await api.editButtons("4242", 7, [[{ text: "✅ Going", data: "i:1" }]]);
    expect(telegram.calls).toEqual([
      {
        url: "https://api.telegram.org/botTOKEN/answerCallbackQuery",
        body: { callback_query_id: "q1", text: "Saved." },
      },
      {
        url: "https://api.telegram.org/botTOKEN/editMessageReplyMarkup",
        body: {
          chat_id: "4242",
          message_id: 7,
          reply_markup: { inline_keyboard: [[{ text: "✅ Going", callback_data: "i:1" }]] },
        },
      },
    ]);
  });

  it("ignores 'message is not modified' and never leaks the token in errors", async () => {
    const same = fakeTelegram({
      ok: false,
      description: "Bad Request: message is not modified: specified new message content",
    });
    await new TelegramCallbackApi("TOKEN", same.fetchFn).editButtons("1", 1, []);

    const bad = fakeTelegram({ ok: false, description: "Bad Request: chat not found" });
    const error = await new TelegramCallbackApi("SECRET", bad.fetchFn)
      .editButtons("1", 1, [])
      .catch((e: unknown) => e);
    expect(String(error)).toContain("chat not found");
    expect(String(error)).not.toContain("SECRET");
  });

  it("sets the webhook for button presses only, with the secret token", async () => {
    const telegram = fakeTelegram({ ok: true, result: true });
    await setWebhook("TOKEN", "https://w.example.workers.dev/", SECRET, telegram.fetchFn);
    expect(telegram.calls[0]?.body).toEqual({
      url: "https://w.example.workers.dev/",
      secret_token: SECRET,
      allowed_updates: ["callback_query"],
    });
  });
});

/** A store with one alerted event, and webhook deps around it. */
async function setup(
  overrides: Partial<SourceItem> = {},
  calendar: CalendarWriter = new FakeCalendar([]),
): Promise<{
  store: LibsqlStore;
  client: Client;
  deps: WebhookDeps;
  telegram: FakeCallbackApi;
  logs: string[];
  press: (data: string, chatId?: number) => Promise<Response>;
}> {
  const client = createClient({ url: ":memory:" });
  const store = new LibsqlStore(client);
  await store.migrate();
  await store.insertIfNew(normalizeItem({ ...item, ...overrides }, criteria), "new", now);
  const telegram = new FakeCallbackApi();
  const logs: string[] = [];
  const deps: WebhookDeps = {
    store,
    telegram,
    calendar,
    chatId: CHAT,
    secret: SECRET,
    now: () => now,
    log: (line) => logs.push(line),
  };
  let updateId = 0;
  const press = (data: string, chatId = Number(CHAT)): Promise<Response> =>
    handleWebhook(callbackRequest(++updateId, data, chatId), deps);
  return { store, client, deps, telegram, logs, press };
}

function callbackRequest(updateId: number, data: string, chatId: number, secret = SECRET): Request {
  return new Request("https://worker.example/", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({
      update_id: updateId,
      callback_query: {
        id: `q${String(updateId)}`,
        data,
        from: { id: chatId },
        message: { message_id: 7, chat: { id: chatId } },
      },
    }),
  });
}

describe("webhook", () => {
  it("refuses requests without the secret and presses from other chats", async () => {
    const { store, deps, telegram, press } = await setup();
    try {
      const forged = await handleWebhook(callbackRequest(1, "g:1", Number(CHAT), "wrong"), deps);
      expect(forged.status).toBe(401);
      const get = await handleWebhook(new Request("https://worker.example/"), deps);
      expect(get.status).toBe(405);

      expect((await press("g:1", 999)).status).toBe(200);
      expect(telegram.answers.at(-1)?.text).toBe("Not allowed.");
      expect((await press("garbage")).status).toBe(200);
      expect(telegram.answers.at(-1)?.text).toBe("Unknown button.");
      expect((await store.getEvent(1))?.status).toBe("new");
      expect(telegram.edits).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("ignores updates that aren't button presses", async () => {
    const { store, deps } = await setup();
    try {
      const request = new Request("https://worker.example/", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify({ update_id: 1, message: { text: "hi" } }),
      });
      expect((await handleWebhook(request, deps)).status).toBe(200);
    } finally {
      store.close();
    }
  });

  it("Remind me → watching, then Not interested with an optional reason", async () => {
    const { store, telegram, press } = await setup();
    try {
      await press("r:1");
      expect((await store.getEvent(1))?.status).toBe("watching");
      expect(texts(telegram.edits.at(-1)?.keyboard ?? [])).toEqual([
        ["🔔 Reminders on"],
        ["✅ Going", "🙅 Not interested"],
      ]);
      // Remind me again (an old copy of the buttons) changes nothing.
      await press("r:1");
      expect(telegram.answers.at(-1)?.text).toBe("Already reminders on.");

      await press("d:1");
      expect((await store.getEvent(1))?.status).toBe("dismissed");
      await press("w:1:p");
      expect(await store.latestReason(1, "dismiss_reason")).toBe("location");
      expect(texts(telegram.edits.at(-1)?.keyboard ?? [])).toEqual([
        ["🙅 Not interested · Location"],
      ]);
      expect(telegram.answers.at(-1)?.text).toBe("Noted: Location.");
    } finally {
      store.close();
    }
  });

  it("keeps the status when the calendar write fails, and offers a retry that works", async () => {
    let fail = true;
    const fake = new FakeCalendar([]);
    const flaky: CalendarWriter = {
      upsert: (entry) =>
        fail
          ? Promise.reject(new CalendarError("google calendar insert: HTTP 503"))
          : fake.upsert(entry),
      remove: (id) => fake.remove(id),
    };
    const { store, telegram, logs, press } = await setup({}, flaky);
    try {
      await press("g:1");
      expect((await store.getEvent(1))?.status).toBe("going");
      expect(telegram.answers.at(-1)?.text).toBe(
        "Saved: going. Couldn't add it to your calendar (google calendar insert: HTTP 503).",
      );
      expect(logs).toEqual(["calendar write for event 1: google calendar insert: HTTP 503"]);
      expect(texts(telegram.edits.at(-1)?.keyboard ?? [])).toEqual([
        ["✅ Going"],
        ["📅 Add to calendar"],
      ]);

      fail = false;
      await press("c:1");
      expect(telegram.answers.at(-1)?.text).toBe("Added to your calendar.");
      expect(await store.getEvent(1)).toMatchObject({ calendarState: "confirmed" });
      expect(texts(telegram.edits.at(-1)?.keyboard ?? [])).toEqual([["✅ Going"]]);
      expect(fake.writes).toHaveLength(1);
      // The retry button on an old copy of the message does nothing now.
      await press("c:1");
      expect(fake.writes).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("with tentativeHoldOnApply: holds on apply, confirms the same entry on accept", async () => {
    const calendar = new FakeCalendar([]);
    const { store, press } = await setup({ accessType: "application" }, calendar);
    try {
      await store.saveSetting(SETTING_TENTATIVE_HOLD, "true", now);
      await press("a:1");
      const held = await store.getEvent(1);
      expect(held).toMatchObject({ status: "awaiting_result", calendarState: "tentative" });
      await press("y:1");
      expect(await store.getEvent(1)).toMatchObject({
        status: "accepted",
        calendarState: "confirmed",
        calendarEventId: held?.calendarEventId,
      });
      expect(calendar.writes.map((w) => (w.op === "upsert" ? w.entry.summary : w.op))).toEqual([
        "Applied: AI Hackathon",
        "AI Hackathon",
      ]);
      expect(calendar.entries.size).toBe(1);
    } finally {
      store.close();
    }
  });

  it("with tentativeHoldOnApply: removes the hold on reject", async () => {
    const calendar = new FakeCalendar([]);
    const { store, press } = await setup({ accessType: "application" }, calendar);
    try {
      await store.saveSetting(SETTING_TENTATIVE_HOLD, "true", now);
      await press("a:1");
      await press("n:1");
      expect(await store.getEvent(1)).toMatchObject({
        status: "rejected",
        calendarEventId: null,
        calendarState: null,
      });
      expect(calendar.entries.size).toBe(0);
    } finally {
      store.close();
    }
  });

  it("answers the press even when the database is down, without changing anything", async () => {
    const { store, deps, telegram, logs } = await setup();
    try {
      const down = new Proxy(store, {
        get: (target, prop, receiver): unknown =>
          prop === "getEvent"
            ? () => Promise.reject(new Error("turso 503"))
            : Reflect.get(target, prop, receiver),
      });
      const broken: WebhookDeps = { ...deps, store: down };
      const response = await handleWebhook(callbackRequest(1, "g:1", Number(CHAT)), broken);
      expect(response.status).toBe(200);
      expect(telegram.answers.at(-1)?.text).toBe("Couldn't save that, please try again.");
      expect(logs).toEqual(["press g:1: turso 503"]);
    } finally {
      store.close();
    }
  });

  it("records each status change once in the actions log, even for concurrent presses", async () => {
    const { store, client, press } = await setup();
    try {
      await Promise.all([press("g:1"), press("g:1"), press("d:1")]);
      const event = await store.getEvent(1);
      expect(["going", "dismissed"]).toContain(event?.status);
      // Exactly one of the three presses moved it, and only that one is logged.
      const actions = await client.execute("SELECT action FROM actions WHERE event_id = 1");
      expect(actions.rows.map((row) => row["action"])).toEqual([
        event?.status === "going" ? "going" : "dismiss",
      ]);
      expect(await store.transitionStatus(1, "new", "going", "going", now)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("logs only the first reason, however often reason buttons are pressed", async () => {
    const { store, client, telegram, press } = await setup();
    try {
      await press("d:1");
      await Promise.all([press("w:1:t"), press("w:1:t"), press("w:1:c")]);
      const rows = await client.execute(
        "SELECT reason FROM actions WHERE event_id = 1 AND action = 'dismiss_reason'",
      );
      expect(rows.rows).toHaveLength(1);
      expect(telegram.answers.filter((a) => a.text === "Reason already noted.")).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("on reject, deletes the hold by its id even if it was never stored, and retries a failed delete", async () => {
    let fail = true;
    const removed: string[] = [];
    const calendar: CalendarWriter = {
      // The hold insert "times out" after Google made it: nothing is stored.
      upsert: () => Promise.reject(new CalendarError("google calendar insert: timed out")),
      remove: (id) => {
        if (fail) return Promise.reject(new CalendarError("google calendar delete: HTTP 503"));
        removed.push(id);
        return Promise.resolve();
      },
    };
    const { store, telegram, press } = await setup({ accessType: "application" }, calendar);
    try {
      await store.saveSetting(SETTING_TENTATIVE_HOLD, "true", now);
      await press("a:1");
      expect(await store.getEvent(1)).toMatchObject({ calendarEventId: null });
      await press("n:1");
      const id = await calendarEntryId(item.url);
      expect(await store.getEvent(1)).toMatchObject({ status: "rejected", calendarEventId: id });
      expect(texts(telegram.edits.at(-1)?.keyboard ?? [])).toEqual([
        ["❌ Rejected"],
        ["🗑 Remove calendar hold"],
      ]);
      fail = false;
      await press("c:1");
      expect(removed).toEqual([id]);
      expect(telegram.answers.at(-1)?.text).toBe("Calendar hold removed.");
      expect(await store.getEvent(1)).toMatchObject({ calendarEventId: null });
      expect(texts(telegram.edits.at(-1)?.keyboard ?? [])).toEqual([["❌ Rejected"]]);
    } finally {
      store.close();
    }
  });

  it("checks the schema only for authentic requests: mismatch → 500, DB down → toast", async () => {
    const { store, deps, telegram } = await setup();
    try {
      let checks = 0;
      const mismatch: WebhookDeps = {
        ...deps,
        checkSchema: () => {
          checks++;
          return Promise.reject(new SchemaMismatchError("version 4"));
        },
      };
      const forged = await handleWebhook(callbackRequest(1, "g:1", Number(CHAT), "x"), mismatch);
      expect(forged.status).toBe(401);
      expect(checks).toBe(0);
      expect((await handleWebhook(callbackRequest(2, "g:1", Number(CHAT)), mismatch)).status).toBe(
        500,
      );
      const down: WebhookDeps = {
        ...deps,
        checkSchema: () => Promise.reject(new Error("turso 503")),
      };
      expect((await handleWebhook(callbackRequest(3, "g:1", Number(CHAT)), down)).status).toBe(200);
      expect(telegram.answers.at(-1)?.text).toBe("Couldn't save that, please try again.");
      expect((await store.getEvent(1))?.status).toBe("new");
    } finally {
      store.close();
    }
  });
});

describe("worker bundle", () => {
  it("reaches no Node-only modules from worker/index.ts", async () => {
    const seen = new Set<string>();
    const nodeImports: string[] = [];
    const visit = async (file: string): Promise<void> => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/^(?:import|export)\b[^;]*?"([^"]+)";/gm)) {
        const spec = match[1] ?? "";
        if (spec.startsWith("node:")) nodeImports.push(`${file}: ${spec}`);
        else if (spec.startsWith(".")) {
          await visit(join(dirname(file), spec.replace(/\.js$/, ".ts")));
        }
      }
    };
    await visit("worker/index.ts");
    expect(seen.has("src/webhook.ts")).toBe(true);
    expect(nodeImports).toEqual([]);
  });

  it("refuses to run without the Google credentials (required in production)", async () => {
    const { default: worker } = await import("../worker/index.js");
    const env = {
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_CHAT_ID: CHAT,
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      TURSO_DATABASE_URL: "libsql://unused.invalid",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    };
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(...args);
    };
    try {
      const response = await worker.fetch(callbackRequest(1, "g:1", Number(CHAT)), env);
      expect(response.status).toBe(500);
    } finally {
      console.error = original;
    }
    expect(errors).toEqual(["worker misconfigured: missing GOOGLE_REFRESH_TOKEN"]);
  });
});
