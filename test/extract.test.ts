import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { parseCriteria } from "../src/config.js";
import { LibsqlStore } from "../src/db/store.js";
import { SCHEMA } from "../src/db/schema.js";
import { LlmBudget, monthStart } from "../src/enrich.js";
import { formatAlert } from "../src/alert.js";
import {
  decideStatus,
  evidenceMatchesDate,
  linkIsTrusted,
  parseExtraction,
  parseLocal,
  validateExtraction,
  worthEscalating,
  type Extraction,
} from "../src/extract.js";
import { costUsd, HAIKU, SONNET, worstCaseCostUsd } from "../src/llm.js";
import { normalizeItem } from "../src/normalize.js";
import { decodeEntities, MAX_PAGE_CHARS, readPage } from "../src/page.js";
import { NO_DETAILS, type SourceItem, type StoredEvent } from "../src/types.js";

const criteria = parseCriteria(`
profile: x
interests: [AI]
eventTypes: [hackathon]
home: { city: Athens, country: Greece, timezone: Europe/Athens }
sources: [{ kind: devpost }]
`);
const now = new Date("2026-12-01T09:00:00Z");

const item: SourceItem = {
  source: "devpost",
  sourceId: "1",
  url: "https://hack.devpost.com/",
  title: "AI Hackathon",
  organiser: "Org",
  type: "hackathon",
  startDate: "2026-12-10",
  endDate: "2026-12-12",
  locationText: "Online",
  isOnline: true,
  accessType: "open",
  registerUrl: "https://hack.devpost.com/",
  prizes: null,
  tags: [],
  unverifiedFields: ["access"],
};
const event: StoredEvent = {
  ...normalizeItem(item, criteria),
  ...NO_DETAILS,
  id: 1,
  status: "pending_extraction",
};

const PAGE_HTML = `<html><body>
<h1>AI Hackathon</h1>
<p>Runs 10 December 2026, 10:00 to 12 December 2026, 18:00 (Athens time, Europe/Athens).</p>
<p>Anyone can join &amp; register for free. <a href="https://forms.example.org/x">Sign up</a></p>
<p>Apply by 5 December 2026.</p>
<p>Selected teams hear back on 7 December 2026.</p>
</body></html>`;
const page = readPage("https://hack.devpost.com/", PAGE_HTML);

const none = { value: null, evidence: null, confidence: "high" as const };
function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    organiser: none,
    start: {
      value: "2026-12-10T10:00",
      evidence: "Runs 10 December 2026, 10:00",
      confidence: "high",
    },
    end: { value: "2026-12-12T18:00", evidence: "12 December 2026, 18:00", confidence: "high" },
    timezone: {
      value: "Europe/Athens",
      evidence: "Athens time, Europe/Athens",
      confidence: "high",
    },
    location: none,
    city: none,
    country: none,
    attendance: none,
    access: { value: "open", evidence: "Anyone can join & register for free.", confidence: "high" },
    register_url: { value: "https://forms.example.org/x", evidence: "Sign up", confidence: "high" },
    register_steps: none,
    apply_deadline: none,
    results_date: none,
    cost: { value: "Free", evidence: "register for free", confidence: "medium" },
    travel_support: none,
    prizes: none,
    eligibility: none,
    worth: { score: 7, reason: "Good fit" },
    ...overrides,
  };
}

describe("readPage", () => {
  it("keeps visible text and JSON-LD, drops scripts and styles, resolves links", () => {
    const read = readPage(
      "https://e.com/a/",
      `<script>evil()</script><style>p{}</style><p>Hello&nbsp;&amp; welcome</p>
       <script type="application/ld+json">{"startDate":"2027-01-01T10:00+02:00"}</script>
       <a href="../b">B</a><a href='mailto:x@y.z'>mail</a>`,
    );
    expect(read.text).toContain("Hello & welcome");
    expect(read.text).toContain('Structured data:\n{"startDate":"2027-01-01T10:00+02:00"}');
    expect(read.text).not.toContain("evil");
    expect([...read.links]).toEqual(["https://e.com/b"]);
    expect(read.truncated).toBe(false);
  });

  it("caps long pages and says so", () => {
    const read = readPage("https://e.com/", `<p>${"word ".repeat(20_000)}</p>`);
    expect(read.text).toHaveLength(MAX_PAGE_CHARS);
    expect(read.truncated).toBe(true);
  });

  it("decodes numeric entities and leaves unknown ones", () => {
    expect(decodeEntities("&#8364;5 &#x20AC;5 &bogus;")).toBe("€5 €5 &bogus;");
  });
});

