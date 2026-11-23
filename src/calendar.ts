import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { zonedToUtc } from "./dates.js";

/** A busy entry in my calendar that overlaps the range asked about. Times are UTC ISO strings. */
export interface BusyEvent {
  title: string;
  start: string;
  end: string;
}

export interface BusyResult {
  events: BusyEvent[];
  /** The calendar had more entries in the range than one page returned. */
  truncated: boolean;
}

/** Google Calendar, behind an interface so replay mode and tests use a fake. */
export interface CalendarClient {
  /** Busy (not "free", not declined, not cancelled) events overlapping [start, end). */
  busy(start: string, end: string): Promise<BusyResult>;
}

/** What the alert says about my calendar for one event. */
export type CalendarStatus =
  | { kind: "free" }
  | { kind: "conflicts"; titles: string[]; more: number; truncated: boolean }
  | { kind: "unknown"; reason: string };

export class CalendarError extends Error {
  override name = "CalendarError";
}

/** Titles listed in an alert; the rest are counted as "+N more". */
const MAX_TITLES = 3;
const MAX_TITLE_CHARS = 80;

/**
 * Checks my calendar for the event's whole span (multi-day events included; date-only events
 * already span whole local days). Throws CalendarError when the calendar can't be read; the pipeline
 * then logs it once and shows "couldn't check" for the rest of the run.
 */
export async function checkCalendar(
  calendar: CalendarClient,
  event: { startsAt: string | null; endsAt: string | null },
): Promise<CalendarStatus> {
  if (event.startsAt === null || event.endsAt === null) {
    return { kind: "unknown", reason: "dates unknown" };
  }
  // A page can give the same start and end (a single moment); Google rejects an empty range.
  const end =
    event.endsAt > event.startsAt
      ? event.endsAt
      : new Date(Date.parse(event.startsAt) + 60_000).toISOString();
  const { events, truncated } = await calendar.busy(event.startsAt, end);
  if (events.length === 0) return { kind: "free" };
  // The same entry can appear in two checked calendars (an invite on a shared calendar).
  const titles = [...new Set(events.map((busy) => busy.title))];
  const shown = titles.slice(0, MAX_TITLES).map((title) =>
    // Cut by code points: half an emoji (a lone surrogate) makes Telegram reject the whole message.
    truncate(title),
  );
  return {
    kind: "conflicts",
    titles: shown,
    more: titles.length - shown.length,
    truncated,
  };
}

function truncate(title: string): string {
  const chars = Array.from(title);
  return chars.length > MAX_TITLE_CHARS
    ? `${chars.slice(0, MAX_TITLE_CHARS - 1).join("")}…`
    : title;
}

const tokenResponse = z.object({ access_token: z.string(), expires_in: z.number() });
const tokenError = z.object({ error: z.string(), error_description: z.string().optional() });

const eventTime = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
});

const eventsResponse = z.object({
  timeZone: z.string().optional(),
  nextPageToken: z.string().optional(),
  items: z
    .array(
      z.object({
        status: z.string().optional(),
        summary: z.string().optional(),
        transparency: z.string().optional(),
        start: eventTime.optional(),
        end: eventTime.optional(),
        attendees: z
          .array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() }))
          .optional(),
      }),
    )
    .default([]),
});

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Entries per calendar per check; more are reported as "+N more", not fetched. */
const PAGE_SIZE = 50;

/**
 * Google Calendar REST with a stored OAuth refresh token (scope `calendar.events`, which M4 also
 * needs for inserts). `freeBusy` can't be used for the check: it returns busy intervals without
 * titles, and the alert names what it conflicts with.
 */
export class GoogleCalendar implements CalendarClient {
  private accessToken: { value: string; expiresAt: number } | undefined;

  constructor(
    private readonly credentials: GoogleCredentials,
    private readonly calendarIds: readonly string[],
    private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
    private readonly timeoutMs = 15_000,
  ) {}

