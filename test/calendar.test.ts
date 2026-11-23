import { describe, expect, it } from "vitest";
import { formatAlert } from "../src/alert.js";
import {
  CalendarError,
  checkCalendar,
  FakeCalendar,
  GoogleCalendar,
  type CalendarStatus,
} from "../src/calendar.js";
import { parseCriteria } from "../src/config.js";
import { normalizeItem } from "../src/normalize.js";
import { NO_DETAILS } from "../src/types.js";

const CREDENTIALS = { clientId: "cid", clientSecret: "secret", refreshToken: "refresh-xyz" };

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Fake fetch: answers the token endpoint, then serves `pages[calendarId]` for events.list. */
function fakeGoogle(
  pages: Record<string, unknown>,
  token: { status: number; body: unknown } = {
    status: 200,
    body: { access_token: "access-1", expires_in: 3600 },
  },
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, init });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(Response.json(token.body, { status: token.status }));
    }
    const id = decodeURIComponent(/calendars\/([^/]+)\/events/.exec(url)?.[1] ?? "");
    const page = pages[id];
    return Promise.resolve(
      page === undefined ? Response.json({}, { status: 404 }) : Response.json(page),
    );
  };
  return { fetchFn, calls };
}

const RANGE = ["2027-02-20T07:00:00.000Z", "2027-02-22T16:00:00.000Z"] as const;

