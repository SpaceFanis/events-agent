import { describe, expect, it } from "vitest";
import { icsDates, icsDurationMs, icsText, IcsSource, parseIcs } from "../../src/sources/ics.js";
import { PageHttp } from "./page-http.js";

const FEED = "https://calendar.example.org/events.ics";

// Hand-written to cover what the recorded Luma feed doesn't: TZID and all-day dates, URL property,
// escapes, CRLF folding, nested alarms, cancelled events and items without a link.
const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:robotics-summer-school-2027",
  "SUMMARY:Robotics Summer School 2027",
  "DTSTART;VALUE=DATE:20270705",
  "DTEND;VALUE=DATE:20270717",
  "LOCATION:NTUA\\, Athens\\, Greece",
  "URL:https://school.example.org/2027",
  "CATEGORIES:Robotics,AI",
  'ORGANIZER;CN="Athena Lab; Robotics":mailto:lab@example.org',
  "BEGIN:VALARM",
  "TRIGGER:-PT15M",
  "DESCRIPTION:Alarm text that must not leak into the event",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:ai-night",
  "SUMMARY:AI night",
  "DTSTART;TZID=America/New_York:20261210T230000",
  "DTEND;TZID=America/New_York:20261211T010000",
  "DESCRIPTION:Details and tickets: https://ai-night.example.org/tickets.",
  "  More text.",
  "LOCATION:Online",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:gone",
  "SUMMARY:Cancelled meetup",
  "STATUS:CANCELLED",
  "URL:https://example.org/gone",
  "DTSTART:20261210T180000Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:no-link",
  "SUMMARY:Coffee",
  "DTSTART:20261210T180000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcs", () => {
  it("reads events, unfolds lines, undoes escapes and skips nested components", () => {
    const [first, second] = parseIcs(ICS);
    if (first === undefined || second === undefined) throw new Error("expected events");
    expect(icsText(first, "LOCATION")).toBe("NTUA, Athens, Greece");
    expect(icsText(first, "DESCRIPTION")).toBeNull();
    expect(first.get("ORGANIZER")?.[0]?.params["CN"]).toBe("Athena Lab; Robotics");
    expect(icsText(second, "DESCRIPTION")).toBe(
      "Details and tickets: https://ai-night.example.org/tickets. More text.",
    );
  });

  it("turns all-day, zoned and UTC times into local dates", () => {
    const [allDay, zoned, , utc] = parseIcs(ICS);
    if (allDay === undefined || zoned === undefined || utc === undefined) throw new Error("events");
    // All-day DTEND is exclusive: 5–16 July.
    expect(icsDates(allDay, "UTC")).toEqual({ start: "2027-07-05", end: "2027-07-16" });
    // TZID times are already a wall date in that zone.
    expect(icsDates(zoned, "Europe/Athens")).toEqual({ start: "2026-12-10", end: "2026-12-11" });
    // 18:00 UTC is 20:00 in Athens but 06:00 the next day in Auckland. No DTEND: one day.
    expect(icsDates(utc, "Europe/Athens")).toEqual({ start: "2026-12-10", end: "2026-12-10" });
    expect(icsDates(utc, "Pacific/Auckland")).toEqual({ start: "2026-12-11", end: "2026-12-11" });
  });

  it("takes the end from DURATION when there is no DTEND", () => {
    const event = (lines: string[]) => {
      const [parsed] = parseIcs(
        ["BEGIN:VCALENDAR", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\n"),
      );
      if (parsed === undefined) throw new Error("no event");
      return parsed;
    };
    // All-day, 3 days: 10–12 Dec.
    expect(icsDates(event(["DTSTART;VALUE=DATE:20261210", "DURATION:P3D"]), "UTC")).toEqual({
      start: "2026-12-10",
      end: "2026-12-12",
    });
    // 22:00 UTC + 3h ends at 01:00 UTC on the 11th, 03:00 in Athens.
    expect(icsDates(event(["DTSTART:20261210T220000Z", "DURATION:PT3H"]), "Europe/Athens")).toEqual(
      {
        start: "2026-12-11",
        end: "2026-12-11",
      },
    );
    expect(icsDates(event(["DTSTART:20261210T180000", "DURATION:P1W"]), "UTC")).toEqual({
      start: "2026-12-10",
      end: "2026-12-17",
    });
    expect(icsDurationMs("P1DT2H")).toBe(26 * 3_600_000);
    expect(icsDurationMs("-P1D")).toBeNull();
  });
});

describe("IcsSource", () => {
  it("maps feed events to source items, guessing the type from the title", async () => {
    const http = new PageHttp({ [FEED]: ICS });
    const source = new IcsSource(
      http,
      { url: FEED, name: "Example", type: "workshop" },
      "Europe/Athens",
    );
    const { items, warnings } = await source.fetch();
    expect(source.name).toBe("ics: Example");
    expect(warnings).toEqual(["ics: Example: skipped an event without a title or link"]);
    expect(items).toEqual([
      {
        source: "ics",
        sourceId: "robotics-summer-school-2027",
        url: "https://school.example.org/2027",
        title: "Robotics Summer School 2027",
        organiser: "Athena Lab; Robotics",
        type: "summer_school",
        startDate: "2027-07-05",
        endDate: "2027-07-16",
        locationText: "NTUA, Athens, Greece",
        isOnline: false,
        accessType: null,
        registerUrl: "https://school.example.org/2027",
        prizes: null,
        tags: ["Robotics", "AI"],
        unverifiedFields: ["access"],
      },
      expect.objectContaining({
        sourceId: "ai-night",
        // No URL property: the first link in the description, without the full stop.
        url: "https://ai-night.example.org/tickets",
        // The title names no type: the configured one.
        type: "workshop",
        isOnline: true,
      }),
    ]);
  });
});