describe("parseExtraction / parseLocal", () => {
  it("rejects output that doesn't match the schema", () => {
    expect(parseExtraction("not json")).toBeNull();
    expect(parseExtraction(JSON.stringify({ worth: { score: 1, reason: "" } }))).toBeNull();
    expect(parseExtraction(JSON.stringify(extraction()))).toEqual(extraction());
  });

  it.each([
    ["2026-12-10", { date: "2026-12-10", time: null }],
    ["2026-12-10T09:30", { date: "2026-12-10", time: "09:30:00" }],
    ["2026-02-30", null],
    ["2026-12-10T24:00", null],
    ["10 Dec 2026", null],
  ])("parseLocal(%s)", (input, expected) => {
    expect(parseLocal(input)).toEqual(expected);
  });
});

describe("validateExtraction", () => {
  it("uses verified page facts and clears the listing's flags", () => {
    const { update, weak, scoreValid } = validateExtraction(extraction(), event, page, criteria);
    expect(weak).toEqual([]);
    expect(scoreValid).toBe(true);
    expect(update).toMatchObject({
      startsAt: "2026-12-10T08:00:00.000Z",
      endsAt: "2026-12-12T16:00:00.000Z",
      timezone: "Europe/Athens",
      accessType: "open",
      registerUrl: "https://forms.example.org/x",
      cost: "Free",
      score: 7,
      unverifiedFields: [],
    });
  });

  it("drops values whose quote is not on the page, and escalates critical ones", () => {
    const { update, weak } = validateExtraction(
      extraction({
        start: { value: "2026-12-11T10:00", evidence: "Starts 11 December", confidence: "high" },
        cost: { value: "€50", evidence: "Tickets cost €50", confidence: "high" },
      }),
      event,
      page,
      criteria,
    );
    expect(weak).toEqual(["dates"]);
    // Listing dates stay (date-only, home zone) and remain flagged.
    expect(update.startsAt).toBe(event.startsAt);
    expect(update.cost).toBeNull();
    expect(update.unverifiedFields).toEqual(expect.arrayContaining(["dates", "time", "cost"]));
  });

  it("rejects a date whose quote names a different day or year", () => {
    const wrongDay = validateExtraction(
      extraction({
        start: {
          value: "2026-12-09T10:00",
          evidence: "Runs 10 December 2026, 10:00",
          confidence: "high",
        },
      }),
      event,
      page,
      criteria,
    );
    expect(wrongDay.weak).toContain("dates");
    const wrongYear = validateExtraction(
      extraction({
        start: {
          value: "2027-12-10T10:00",
          evidence: "Runs 10 December 2026, 10:00",
          confidence: "high",
        },
      }),
      event,
      page,
      criteria,
    );
    expect(wrongYear.weak).toContain("dates");
  });

  it("treats low confidence as unverified, even with a good quote", () => {
    const { update, weak } = validateExtraction(
      extraction({
        access: { value: "application", evidence: "Anyone can join", confidence: "low" },
      }),
      event,
      page,
      criteria,
    );
    expect(weak).toEqual(["access"]);
    expect(update.accessType).toBe("open"); // listing value kept
    expect(update.unverifiedFields).toContain("access");
  });

  it("flags times without a stated zone, and an end date the page doesn't give", () => {
    const { update } = validateExtraction(
      extraction({ timezone: none, end: none }),
      event,
      page,
      criteria,
    );
    expect(update.timezone).toBe("Europe/Athens"); // online: home zone
    expect(update.unverifiedFields).toEqual(expect.arrayContaining(["timezone", "end date"]));
  });

  it("requires deadline and results date for application events", () => {
    const application = extraction({
      access: { value: "application", evidence: "Apply by 5 December 2026", confidence: "high" },
    });
    expect(validateExtraction(application, event, page, criteria).update.unverifiedFields).toEqual(
      expect.arrayContaining(["deadline", "results date"]),
    );
    const full = validateExtraction(
      {
        ...application,
        apply_deadline: {
          value: "2026-12-05",
          evidence: "Apply by 5 December 2026",
          confidence: "high",
        },
        results_date: {
          value: "2026-12-07",
          evidence: "hear back on 7 December 2026",
          confidence: "high",
        },
      },
      event,
      page,
      criteria,
    ).update;
    expect(full.applyDeadline).toBe("2026-12-05T21:59:59.000Z"); // end of that day, Athens
    expect(full.resultsDate).toBe("2026-12-06T22:00:00.000Z");
    expect(full.unverifiedFields).toEqual([]);
  });

  it("refuses links the page doesn't contain on other domains", () => {
    expect(linkIsTrusted("https://forms.example.org/x", page)).toBe(true);
    expect(linkIsTrusted("https://hack.devpost.com/apply", page)).toBe(true); // same host
    // Neighbouring subdomains and public suffixes are not trusted unless linked.
    expect(linkIsTrusted("https://other-hack.devpost.com/register", page)).toBe(false);
    expect(linkIsTrusted("https://evil.example.com/x", page)).toBe(false);
    expect(linkIsTrusted("javascript:alert(1)", page)).toBe(false);
    const { update } = validateExtraction(
      extraction({
        register_url: {
          value: "https://evil.example.com/x",
          evidence: "Sign up",
          confidence: "high",
        },
      }),
      event,
      page,
      criteria,
    );
    expect(update.registerUrl).toBe(event.registerUrl);
    expect(update.unverifiedFields).toContain("register link");
  });

  it("marks out-of-range scores invalid", () => {
    for (const score of [11, -1, 7.5]) {
      const result = validateExtraction(
        extraction({ worth: { score, reason: "" } }),
        event,
        page,
        criteria,
      );
      expect(result.scoreValid).toBe(false);
      expect(result.weak).toContain("score");
    }
  });

  it("re-tiers an event by the page's location", () => {
    const { update } = validateExtraction(
      extraction({
        attendance: { value: "in_person", evidence: "Runs 10 December 2026", confidence: "medium" },
        city: { value: "Athens", evidence: "Athens time", confidence: "high" },
        country: { value: "Greece", evidence: "AI Hackathon", confidence: "high" },
      }),
      event,
      page,
      criteria,
    );
    expect(update).toMatchObject({ isOnline: false, locationTier: "local", city: "Athens" });
  });
});