describe("GoogleCalendar", () => {
  it("lists busy entries across calendars and skips free, declined and cancelled ones", async () => {
    const { fetchFn, calls } = fakeGoogle({
      primary: {
        timeZone: "Europe/Athens",
        items: [
          {
            summary: "Thesis defence",
            start: { dateTime: "2027-02-21T10:00:00+02:00" },
            end: { dateTime: "2027-02-21T12:00:00+02:00" },
          },
          {
            summary: "Holiday (shown as free)",
            transparency: "transparent",
            start: { date: "2027-02-20" },
            end: { date: "2027-02-21" },
          },
          {
            summary: "Declined sync",
            attendees: [{ self: true, responseStatus: "declined" }],
            start: { dateTime: "2027-02-21T13:00:00Z" },
            end: { dateTime: "2027-02-21T14:00:00Z" },
          },
          {
            status: "cancelled",
            summary: "Cancelled",
            start: { dateTime: "2027-02-21T15:00:00Z" },
            end: { dateTime: "2027-02-21T16:00:00Z" },
          },
        ],
      },
      "work@group.calendar.google.com": {
        timeZone: "Europe/Athens",
        nextPageToken: "p2",
        items: [
          // An all-day entry in a zone Intl doesn't know is dropped, not fatal.
          {
            summary: "Odd zone",
            start: { date: "2027-02-21", timeZone: "Mars/Olympus" },
            end: { date: "2027-02-22", timeZone: "Mars/Olympus" },
          },
          { summary: "Trip", start: { date: "2027-02-22" }, end: { date: "2027-02-23" } },
        ],
      },
    });
    const calendar = new GoogleCalendar(
      CREDENTIALS,
      ["primary", "work@group.calendar.google.com"],
      fetchFn,
    );
    const result = await calendar.busy(...RANGE);
    expect(result).toEqual({
      events: [
        {
          title: "Thesis defence",
          start: "2027-02-21T08:00:00.000Z",
          end: "2027-02-21T10:00:00.000Z",
        },
        // All-day entries are dates in the calendar's zone, end exclusive.
        { title: "Trip", start: "2027-02-21T22:00:00.000Z", end: "2027-02-22T22:00:00.000Z" },
      ],
      truncated: true,
    });
    const list = new URL(calls[1]?.url ?? "");
    expect(list.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(Object.fromEntries(list.searchParams)).toMatchObject({
      timeMin: RANGE[0],
      timeMax: RANGE[1],
      singleEvents: "true",
    });
    expect(calls[1]?.init?.headers).toEqual({ authorization: "Bearer access-1" });
    expect(calls[0]?.init?.body).toContain("grant_type=refresh_token");
  });

  it("reuses the access token until it is about to expire", async () => {
    let now = 0;
    const { fetchFn, calls } = fakeGoogle({ primary: { items: [] } });
    const calendar = new GoogleCalendar(CREDENTIALS, ["primary"], fetchFn, () => now);
    await calendar.busy(...RANGE);
    await calendar.busy(...RANGE);
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
    now = 3_550_000; // inside the last minute of the hour-long token
    await calendar.busy(...RANGE);
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(2);
  });

  it("explains a revoked refresh token without leaking secrets", async () => {
    const { fetchFn } = fakeGoogle(
      {},
      { status: 400, body: { error: "invalid_grant", error_description: "Token expired" } },
    );
    const calendar = new GoogleCalendar(CREDENTIALS, ["primary"], fetchFn);
    const error = await calendar.busy(...RANGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CalendarError);
    expect(String(error)).toMatch(/invalid_grant.*npm run google:auth/);
    expect(String(error)).not.toMatch(/refresh-xyz|secret/);
  });

  it("fails on API errors and network failures with the endpoint only", async () => {
    const { fetchFn } = fakeGoogle({});
    await expect(
      new GoogleCalendar(CREDENTIALS, ["missing"], fetchFn).busy(...RANGE),
    ).rejects.toThrow("google calendar (missing): HTTP 404");
    const offline = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    await expect(
      new GoogleCalendar(CREDENTIALS, ["primary"], offline).busy(...RANGE),
    ).rejects.toThrow("google oauth: network error");
  });
});

describe("checkCalendar", () => {
  it("cuts long titles without splitting an emoji", async () => {
    const title = `${"x".repeat(78)}🤖 and more`;
    const calendar = new FakeCalendar([
      { title, start: "2027-02-21T08:00:00Z", end: "2027-02-21T09:00:00Z" },
    ]);
    const status = await checkCalendar(calendar, {
      startsAt: "2027-02-20T07:00:00.000Z",
      endsAt: "2027-02-22T16:00:00.000Z",
    });
    expect(status).toMatchObject({ titles: [`${"x".repeat(78)}🤖…`] });
  });

  it("widens a zero-length span to one minute (Google rejects empty ranges)", async () => {
    const calendar = new FakeCalendar([]);
    const at = "2027-01-31T21:59:00.000Z";
    await checkCalendar(calendar, { startsAt: at, endsAt: at });
    expect(calendar.queries).toEqual([{ start: at, end: "2027-01-31T22:00:00.000Z" }]);
  });

  const event = { startsAt: RANGE[0], endsAt: RANGE[1] };

  it("is free when nothing overlaps, touching ends included", async () => {
    const calendar = new FakeCalendar([
      { title: "Before", start: "2027-02-20T05:00:00Z", end: "2027-02-20T07:00:00Z" },
    ]);
    expect(await checkCalendar(calendar, event)).toEqual({ kind: "free" });
    expect(calendar.queries).toEqual([{ start: RANGE[0], end: RANGE[1] }]);
  });

  it("names up to three distinct conflicts and counts the rest", async () => {
    const at = { start: "2027-02-21T08:00:00Z", end: "2027-02-21T09:00:00Z" };
    const calendar = new FakeCalendar(
      ["A", "B", "A", "C", "D", "x".repeat(100)].map((title) => ({ title, ...at })),
    );
    const status = await checkCalendar(calendar, event);
    expect(status).toEqual({
      kind: "conflicts",
      titles: ["A", "B", "C"],
      more: 2,
      truncated: false,
    });
  });

  it("does not query when the dates are unknown", async () => {
    const calendar = new FakeCalendar([]);
    expect(await checkCalendar(calendar, { startsAt: null, endsAt: null })).toEqual({
      kind: "unknown",
      reason: "dates unknown",
    });
    expect(calendar.queries).toEqual([]);
  });
});

describe("alert calendar line", () => {
  const criteria = parseCriteria(`
profile: x
interests: [AI]
eventTypes: [hackathon]
home: { city: Athens, country: Greece, timezone: Europe/Athens }
sources: [{ kind: devpost }]
`);
  const event = {
    ...normalizeItem(
      {
        source: "devpost",
        sourceId: "1",
        url: "https://a.devpost.com/",
        title: "AI Hack",
        organiser: null,
        type: "hackathon",
        startDate: "2026-12-10",
        endDate: "2026-12-12",
        locationText: "Online",
        isOnline: true,
        accessType: "open",
        registerUrl: null,
        prizes: null,
        tags: [],
        unverifiedFields: [],
      },
      criteria,
    ),
    ...NO_DETAILS,
  };
  const line = (status: CalendarStatus): string | undefined =>
    formatAlert(event, status)
      .split("\n")
      .find((l) => l.startsWith("📅"));

  it("shows free, conflicts (escaped) and couldn't-check", () => {
    expect(line({ kind: "free" })).toBe("📅 Calendar: free");
    expect(
      line({ kind: "conflicts", titles: ["Exam <AI> & co", "Gym"], more: 2, truncated: false }),
    ).toBe(
      "📅 Calendar: conflicts with &quot;Exam &lt;AI&gt; &amp; co&quot;, &quot;Gym&quot; +2 more",
    );
    expect(line({ kind: "conflicts", titles: ["Gym"], more: 0, truncated: true })).toBe(
      "📅 Calendar: conflicts with &quot;Gym&quot; and more",
    );
    expect(line({ kind: "unknown", reason: "calendar unavailable" })).toBe(
      "📅 Calendar: couldn't check (calendar unavailable)",
    );
  });
});
