import { addDays, isoDate, localDate } from "../dates.js";
import type { EventType } from "../event-type.js";
import type { Http } from "../http.js";
import type { IsoDate, SourceItem } from "../types.js";
import { assertReadable, cleanText, feedName, fetchFeed, firstUrl, guessType } from "./feed.js";
import type { Source, SourceResult } from "./types.js";

/** One content line of a VEVENT, e.g. `DTSTART;TZID=Europe/Athens:20261210T180000`. */
export interface IcsProperty {
  /** Upper-cased property name. */
  name: string;
  /** Upper-cased parameter names → values (quotes removed). */
  params: Readonly<Record<string, string>>;
  /** Raw value; use icsText() for TEXT values. */
  value: string;
}

/** A VEVENT's properties by name (repeated properties keep every occurrence, in order). */
export type IcsEvent = ReadonlyMap<string, readonly IcsProperty[]>;

/** Splits on `separator` outside double quotes (parameter values may quote `:` and `;`). */
function splitUnquoted(text: string, separator: string, limit = Infinity): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length && parts.length < limit - 1; i++) {
    const char = text[i];
    if (char === '"') quoted = !quoted;
    else if (char === separator && !quoted) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function parseLine(line: string): IcsProperty | null {
  const [head, value] = splitUnquoted(line, ":", 2);
  if (head === undefined || value === undefined) return null;
  const [name, ...rawParams] = splitUnquoted(head, ";");
  if (name === undefined || name === "") return null;
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const eq = param.indexOf("=");
    if (eq > 0)
      params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), params, value };
}

/**
 * Minimal RFC 5545 reader: unfolds lines and returns each VEVENT's own properties (nested
 * components such as VALARM are skipped). Throws if the text is not an iCalendar feed at all,
 * e.g. an HTML error page, so the source counts as failed.
 */
export function parseIcs(text: string): IcsEvent[] {
  if (!/^\s*BEGIN:VCALENDAR/i.test(text)) throw new Error("not an iCalendar feed");
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const events: IcsEvent[] = [];
  let current: Map<string, IcsProperty[]> | null = null;
  let nested = 0;
  for (const line of lines) {
    const property = parseLine(line);
    if (property === null) continue;
    const value = property.value.trim().toUpperCase();
    if (property.name === "BEGIN") {
      if (value === "VEVENT" && current === null) current = new Map();
      else if (current !== null) nested++;
      continue;
    }
    if (property.name === "END") {
      if (current !== null && nested > 0) nested--;
      else if (current !== null && value === "VEVENT") {
        events.push(current);
        current = null;
      }
      continue;
    }
    if (current === null || nested > 0) continue;
    const list = current.get(property.name) ?? [];
    list.push(property);
    current.set(property.name, list);
  }
  return events;
}

