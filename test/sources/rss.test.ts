import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { guessType } from "../../src/sources/feed.js";
import { parseFeed, RssSource } from "../../src/sources/rss.js";
import { PageHttp } from "./page-http.js";

const FEED = "https://opportunitydesk.org/feed/";

describe("RssSource", () => {
  it("maps the recorded RSS feed to source items", async () => {
    // Real feed (first 3 items), recorded 2026-11-23.
    const http = new PageHttp({
      [FEED]: await readFile("test/fixtures/rss/opportunitydesk.xml", "utf8"),
    });
    const { items, warnings } = await new RssSource(http, {
      url: FEED,
      name: "Opportunity Desk",
    }).fetch();
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      source: "rss",
      sourceId: "https://opportunitydesk.org/?p=180437",
      url: "https://opportunitydesk.org/2026/11/23/itu-secretary-general-youth-advisory-board-2/",
      // Entity decoded, zero-width spaces dropped.
      title: "Apply to join the ITU Secretary-General’s Youth Advisory Board",
      organiser: null,
      type: "other",
      startDate: null,
      endDate: null,
      locationText: "",
      isOnline: false,
      accessType: null,
      registerUrl:
        "https://opportunitydesk.org/2026/11/23/itu-secretary-general-youth-advisory-board-2/",
      prizes: null,
      tags: [
        "Africa",
        "America",
        "Asia",
        "Australia and Oceania",
        "Europe",
        "Hot Jobs",
        "Volunteering",
        "International Telecommunication Union",
        "ITU",
        "ITU Secretary-General's Youth Advisory Board",
        "itu-secretary-general-youth-advisory-board apply",
      ],
      unverifiedFields: ["dates", "location", "access"],
    });
    expect(items.map((item) => item.type)).toEqual(["other", "fellowship", "fellowship"]);
  });

  it("reads Atom entries and their alternate link", () => {
    const atom = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Events</title>
        <link href="https://example.org/"/>
        <!-- <entry><title>Hidden</title><link href="https://evil.example/"/></entry> -->
        <entry>
          <title>AI &amp; Robotics Hackathon</title>
          <link rel="self" href="https://example.org/feed/1"/>
          <link rel="alternate" href="https://example.org/events/1?a=1&amp;b=2"/>
          <id>tag:example.org,2026:1</id>
          <category term="AI"/>
        </entry>
      </feed>`;
    expect(parseFeed(atom)).toEqual([
      {
        title: "AI & Robotics Hackathon",
        link: "https://example.org/events/1?a=1&b=2",
        id: "tag:example.org,2026:1",
        categories: ["AI"],
      },
    ]);
  });

  it("fails the whole source when the response is not a feed", async () => {
    const http = new PageHttp({ [FEED]: "<!doctype html><html><body>Maintenance</body></html>" });
    await expect(new RssSource(http, { url: FEED, name: "OD" }).fetch()).rejects.toThrow(
      "not an RSS or Atom feed",
    );
  });
});

describe("guessType", () => {
  it("reads the event type a title names, most specific first", () => {
    expect(guessType("AI Summer School Hackathon")).toBe("summer_school");
    expect(guessType("HackAthens 2027: AI hackathon")).toBe("hackathon");
    expect(guessType("Robotics Challenge")).toBe("competition");
    expect(guessType("PhD Fellowship 2027")).toBe("fellowship");
    expect(guessType("MeOut Summit")).toBe("conference");
    expect(guessType("Intro to ROS workshop")).toBe("workshop");
    expect(guessType("Claude Meetup")).toBe("meetup");
    expect(guessType("Christmas party")).toBeNull();
    // Whole words only: "HackSheffield" names no type.
    expect(guessType("HackSheffield11")).toBeNull();
  });
});