  async busy(start: string, end: string): Promise<BusyResult> {
    const token = await this.token();
    const events: BusyEvent[] = [];
    let truncated = false;
    for (const calendarId of this.calendarIds) {
      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      );
      url.searchParams.set("timeMin", start);
      url.searchParams.set("timeMax", end);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", String(PAGE_SIZE));
      // The id isn't secret, and names which `calendar.check` entry is broken.
      const label = `google calendar (${calendarId})`;
      const body = await this.request(url, label, {
        headers: { authorization: `Bearer ${token}` },
      });
      const parsed = eventsResponse.safeParse(body);
      if (!parsed.success) throw new CalendarError(`${label}: unreadable events response`);
      if (parsed.data.nextPageToken !== undefined) truncated = true;
      for (const item of parsed.data.items) {
        const busy = toBusy(item, parsed.data.timeZone);
        // timeMin/timeMax already select overlapping entries; re-check so a bad time can't slip in.
        if (busy !== null && busy.start < end && busy.end > start) events.push(busy);
      }
    }
    events.sort((a, b) => a.start.localeCompare(b.start));
    return { events, truncated };
  }

  private async token(): Promise<string> {
    if (this.accessToken !== undefined && this.accessToken.expiresAt > this.clock()) {
      return this.accessToken.value;
    }
    const body = await this.request(
      new URL("https://oauth2.googleapis.com/token"),
      "google oauth",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
          refresh_token: this.credentials.refreshToken,
          grant_type: "refresh_token",
        }).toString(),
      },
    );
    const parsed = tokenResponse.safeParse(body);
    if (!parsed.success) throw new CalendarError("google oauth: unreadable token response");
    // Refresh a minute early so a token never expires mid-run.
    this.accessToken = {
      value: parsed.data.access_token,
      expiresAt: this.clock() + (parsed.data.expires_in - 60) * 1000,
    };
    return this.accessToken.value;
  }

  /** Errors name the endpoint, never the query or tokens. */
  private async request(url: URL, label: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw new CalendarError(`${label}: ${timedOut ? "timed out" : "network error"}`, {
        cause: error,
      });
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // handled below
    }
    if (response.ok) return body;
    const oauthError = tokenError.safeParse(body);
    if (oauthError.success && oauthError.data.error === "invalid_grant") {
      throw new CalendarError(
        "google oauth: refresh token rejected (invalid_grant); run `npm run google:auth` and update GOOGLE_REFRESH_TOKEN",
      );
    }
    throw new CalendarError(`${label}: HTTP ${String(response.status)}`);
  }
}

type GoogleEvent = z.infer<typeof eventsResponse>["items"][number];

function toBusy(item: GoogleEvent, calendarZone: string | undefined): BusyEvent | null {
  if (item.status === "cancelled") return null;
  // "Show as: free" (all-day events default to it) doesn't block anything.
  if (item.transparency === "transparent") return null;
  if (item.attendees?.some((a) => a.self === true && a.responseStatus === "declined")) return null;
  const start = toUtc(item.start, calendarZone);
  const end = toUtc(item.end, calendarZone);
  if (start === null || end === null) return null;
  const title = item.summary?.trim();
  return { title: title === undefined || title === "" ? "(no title)" : title, start, end };
}

/** Timed entries carry an offset; all-day entries are dates in the calendar's zone (end exclusive). */
function toUtc(time: z.infer<typeof eventTime> | undefined, calendarZone: string | undefined) {
  if (time?.dateTime !== undefined) {
    const ms = Date.parse(time.dateTime);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (time?.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(time.date)) {
    try {
      return zonedToUtc(time.date, "00:00:00", time.timeZone ?? calendarZone ?? "UTC");
    } catch {
      return null; // unknown zone name: drop this entry, don't fail the whole check
    }
  }
  return null;
}

const recordedCalendar = z.strictObject({
  busy: z.array(
    z.strictObject({ title: z.string(), start: z.iso.datetime(), end: z.iso.datetime() }),
  ),
});

/**
 * Serves busy blocks from `<dir>/calendar.json` (an empty calendar when the file is missing).
 * Records every query, so tests can check the ranges asked about.
 */
export class FakeCalendar implements CalendarClient {
  readonly queries: { start: string; end: string }[] = [];
  private entries: BusyEvent[] | undefined;

  constructor(private readonly source: string | BusyEvent[]) {}

  async busy(start: string, end: string): Promise<BusyResult> {
    this.queries.push({ start, end });
    this.entries ??= typeof this.source === "string" ? await load(this.source) : this.source;
    const overlapping = this.entries.filter(
      (entry) =>
        Date.parse(entry.start) < Date.parse(end) && Date.parse(entry.end) > Date.parse(start),
    );
    return { events: overlapping, truncated: false };
  }
}

async function load(dir: string): Promise<BusyEvent[]> {
  let text: string;
  try {
    text = await readFile(join(dir, "calendar.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return recordedCalendar.parse(JSON.parse(text)).busy;
}

/** Live mode without Google credentials: every check reads "couldn't check". */
export class UnconfiguredCalendar implements CalendarClient {
  busy(): Promise<BusyResult> {
    return Promise.reject(
      new CalendarError(
        "google calendar not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)",
      ),
    );
  }
}