describe("review regressions", () => {
  it.each([
    ["Hacking starts Feb 20, 2027", "2026-02-20", false], // year slip
    ["Starts 2026-11-03", "2026-03-11", false], // ISO order is fixed
    ["March 3 - April 10, 2027", "2027-04-03", false], // other end of the range
    ["March 3 - April 10, 2027", "2027-04-10", true],
    ["Doors open 10.30, Main stage", "2026-10-30", false], // a time, not a date
    ["3/15/2027", "2027-03-03", false],
    ["20/02/2027", "2027-02-20", true],
    ["February 20 - 22, 2027", "2027-02-22", true],
    ["12 December 2026, 18:00", "2026-12-12", true],
  ])("evidenceMatchesDate(%s, %s) → %s", (quote, date, expected) => {
    expect(evidenceMatchesDate(quote, date)).toBe(expected);
  });

  it("re-reads a kept listing end in the page's zone", () => {
    const abroad: StoredEvent = {
      ...event,
      timezone: "UTC",
      endsAt: "2026-12-12T23:59:59.000Z",
      locationTier: "abroad",
    };
    const { update } = validateExtraction(
      extraction({
        end: none,
        timezone: {
          value: "Asia/Tokyo",
          evidence: "Athens time, Europe/Athens",
          confidence: "high",
        },
      }),
      abroad,
      page,
      criteria,
    );
    expect(update.timezone).toBe("Asia/Tokyo");
    expect(update.endsAt).toBe("2026-12-12T14:59:59.000Z"); // 12 Dec 23:59:59 in Tokyo
  });

  it("accepts a cross-year range quote and rejects a quote for another month", () => {
    expect(evidenceMatchesDate("Dec 10 - Jan 15, 2027", "2026-12-10")).toBe(true);
    expect(evidenceMatchesDate("Dec 10 - Jan 15, 2027", "2027-01-15")).toBe(true);
    expect(evidenceMatchesDate("10 December 2026", "2026-03-10")).toBe(false);
    expect(evidenceMatchesDate("Round 1 starts in March", "2027-03-01")).toBe(false);
    expect(evidenceMatchesDate("2027-02-20T09:00+02:00", "2027-02-20")).toBe(true);
    expect(evidenceMatchesDate("20 Φεβρουαρίου 2027", "2027-02-20")).toBe(true);
  });

  it("does not verify access from a one-word quote", () => {
    const { update, weak } = validateExtraction(
      extraction({ access: { value: "open", evidence: "join", confidence: "high" } }),
      { ...event, accessType: null },
      page,
      criteria,
    );
    expect(weak).toContain("access");
    expect(update.accessType).toBeNull();
  });

  it("keeps the location flag when attendance is unclear, even if the place is verified", () => {
    const { update } = validateExtraction(
      extraction({
        attendance: { value: "in_person", evidence: "Runs 10 December 2026", confidence: "low" },
        location: { value: "Athens", evidence: "Athens time", confidence: "high" },
      }),
      event,
      page,
      criteria,
    );
    expect(update.isOnline).toBe(true);
    expect(update.unverifiedFields).toContain("location");
  });

  it("keeps the listing's end date when the page's end is unclear", () => {
    const { update } = validateExtraction(extraction({ end: none }), event, page, criteria);
    expect(update.startsAt).toBe("2026-12-10T08:00:00.000Z");
    expect(update.endsAt).toBe(event.endsAt); // 12 Dec from the listing, not 10 Dec
    expect(update.unverifiedFields).toEqual(expect.arrayContaining(["end date", "time"]));
  });

  it("closes an open event whose registration deadline passed, and shows date-only deadlines as dates", () => {
    const { update } = validateExtraction(
      extraction({
        apply_deadline: {
          value: "2026-12-05",
          evidence: "Apply by 5 December 2026",
          confidence: "high",
        },
      }),
      event,
      page,
      criteria,
    );
    expect(decideStatus(update, criteria, new Date("2026-12-06T00:00:00Z"))).toBe("closed");
    const html = formatAlert({ ...event, ...update });
    expect(html).toContain("🎟 Access: Open · register by 5 Dec 2026\n");
  });
});