/** A TEXT value with RFC 5545 escapes undone (`\n`, `\,`, `\;`, `\\`). */
export function icsText(event: IcsEvent, name: string): string | null {
  const property = event.get(name)?.[0];
  if (property === undefined) return null;
  const text = property.value.replace(/\\([\\;,nN])/g, (_, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
  return text.trim() === "" ? null : text;
}

/** The ORGANIZER's display name (CN), if any. */
export function icsOrganiser(event: IcsEvent): string | null {
  const name = event.get("ORGANIZER")?.[0]?.params["CN"];
  return name === undefined || name.trim() === "" ? null : cleanText(name);
}

interface IcsTime {
  /** Local date (UTC times already turned into `timeZone`). */
  date: IsoDate;
  dateOnly: boolean;
  /** The value as written, as epoch ms of that wall clock read as UTC (for adding a DURATION). */
  wallMs: number;
  utc: boolean;
}

function icsTime(property: IcsProperty | undefined, timeZone: string): IcsTime | null {
  if (property === undefined) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(
    property.value.trim(),
  );
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  const date = isoDate(Number(y), Number(mo), Number(d));
  if (date === null) return null;
  const wallMs = Date.parse(`${date}T${h ?? "00"}:${mi ?? "00"}:${s ?? "00"}Z`);
  if (h === undefined) return { date, dateOnly: true, wallMs, utc: false };
  // UTC times are read in `timeZone`; TZID and floating times already are a local wall date.
  const utc = z === "Z";
  const local = utc ? localDate(new Date(wallMs).toISOString(), timeZone) : date;
  return { date: local, dateOnly: false, wallMs, utc };
}

/** A DURATION such as P3D, P1W or PT2H30M, in ms; null if unreadable or negative. */
export function icsDurationMs(value: string): number | null {
  const match = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (match === null || value.trim().replace(/^\+/, "") === "P") return null;
  // Unmatched groups are undefined at runtime, whatever the array type says.
  const [w, d, h, m, s] = match.slice(1).map((part: string | undefined) => Number(part ?? 0));
  return (((((w ?? 0) * 7 + (d ?? 0)) * 24 + (h ?? 0)) * 60 + (m ?? 0)) * 60 + (s ?? 0)) * 1000;
}

/**
 * Start and end dates of a VEVENT (date-only: times are flagged and come from the page extraction).
 * The end comes from DTEND, else from DTSTART + DURATION, else is the start day. All-day ends are
 * exclusive, so they are moved back a day. A recurring event (RRULE) gives only its first occurrence.
 */
export function icsDates(
  event: IcsEvent,
  timeZone: string,
): { start: IsoDate | null; end: IsoDate | null } {
  const start = icsTime(event.get("DTSTART")?.[0], timeZone);
  if (start === null) return { start: null, end: null };
  const endRaw = icsTime(event.get("DTEND")?.[0], timeZone);
  let end = start.date;
  if (endRaw !== null) {
    end = endRaw.dateOnly ? addDays(endRaw.date, -1) : endRaw.date;
  } else {
    const duration = icsDurationMs(event.get("DURATION")?.[0]?.value ?? "");
    if (duration !== null) {
      const endIso = new Date(start.wallMs + duration).toISOString();
      end = start.dateOnly
        ? addDays(endIso.slice(0, 10), -1)
        : start.utc
          ? localDate(endIso, timeZone)
          : endIso.slice(0, 10);
    }
  }
  if (end < start.date) end = start.date;
  return { start: start.date, end };
}

export function isCancelled(event: IcsEvent): boolean {
  return event.get("STATUS")?.[0]?.value.trim().toUpperCase() === "CANCELLED";
}

const ONLINE = /^(online|virtual|remote)\b|zoom\.us|meet\.google\.com|teams\.microsoft\.com/i;

export interface FeedConfig {
  url: string;
  /** Required: logs and notices name the feed by it, never by its URL. */
  name: string;
  /** Type for items whose title names none (see guessType). */
  type?: EventType | undefined;
}

/** Any iCalendar feed listed in criteria.yaml (`kind: ics`). */
export class IcsSource implements Source {
  readonly name: string;

  constructor(
    private readonly http: Http,
    private readonly config: FeedConfig,
    /** Home zone: UTC times are turned into dates there. */
    private readonly timeZone: string,
  ) {
    this.name = feedName("ics", config);
  }

  async fetch(): Promise<SourceResult> {
    const events = parseIcs(await fetchFeed(this.http, this.config.url)).filter(
      (event) => !isCancelled(event),
    );
    const items: SourceItem[] = [];
    const warnings: string[] = [];
    let unreadable = 0;
    for (const event of events) {
      const title = cleanText(icsText(event, "SUMMARY") ?? "");
      const description = icsText(event, "DESCRIPTION") ?? "";
      const url = firstUrl(event.get("URL")?.[0]?.value ?? "") ?? firstUrl(description);
      if (title === "" || url === null) {
        unreadable++;
        warnings.push(`${this.name}: skipped an event without a title or link`);
        continue;
      }
      const location = cleanText(icsText(event, "LOCATION") ?? "");
      const { start, end } = icsDates(event, this.timeZone);
      const unverified = ["access"];
      if (start === null) unverified.push("dates");
      if (location === "") unverified.push("location");
      const categories = (event.get("CATEGORIES") ?? []).flatMap((p) =>
        p.value.split(",").map((c) => cleanText(c.replace(/\\(.)/g, "$1"))),
      );
      items.push({
        source: "ics",
        sourceId: event.get("UID")?.[0]?.value.trim() || url,
        url,
        title,
        organiser: icsOrganiser(event),
        type: guessType(title) ?? this.config.type ?? "other",
        startDate: start,
        endDate: end,
        locationText: location,
        isOnline: ONLINE.test(location),
        accessType: null,
        registerUrl: url,
        prizes: null,
        tags: categories.filter((c) => c !== ""),
        unverifiedFields: unverified,
      });
    }
    assertReadable(events.length, unreadable);
    return { items, warnings };
  }
}
