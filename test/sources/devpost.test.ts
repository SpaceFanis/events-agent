import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Http } from "../../src/http.js";
import { cleanPrize, DevpostSource, devpostPageUrl } from "../../src/sources/devpost.js";

class MapHttp implements Http {
  readonly requested: string[] = [];
  constructor(private readonly pages: Record<string, unknown>) {}
  getJson(url: string): Promise<unknown> {
    this.requested.push(url);
    const body = this.pages[url];
    return body === undefined
      ? Promise.reject(new Error(`unexpected ${url}`))
      : Promise.resolve(body);
  }
  getText(url: string): Promise<string> {
    return this.getJson(url).then((body) => JSON.stringify(body));
  }
}

async function recordedPage(): Promise<unknown> {
  // Trimmed real response from devpost.com/api/hackathons, recorded 2026-11-23.
  return JSON.parse(await readFile("test/fixtures/devpost/hackathons-page-1.json", "utf8"));
}

describe("DevpostSource", () => {
  it("maps a recorded API page to source items", async () => {
    const http = new MapHttp({ [devpostPageUrl(1)]: await recordedPage() });
    const { items, warnings } = await new DevpostSource(http).fetch();

    expect(warnings).toEqual([]);
    expect(http.requested).toEqual([devpostPageUrl(1)]);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      source: "devpost",
      sourceId: "31667",
      url: "https://kiroween.devpost.com/",
      title: "Kiroween 2026",
      organiser: "Kiro",
      type: "hackathon",
      startDate: "2026-10-30",
      endDate: "2026-12-04",
      locationText: "Online",
      isOnline: true,
      accessType: "open",
      registerUrl: "https://kiroween.devpost.com/",
      prizes: "$100,000",
      tags: ["Beginner Friendly", "Machine Learning/AI", "Open Ended"],
      unverifiedFields: ["access"],
    });
    // "Nov 11 - 30, 2026" and "Nov 11, 2026 - Jan 11, 2027"
    expect(items.map((item) => [item.startDate, item.endDate])).toEqual([
      ["2026-10-30", "2026-12-04"],
      ["2026-11-11", "2026-11-30"],
      ["2026-11-11", "2027-01-11"],
    ]);
  });

  it("follows pagination until total_count is reached", async () => {
    const hackathon = {
      id: 1,
      title: "A",
      url: "https://a.devpost.com/",
      displayed_location: { location: "Online" },
      open_state: "open",
      submission_period_dates: "Dec 05, 2026",
      themes: [],
    };
    const http = new MapHttp({
      [devpostPageUrl(1)]: { hackathons: [hackathon], meta: { total_count: 2, per_page: 1 } },
      [devpostPageUrl(2)]: {
        hackathons: [{ ...hackathon, id: 2 }],
        meta: { total_count: 2, per_page: 1 },
      },
    });
    const { items } = await new DevpostSource(http).fetch();
    expect(items.map((item) => item.sourceId)).toEqual(["1", "2"]);
  });

  it("skips ended and malformed items, flags unparseable dates", async () => {
    const base = {
      url: "https://a.devpost.com/",
      displayed_location: { location: "Online" },
      open_state: "open",
      themes: [],
    };
    const http = new MapHttp({
      [devpostPageUrl(1)]: {
        hackathons: [
          {
            ...base,
            id: 1,
            title: "Ended",
            open_state: "ended",
            submission_period_dates: "Jan 01, 2026",
          },
          {
            ...base,
            id: 2,
            title: "Bad",
            url: "not a url",
            submission_period_dates: "Jan 01, 2027",
          },
          { ...base, id: 3, title: "Weird dates", submission_period_dates: "Rolling" },
        ],
        meta: { total_count: 3, per_page: 9 },
      },
    });
    const { items, warnings } = await new DevpostSource(http).fetch();
    expect(items.map((item) => item.title)).toEqual(["Weird dates"]);
    expect(items[0]?.unverifiedFields).toEqual(["access", "dates"]);
    expect(items[0]?.startDate).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("fails the whole source on an unexpected response shape", async () => {
    const http = new MapHttp({ [devpostPageUrl(1)]: { error: "rate limited" } });
    await expect(new DevpostSource(http).fetch()).rejects.toThrow(/unexpected response shape/);
  });
});

describe("DevpostSource pagination limits", () => {
  const hackathon = (id: number) => ({
    id,
    title: `H${String(id)}`,
    url: `https://h${String(id)}.devpost.com/`,
    displayed_location: { location: "Online" },
    open_state: "open",
    submission_period_dates: "Dec 05, 2026",
    themes: [],
  });
  const page = (id: number) => ({
    hackathons: [hackathon(id)],
    meta: { total_count: 5, per_page: 1 },
  });

  it("warns when it stops at maxPages before total_count", async () => {
    const http = new MapHttp({ [devpostPageUrl(1)]: page(1), [devpostPageUrl(2)]: page(2) });
    const { items, warnings } = await new DevpostSource(http, 2).fetch();
    expect(items).toHaveLength(2);
    expect(warnings).toEqual(["devpost: stopped at page 2 of 5"]);
  });

  it("keeps earlier pages when a later page fails", async () => {
    const http = new MapHttp({ [devpostPageUrl(1)]: page(1) });
    const { items, warnings } = await new DevpostSource(http).fetch();
    expect(items.map((item) => item.sourceId)).toEqual(["1"]);
    expect(warnings[0]).toMatch(/devpost page 2: .*kept 1 items/);
  });
});

describe("cleanPrize", () => {
  it("strips markup and drops zero prizes", () => {
    expect(cleanPrize("$<span data-currency-value>10,000</span>")).toBe("$10,000");
    expect(cleanPrize("₹ <span data-currency-value>500,000</span>")).toBe("₹ 500,000");
    expect(cleanPrize("$<span data-currency-value>0</span>")).toBeNull();
    expect(cleanPrize(null)).toBeNull();
  });
});