describe("worthEscalating", () => {
  const weakStart = extraction({
    start: { value: "2026-12-10T10:00", evidence: "Starts on the tenth", confidence: "high" },
  });
  const withScore = (score: number) =>
    validateExtraction({ ...weakStart, worth: { score, reason: "" } }, event, page, criteria);

  it("re-checks only events that could reach their tier's minimum (online: 6)", () => {
    expect(withScore(4).weak).toEqual(["dates"]);
    expect(worthEscalating(withScore(4), criteria)).toBe(false);
    expect(worthEscalating(withScore(5), criteria)).toBe(true); // one below the minimum
    expect(worthEscalating(withScore(9), criteria)).toBe(true);
  });

  it("always re-checks an invalid score, never a fully verified answer", () => {
    expect(worthEscalating(withScore(11), criteria)).toBe(true);
    expect(worthEscalating(validateExtraction(extraction(), event, page, criteria), criteria)).toBe(
      false,
    );
  });

  it("uses the lower minimum when an unclear attendance would change the tier", () => {
    // Listed online (minimum 6); the model says in person in Athens (local, minimum 5) but its
    // quote isn't on the page.
    const claimed = validateExtraction(
      extraction({
        attendance: { value: "in_person", evidence: "Held in person downtown", confidence: "high" },
        city: { value: "Athens", evidence: "Athens time", confidence: "high" },
        country: { value: "Greece", evidence: "Greece", confidence: "low" },
        worth: { score: 4, reason: "" },
      }),
      event,
      page,
      criteria,
    );
    expect(claimed.update.locationTier).toBe("online");
    expect(claimed.claimedTier).toBe("local");
    expect(claimed.weak).toEqual(["location"]);
    expect(worthEscalating(claimed, criteria)).toBe(true); // 4 >= 5 - 1
  });

  it("doesn't blame attendance when only an unverified city would change the tier", () => {
    const berlin: StoredEvent = {
      ...event,
      isOnline: false,
      locationText: "Berlin, Germany",
      locationTier: "abroad",
    };
    const result = validateExtraction(
      extraction({
        attendance: { value: "in_person", evidence: "Held in person downtown", confidence: "high" },
        city: { value: "Athens", evidence: "Somewhere else", confidence: "high" },
        country: { value: "Greece", evidence: "Somewhere else", confidence: "high" },
      }),
      berlin,
      page,
      criteria,
    );
    expect(result.update.locationTier).toBe("abroad");
    expect(result.claimedTier).toBe("local"); // still lowers the escalation minimum
    expect(result.weak).not.toContain("location");
  });

  it("does not escalate an unclear attendance that wouldn't change the tier", () => {
    const { weak } = validateExtraction(
      extraction({
        attendance: { value: "hybrid", evidence: "Join from anywhere online", confidence: "high" },
      }),
      event,
      page,
      criteria,
    );
    expect(weak).toEqual([]);
  });
});

