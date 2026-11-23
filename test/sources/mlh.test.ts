import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MlhSource, mlhPageUrl, mlhSeason, readPageData } from "../../src/sources/mlh.js";
import { PageHttp } from "./page-http.js";

// Trimmed real pages from mlh.com/seasons/2027/events (?upcoming_page=2), recorded 2026-11-23.
const page1 = (): Promise<string> => readFile("test/fixtures/mlh/season-2027-page-1.html", "utf8");
const page2 = (): Promise<string> => readFile("test/fixtures/mlh/season-2027-page-2.html", "utf8");
const now = (): Date => new Date("2026-11-23T12:00:00Z");

describe("MlhSource", () => {
  it("maps the recorded season pages to source items, following pagination", async () => {
    const http = new PageHttp({
      [mlhPageUrl(2027, 1)]: await page1(),
      [mlhPageUrl(2027, 2)]: await page2(),
    });
    const { items, warnings } = await new MlhSource(http, now).fetch();

    expect(warnings).toEqual([]);
    expect(http.requested).toEqual([
      "https://www.mlh.com/seasons/2027/events",
      "https://www.mlh.com/seasons/2027/events?upcoming_page=2",
    ]);
    expect(items[0]).toEqual({
      source: "mlh",
      sourceId: "01a1169b-c4ad-5d41-61cf-deccaa37655c",
      url: "https://hackeps.dev/",
      title: "HackEPS",
      organiser: null,
      type: "hackathon",
      startDate: "2026-11-28",
      endDate: "2026-11-29",
      locationText: "Lleida, Lleida, Spain",
      isOnline: false,
      accessType: null,
      registerUrl: "https://hackeps.dev/",
      prizes: null,
      tags: [],
      unverifiedFields: ["access"],
    });
    // The country is added when the listing leaves it out, so the location tier can see it.
    expect(
      items.map((item) => [item.title, item.locationText, item.startDate, item.endDate]),
    ).toEqual([
      ["HackEPS", "Lleida, Lleida, Spain", "2026-11-28", "2026-11-29"],
      ["HackSheffield11", "Sheffield, South Yorkshire, United Kingdom", "2026-11-28", "2026-11-29"],
      ["Hack Canada 2027", "Toronto, Ontario, Canada", "2027-01-08", "2027-01-10"],
      ["HackUDC", "A Coruña, A Coruña, Spain", "2027-02-26", "2027-02-28"],
      ["LA Hacks 27", "Los Angeles, California, United States", "2027-04-16", "2027-04-18"],
    ]);
  });

  it("names the season by the year it ends in", () => {
    expect(mlhSeason(new Date("2026-11-23T00:00:00Z"))).toBe(2027);
    expect(mlhSeason(new Date("2027-03-01T00:00:00Z"))).toBe(2027);
    expect(mlhSeason(new Date("2027-08-01T00:00:00Z"))).toBe(2028);
  });

  it("keeps earlier pages when a later page fails", async () => {
    const http = new PageHttp({ [mlhPageUrl(2027, 1)]: await page1() });
    const { items, warnings } = await new MlhSource(http, now).fetch();
    expect(items).toHaveLength(3);
    expect(warnings).toEqual([expect.stringMatching(/^mlh page 2: .*kept 3 items/)]);
  });

  it("fails the whole source when the page no longer carries its data (layout changed)", async () => {
    const http = new PageHttp({ [mlhPageUrl(2027, 1)]: "<html><body>New design</body></html>" });
    await expect(new MlhSource(http, now).fetch()).rejects.toThrow(
      "mlh page 1: no page data found (layout changed?)",
    );
    expect(() => readPageData('<script data-page="app">{"props":{}}</script>')).toThrow(
      "unexpected page data shape",
    );
  });

  it("maps online events, skips cancelled and malformed ones", async () => {
    const event = {
      id: "e1",
      name: "Global Hack Week",
      status: "pending",
      startsAt: "2027-01-05T01:11:11Z",
      endsAt: "2027-01-11T23:59:59Z",
      url: "/events/ghw/prizes",
      websiteUrl: null,
      location: "Everywhere, Worldwide",
      formatType: "digital",
      venueAddress: null,
      organizationName: "MLH",
    };
    const page = (events: unknown[]): string =>
      `<script data-page="app" type="application/json">${JSON.stringify({
        props: { upcomingEvents: events },
        scrollProps: { upcomingEvents: { nextPage: null } },
      })}</script>`;
    const http = new PageHttp({
      [mlhPageUrl(2027, 1)]: page([
        event,
        { ...event, id: "e2", status: "cancelled" },
        { ...event, id: "e3", startsAt: "soon" },
      ]),
    });
    const { items, warnings } = await new MlhSource(http, now).fetch();
    expect(items).toEqual([
      expect.objectContaining({
        sourceId: "e1",
        url: "https://www.mlh.com/events/ghw/prizes",
        organiser: "MLH",
        locationText: "Online",
        isOnline: true,
      }),
    ]);
    expect(warnings).toEqual(["mlh page 1: skipped malformed item"]);

    // Every event unreadable (a field changed shape): a failed run, so the streak counts it.
    const changed = new PageHttp({
      [mlhPageUrl(2027, 1)]: page([
        { ...event, id: 1 },
        { ...event, id: 2 },
      ]),
    });
    await expect(new MlhSource(changed, now).fetch()).rejects.toThrow(
      "mlh page 1: none of 2 listed events could be read (format changed?)",
    );
    // Every event cancelled is just an empty listing.
    const cancelled = new PageHttp({
      [mlhPageUrl(2027, 1)]: page([{ ...event, status: "cancelled" }]),
    });
    expect((await new MlhSource(cancelled, now).fetch()).items).toEqual([]);
  });
});
