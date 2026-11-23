import { describe, expect, it } from "vitest";
import { formatAlert } from "../src/alert.js";
import { parseCriteria, type Criteria } from "../src/config.js";
import { applyRules } from "../src/filter.js";
import {
  canonicalUrl,
  containsPhrase,
  dedupeHash,
  locationTier,
  normalizeItem,
} from "../src/normalize.js";
import type { SourceItem } from "../src/types.js";

const criteria: Criteria = parseCriteria(`
profile: x
interests: [AI]
keywords: { include: [AI, robotics], exclude: [crypto] }
eventTypes: [hackathon]
home: { city: Athens, country: Greece, timezone: Europe/Athens }
dateWindowDays: 90
sources: [{ kind: devpost }]
`);

const now = new Date("2026-12-01T09:00:00Z");

function item(overrides: Partial<SourceItem> = {}): SourceItem {
  return {
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
    prizes: null,
    tags: [],
    unverifiedFields: [],
    ...overrides,
  };
}

describe("canonicalUrl", () => {
  it("drops tracking params, hash, www and trailing slash; upgrades to https", () => {
    expect(canonicalUrl("http://WWW.Example.com/events/x/?utm_source=a&b=2&a=1#top")).toBe(
      "https://example.com/events/x?a=1&b=2",
    );
    expect(canonicalUrl("https://kiroween.devpost.com/")).toBe("https://kiroween.devpost.com/");
  });
});

describe("containsPhrase", () => {
  it("matches whole words only, ignoring case and accents", () => {
    expect(containsPhrase("Machine Learning/AI", "ai")).toBe(true);
    expect(containsPhrase("Said the maintainer", "AI")).toBe(false);
    expect(containsPhrase("Αθήνα, Ελλάδα", "αθηνα")).toBe(true);
  });
});

describe("dedupeHash", () => {
  it("ignores case and punctuation in title and organiser", () => {
    expect(dedupeHash("AI Hack!", "2026-12-10", "Org")).toBe(
      dedupeHash("ai hack", "2026-12-10", "ORG"),
    );
    expect(dedupeHash("AI Hack", "2026-12-10", "Org")).not.toBe(
      dedupeHash("AI Hack", "2026-12-11", "Org"),
    );
  });
});

describe("locationTier", () => {
  const home = criteria.home;
  it.each([
    [{ isOnline: true, locationText: "Online" }, "online", true],
    [{ isOnline: false, locationText: "Athens, Greece" }, "local", true],
    [{ isOnline: false, locationText: "Thessaloniki, Greece" }, "country", true],
    [{ isOnline: false, locationText: "Berlin, Germany" }, "abroad", true],
    [{ isOnline: false, locationText: "Athens, GA" }, "local", false],
  ] as const)("%j → %s", (input, tier, certain) => {
    expect(locationTier(input, home)).toEqual({ tier, certain });
  });
});

describe("normalizeItem", () => {
  it("reads date-only listings in the home zone and flags the time", () => {
    const event = normalizeItem(item(), criteria);
    expect(event.startsAt).toBe("2026-12-09T22:00:00.000Z");
    expect(event.endsAt).toBe("2026-12-12T21:59:59.000Z");
    expect(event.timezone).toBe("Europe/Athens");
    expect(event.unverifiedFields).toContain("time");
  });

  it("uses UTC and flags the timezone for events abroad", () => {
    const event = normalizeItem(
      item({ isOnline: false, locationText: "Berlin, Germany" }),
      criteria,
    );
    expect(event.locationTier).toBe("abroad");
    expect(event.timezone).toBe("UTC");
    expect(event.unverifiedFields).toEqual(expect.arrayContaining(["time", "timezone"]));
  });
});

describe("applyRules", () => {
  const rule = (overrides: Partial<SourceItem>) =>
    applyRules(normalizeItem(item(overrides), criteria), criteria, now);

  it("keeps a matching upcoming event", () => {
    expect(rule({})).toEqual({ keep: true });
  });

  it.each([
    [{ type: "conference" as const }, /type/],
    [{ title: "AI x Crypto" }, /excluded keyword "crypto"/],
    [{ title: "Blockchain Hack" }, /no include keyword/],
    [{ startDate: "2026-11-01", endDate: "2026-11-30" }, /ended/],
    [{ startDate: "2027-06-01", endDate: "2027-06-02" }, /window/],
  ])("drops %j", (overrides, reason) => {
    const result = rule(overrides);
    expect(result.keep).toBe(false);
    if (!result.keep) expect(result.reason).toMatch(reason);
  });

  it("matches keywords in tags and keeps events whose dates are unknown", () => {
    expect(
      rule({ title: "Winter Build", tags: ["Robotics"], startDate: null, endDate: null }),
    ).toEqual({
      keep: true,
    });
  });

  it("keeps an open hackathon that started before today but ends later", () => {
    expect(rule({ startDate: "2026-11-01", endDate: "2026-12-20" })).toEqual({ keep: true });
  });
});

describe("formatAlert", () => {
  it("escapes HTML from source data and lists unverified fields", () => {
    const html = formatAlert(
      normalizeItem(
        item({ title: "AI <Hack> & Co", prizes: "$1,000", unverifiedFields: ["access"] }),
        criteria,
      ),
    );
    expect(html).toContain("<b>AI &lt;Hack&gt; &amp; Co</b>");
    expect(html).toContain("🗓 10 Dec 2026 – 12 Dec 2026 (Europe/Athens)");
    expect(html).toContain("🏆 Prizes: $1,000");
    expect(html).toContain("⚠️ unverified: access, time");
  });

  it("says when dates are unknown instead of guessing", () => {
    expect(
      formatAlert(normalizeItem(item({ startDate: null, endDate: null }), criteria)),
    ).toContain("⚠️ dates unknown");
  });
});