describe("decideStatus", () => {
  const base = validateExtraction(extraction(), event, page, criteria).update;
  it.each([
    [{ score: 6 }, "new"], // online minimum 6
    [{ score: 5 }, "below_threshold"],
    [{ score: null }, "below_threshold"],
    [{ endsAt: "2026-11-30T00:00:00.000Z" }, "closed"],
    [{ accessType: "application" as const, applyDeadline: "2026-11-30T00:00:00.000Z" }, "closed"],
    [{ locationTier: "abroad" as const, score: 8 }, "below_threshold"],
    [{ locationTier: "abroad" as const, score: 9 }, "new"],
  ])("%j → %s", (patch, status) => {
    expect(decideStatus({ ...base, ...patch }, criteria, now)).toBe(status);
  });
});

describe("LLM cost and caps", () => {
  it("prices calls per model", () => {
    expect(costUsd(HAIKU, { inputTokens: 50_000, outputTokens: 50_000 })).toBeCloseTo(0.03);
    expect(costUsd(HAIKU, { inputTokens: 200_000, outputTokens: 0 })).toBeCloseTo(0.1); // long-prompt tier
    expect(costUsd(SONNET, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(12);
    // One token per character: an upper bound even for Greek pages.
    expect(worstCaseCostUsd(HAIKU, 3000, 1000)).toBeCloseTo((3000 * 0.1 + 1000 * 0.5) / 1e6);
  });

  it("caps calls per run and the monthly budget", () => {
    const budget = new LlmBudget(2, 1, 0.99);
    expect(budget.check(0.005)).toBeNull();
    expect(budget.check(0.02)).toBe("budget");
    budget.record(0.001);
    budget.record(0.001);
    expect(budget.check(0)).toBe("calls");
    expect(monthStart(new Date("2026-12-31T23:59:00Z")).toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });
});

describe("schema migration", () => {
  it("upgrades a version-1 database in place, keeping its rows", async () => {
    const client = createClient({ url: ":memory:" });
    // Rebuild the v1 shape: today's schema minus what version 2 added.
    await client.batch(
      [
        ...SCHEMA,
        "DROP INDEX messages_notice_key",
        "DROP TABLE llm_calls",
        "ALTER TABLE events DROP COLUMN register_steps",
        "ALTER TABLE events DROP COLUMN extract_attempts",
        // As created by schema version 1 (git: 567c4cb src/db/schema.ts).
        "DROP TABLE messages",
        `CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER REFERENCES events (id),
          telegram_message_id INTEGER,
          chat_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('alert', 'reminder', 'nudge', 'notice')),
          state TEXT NOT NULL DEFAULT 'sent' CHECK (state IN ('claimed', 'sent', 'unknown')),
          claimed_at TEXT,
          sent_at TEXT
        )`,
        "CREATE INDEX messages_event ON messages (event_id, kind)",
        "CREATE UNIQUE INDEX messages_one_alert ON messages (event_id) WHERE kind = 'alert'",
        `INSERT INTO events (source, source_id, canonical_url, title, type, timezone, is_online, location_tier, status, first_seen_at, updated_at)
         VALUES ('devpost', '1', 'https://x.com/', 'Old', 'hackathon', 'UTC', 1, 'online', 'new', 'a', 'a')`,
        "PRAGMA user_version = 1",
      ],
      "write",
    );
    const store = new LibsqlStore(client);
    await store.migrate();
    await store.migrate(); // idempotent
    const version = await client.execute("PRAGMA user_version");
    expect(version.rows[0]?.["user_version"]).toBe(2);
    expect(await store.llmSpendSince(new Date(0))).toBe(0);
    // M1 stored it as `new` but never alerted it: it must be extracted before any alert.
    expect(await store.eventsAwaitingAlert(now, 3, 10)).toEqual([]);
    expect(await store.eventsPendingExtraction(now, 10)).toEqual([
      expect.objectContaining({ title: "Old", status: "pending_extraction", registerSteps: null }),
    ]);
    store.close();
  });
});
