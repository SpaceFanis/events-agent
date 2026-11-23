import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { LumaSource } from "../../src/sources/luma.js";
import { PageHttp } from "./page-http.js";

const FEED = "https://api.lu.ma/ics/get?entity=discover&id=discplace-zS3rBqHSdNGTSZB";

// Real Luma city feed ("What's Happening in Budapest"), recorded 2026-11-23.
async function source(name: string): Promise<LumaSource> {
  const http = new PageHttp({ [FEED]: await readFile("test/fixtures/luma/budapest.ics", "utf8") });
  return new LumaSource(http, { url: FEED, name }, "Europe/Athens");
}

describe("LumaSource", () => {
  it("maps the recorded ICS feed to source items", async () => {
    const { items, warnings } = await (await source("Budapest")).fetch();
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(7);
    expect(items[0]).toEqual({
      source: "luma",
      sourceId: "evt-XRytx2Zk0oH5MPm@events.lu.ma",
      url: "https://luma.com/claude-nk9s",
      title: "Budapest | Claude Meetup For Everyone",
      organiser: "tamas puski",
      type: "meetup",
      // 16:30 UTC is 18:30 in Athens, the same day.
      startDate: "2026-11-23",
      endDate: "2026-11-23",
      locationText: "CREATE26 Coworking, Budapest, Király u. 26, 1061 Hungary",
      isOnline: false,
      accessType: null,
      registerUrl: "https://luma.com/claude-nk9s",
      prizes: null,
      tags: [],
      unverifiedFields: ["access"],
    });
    expect(items.map((item) => [item.url, item.type, item.locationText])).toEqual([
      [
        "https://luma.com/claude-nk9s",
        "meetup",
        "CREATE26 Coworking, Budapest, Király u. 26, 1061 Hungary",
      ],
      // Address hidden until registration: LOCATION is the event page, the description says so.
      ["https://luma.com/vi6xtt1h", "conference", ""],
      ["https://luma.com/a0fmo7fu", "meetup", "Casa Luna, Budapest, Fodor u. 13a, 1126 Hungary"],
      [
        "https://luma.com/65x5ogri",
        "meetup",
        "Okūma - Tea House & Social Club, Budapest, Vörösmarty u. 19, 1074 Hungary",
      ],
      [
        "https://luma.com/3wxv932k",
        "meetup",
        "BME F29-es terem, Budapest, Budafoki út 8, 1111 Hungary",
      ],
      [
        "https://luma.com/kull7jns",
        "meetup",
        "Time Out Market Budapest, Budapest, Blaha Lujza tér 1, 1085 Hungary",
      ],
      ["https://luma.com/ftst8budapest", "meetup", ""],
    ]);
    expect(items[1]?.unverifiedFields).toEqual(["access", "location"]);
  });

  it("is named after its configured name, never its URL", async () => {
    expect((await source("Budapest")).name).toBe("luma: Budapest");
  });

  it("fails the whole source when the response is not a calendar", async () => {
    const http = new PageHttp({ [FEED]: "<!doctype html><title>Rate limited</title>" });
    await expect(new LumaSource(http, { url: FEED, name: "B" }, "UTC").fetch()).rejects.toThrow(
      "not an iCalendar feed",
    );
  });

  it("fails the whole source when no event has a Luma link (format changed)", async () => {
    const ics = (await readFile("test/fixtures/luma/budapest.ics", "utf8")).replace(
      /https:\/\/luma\.com\//g,
      "https://elsewhere.example/",
    );
    const http = new PageHttp({ [FEED]: ics });
    await expect(new LumaSource(http, { url: FEED, name: "B" }, "UTC").fetch()).rejects.toThrow(
      "none of 7 items could be read (format changed?)",
    );
  });

  it("keeps the feed URL (which may hold a token) out of fetch errors", async () => {
    const secret = "https://calendar.example/private-abc123/basic.ics";
    const http = {
      getJson: () => Promise.reject(new Error("unused")),
      getText: (url: string) => Promise.reject(new Error(`GET ${url} failed: HTTP 404`)),
    };
    const failure = new LumaSource(http, { url: secret, name: "Private" }, "UTC").fetch();
    await expect(failure).rejects.toThrow("GET <feed url> failed: HTTP 404");
    await expect(failure).rejects.not.toThrow(/abc123/);
  });
});
