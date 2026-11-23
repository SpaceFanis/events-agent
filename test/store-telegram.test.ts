import { describe, expect, it } from "vitest";
import { parseCriteria } from "../src/config.js";
import { createClient } from "@libsql/client";
import { LibsqlStore, openStore } from "../src/db/store.js";
import { normalizeItem } from "../src/normalize.js";
import { TelegramError, TelegramMessenger } from "../src/telegram.js";
import type { SourceItem } from "../src/types.js";

const criteria = parseCriteria(`
profile: x
interests: [AI]
eventTypes: [hackathon]
home: { city: Athens, country: Greece, timezone: Europe/Athens }
sources: [{ kind: devpost }]
`);

const base: SourceItem = {
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
  registerUrl: "https://a.devpost.com/",
  prizes: "$5",
  tags: ["AI"],
  unverifiedFields: ["access"],
};
const now = new Date("2026-12-01T09:00:00Z");

describe("LibsqlStore", () => {
  it("inserts once per URL, dedupe hash or source id, and round-trips events", async () => {
    const store = await openStore(":memory:");
    await store.migrate(); // idempotent
    const event = normalizeItem(base, criteria);

    const id = await store.insertIfNew(event, "new", now);
    expect(id).toBe(1);
    expect(await store.insertIfNew(event, "new", now)).toBeNull();
    // Same event listed under another URL and id: caught by the title/date/organiser hash.
    const relisted = normalizeItem(
      { ...base, sourceId: "2", url: "https://b.example.com/x" },
      criteria,
    );
    expect(await store.insertIfNew(relisted, "new", now)).toBeNull();

    const pending = await store.eventsAwaitingAlert(now, 3, 10);
    expect(pending).toEqual([{ ...event, id: 1, status: "new" }]);

    const claim = await store.claimAlert(1, "c", now);
    expect(claim).not.toBeNull();
    // An overlapping run cannot claim the same alert.
    expect(await store.claimAlert(1, "c", now)).toBeNull();
    expect(await store.eventsAwaitingAlert(now, 3, 10)).toEqual([]);
    store.close();
  });

  it("does not dedupe on title alone when the start date is unknown", async () => {
    const store = await openStore(":memory:");
    const undated = { ...base, startDate: null, endDate: null, organiser: null };
    expect(await store.insertIfNew(normalizeItem(undated, criteria), "new", now)).not.toBeNull();
    const other = { ...undated, sourceId: "2", url: "https://other.devpost.com/" };
    expect(await store.insertIfNew(normalizeItem(other, criteria), "new", now)).not.toBeNull();
    store.close();
  });

  it("stops offering alerts for ended events, after max failed attempts, and beyond the limit", async () => {
    const store = await openStore(":memory:");
    const ended = {
      ...base,
      sourceId: "e",
      url: "https://e.devpost.com/",
      title: "Ended",
      endDate: "2026-11-30",
    };
    const failing = { ...base, sourceId: "f", url: "https://f.devpost.com/", title: "Failing" };
    const extra = { ...base, sourceId: "x", url: "https://x.devpost.com/", title: "Extra" };
    for (const item of [ended, failing, extra])
      await store.insertIfNew(normalizeItem(item, criteria), "new", now);

    const titles = async (limit: number) =>
      (await store.eventsAwaitingAlert(now, 2, limit)).map((e) => e.title);
    expect(await titles(10)).toEqual(["Failing", "Extra"]);
    expect(await titles(1)).toEqual(["Failing"]);

    for (let attempt = 0; attempt < 2; attempt++) {
      const claim = await store.claimAlert(2, "c", now);
      if (claim === null) throw new Error("claim failed");
      await store.releaseAlert(claim, 2, true);
    }
    expect(await titles(10)).toEqual(["Extra"]);
    store.close();
  });
});

