import type { IsoDate } from "./types.js";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function monthIndex(name: string): number | null {
  const index = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return index === -1 ? null : index + 1;
}

/** Builds "YYYY-MM-DD", or null if the parts are not a real calendar date. */
export function isoDate(year: number, month: number, day: number): IsoDate | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Parses date ranges as Devpost lists them:
 * "Oct 30 - Dec 04, 2026", "Nov 11 - 30, 2026", "Nov 11, 2026 - Jan 11, 2027", "Dec 05, 2026".
 */
export function parseMonthDayRange(text: string): { start: IsoDate; end: IsoDate } | null {
  const match =
    /^([A-Za-z]{3,9})\.? (\d{1,2})(?:, (\d{4}))?(?: - (?:([A-Za-z]{3,9})\.? )?(\d{1,2}), (\d{4}))?$/.exec(
      text.trim(),
    );
  if (match === null) return null;
  const [, startMonthName, startDayText, startYearText, endMonthName, endDayText, endYearText] =
    match;
  if (startMonthName === undefined || startDayText === undefined) return null;
  const startMonth = monthIndex(startMonthName);
  if (startMonth === null) return null;
  const startDay = Number(startDayText);

  if (endDayText === undefined || endYearText === undefined) {
    // Single date: "Dec 05, 2026".
    if (startYearText === undefined) return null;
    const single = isoDate(Number(startYearText), startMonth, startDay);
    return single === null ? null : { start: single, end: single };
  }

  const endMonth = endMonthName === undefined ? startMonth : monthIndex(endMonthName);
  if (endMonth === null) return null;
  const endYear = Number(endYearText);
  // "Dec 20 - Jan 05, 2027" spans a year boundary.
  const startYear =
    startYearText === undefined
      ? startMonth > endMonth
        ? endYear - 1
        : endYear
      : Number(startYearText);
  const start = isoDate(startYear, startMonth, startDay);
  const end = isoDate(endYear, endMonth, Number(endDayText));
  if (start === null || end === null || start > end) return null;
  return { start, end };
}

/** Offset of `timeZone` from UTC at the given instant, in milliseconds. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Converts a wall-clock time in `timeZone` to a UTC ISO string. */
export function zonedToUtc(date: IsoDate, time: string, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute, second] = time.split(":").map(Number);
  const guess = Date.UTC(
    year ?? 0,
    (month ?? 1) - 1,
    day ?? 1,
    hour ?? 0,
    minute ?? 0,
    second ?? 0,
  );
  const offset = zoneOffsetMs(guess, timeZone);
  let utc = guess - offset;
  // Re-check once in case the guess and the result sit on different sides of a DST change.
  const corrected = zoneOffsetMs(utc, timeZone);
  if (corrected !== offset) utc = guess - corrected;
  return new Date(utc).toISOString();
}

/** Formats a UTC instant as a date in `timeZone`, e.g. "30 Oct 2026". */
export function formatDate(utcIso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(utcIso));
}

/** Formats a UTC instant as date and 24h time in `timeZone`, e.g. "30 Oct 2026, 18:00". */
export function formatDateTime(utcIso: string, timeZone: string): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(utcIso));
  return `${formatDate(utcIso, timeZone)}, ${time}`;
}

/** The calendar date `days` after (or, negative, before) `date`. */
export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The calendar date ("YYYY-MM-DD") of a UTC instant in `timeZone`. */
export function localDate(utcIso: string, timeZone: string): IsoDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utcIso));
}
