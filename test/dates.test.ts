import { describe, expect, it } from "vitest";
import { formatDate, parseMonthDayRange, zonedToUtc } from "../src/dates.js";

describe("parseMonthDayRange", () => {
  it.each([
    ["Oct 30 - Dec 04, 2026", "2026-10-30", "2026-12-04"],
    ["Nov 11 - 30, 2026", "2026-11-11", "2026-11-30"],
    ["Nov 11, 2026 - Jan 11, 2027", "2026-11-11", "2027-01-11"],
    ["Dec 20 - Jan 05, 2027", "2026-12-20", "2027-01-05"],
    ["Dec 05, 2026", "2026-12-05", "2026-12-05"],
  ])("parses %s", (text, start, end) => {
    expect(parseMonthDayRange(text)).toEqual({ start, end });
  });

  it.each(["Rolling", "Feb 30, 2027", "Foo 01, 2027", "Dec 10 - 05, 2026", ""])(
    "rejects %j",
    (text) => {
      expect(parseMonthDayRange(text)).toBeNull();
    },
  );
});

describe("zonedToUtc", () => {
  it("converts wall-clock times in a zone, across DST", () => {
    expect(zonedToUtc("2027-01-10", "00:00:00", "Europe/Athens")).toBe("2027-01-09T22:00:00.000Z");
    expect(zonedToUtc("2027-07-10", "00:00:00", "Europe/Athens")).toBe("2027-07-09T21:00:00.000Z");
    expect(zonedToUtc("2027-03-05", "23:59:59", "UTC")).toBe("2027-03-05T23:59:59.000Z");
  });

  it("formats back in the same zone", () => {
    expect(formatDate(zonedToUtc("2027-01-10", "00:00:00", "Europe/Athens"), "Europe/Athens")).toBe(
      "10 Jan 2027",
    );
  });
});