describe("TelegramMessenger", () => {
  it("posts HTML to sendMessage and returns the message id", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      if (typeof input !== "string" || typeof init?.body !== "string")
        throw new Error("unexpected fetch args");
      calls.push({ url: input, body: JSON.parse(init.body) });
      return Promise.resolve(Response.json({ ok: true, result: { message_id: 42 } }));
    };
    const sent = await new TelegramMessenger("TOKEN", "123", fakeFetch).send("<b>hi</b>");
    expect(sent).toEqual({ chatId: "123", messageId: 42 });
    expect(calls[0]?.url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect(calls[0]?.body).toMatchObject({ chat_id: "123", text: "<b>hi</b>", parse_mode: "HTML" });
  });

  it("throws Telegram's description without leaking the token", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 }),
      );
    const send = new TelegramMessenger("SECRET", "123", fakeFetch).send("x");
    await expect(send).rejects.toThrow("telegram sendMessage failed: Bad Request: chat not found");
    await expect(send).rejects.not.toThrow(/SECRET/);
  });

  it("paces sends and waits out a short 429 once", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const sleep = (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    };
    const responses = [
      Response.json({ ok: true, result: { message_id: 1 } }),
      Response.json(
        {
          ok: false,
          description: "Too Many Requests: retry after 3",
          parameters: { retry_after: 3 },
        },
        { status: 429 },
      ),
      Response.json({ ok: true, result: { message_id: 2 } }),
    ];
    const fakeFetch: typeof fetch = () => {
      const next = responses.shift();
      return next === undefined
        ? Promise.reject(new Error("no more responses"))
        : Promise.resolve(next);
    };
    const messenger = new TelegramMessenger("T", "1", fakeFetch, sleep, () => clock);

    expect((await messenger.send("a")).messageId).toBe(1);
    expect((await messenger.send("b")).messageId).toBe(2);
    // 1.1 s gap before the 2nd post, 3 s back-off, then 1.1 s gap is already covered by the back-off.
    expect(sleeps).toEqual([1100, 3000]);
  });

  it("does not wait out long 429 back-offs", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        Response.json({
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: 600 },
        }),
      );
    const messenger = new TelegramMessenger("T", "1", fakeFetch, () => Promise.resolve());
    await expect(messenger.send("x")).rejects.toThrow(/Too Many Requests/);
  });

  it.each([
    [400, "Bad Request: can't parse entities", "message"],
    [400, "Bad Request: message is too long", "message"],
    [400, "Bad Request: chat not found", "systemic"],
    [400, "Bad Request: not enough rights to send text messages to the chat", "systemic"],
    [400, "Bad Request: group chat was upgraded to a supergroup chat", "systemic"],
    [401, "Unauthorized", "systemic"],
    [500, "Internal Server Error", "systemic"],
  ] as const)("classifies HTTP %i %s as %s", async (status, description, failure) => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(Response.json({ ok: false, description }, { status }));
    const error: unknown = await new TelegramMessenger("T", "1", fakeFetch)
      .send("x")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect((error as TelegramError).failure).toBe(failure);
  });

  it("treats a timeout as unknown delivery and a connection error as systemic", async () => {
    const timeout: typeof fetch = () =>
      Promise.reject(new DOMException("timed out", "TimeoutError"));
    const refused: typeof fetch = () => Promise.reject(new TypeError("fetch failed"));
    await expect(new TelegramMessenger("T", "1", timeout).send("x")).rejects.toMatchObject({
      failure: "unknown",
    });
    await expect(new TelegramMessenger("T", "1", refused).send("x")).rejects.toMatchObject({
      failure: "systemic",
    });
  });

  it("treats an unreadable 2xx body as unknown delivery and an unreadable 5xx as systemic", async () => {
    const ok: typeof fetch = () => Promise.resolve(new Response("<html>", { status: 200 }));
    const bad: typeof fetch = () => Promise.resolve(new Response("<html>", { status: 502 }));
    await expect(new TelegramMessenger("T", "1", ok).send("x")).rejects.toMatchObject({
      failure: "unknown",
    });
    await expect(new TelegramMessenger("T", "1", bad).send("x")).rejects.toMatchObject({
      failure: "systemic",
    });
  });

  it("throws when a 429 repeats after the back-off", async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        Response.json(
          { ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } },
          { status: 429 },
        ),
      );
    const messenger = new TelegramMessenger("T", "1", fakeFetch, () => Promise.resolve());
    await expect(messenger.send("x")).rejects.toMatchObject({ failure: "systemic" });
  });
});

describe("migrate", () => {
  it("refuses a database with an unknown schema version", async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute("PRAGMA user_version = 99");
    await expect(new LibsqlStore(client).migrate()).rejects.toThrow(/schema is version 99/);
    client.close();
  });

  it("refuses an unversioned database that already has tables", async () => {
    const client = createClient({ url: ":memory:" });
    await client.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY)");
    await expect(new LibsqlStore(client).migrate()).rejects.toThrow(
      /no schema version \(messages\)/,
    );
    client.close();
  });
});
