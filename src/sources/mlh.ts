import { z } from "zod";
import type { Http } from "../http.js";
import { containsPhrase } from "../normalize.js";
import type { SourceItem } from "../types.js";
import { cleanText } from "./feed.js";
import type { Source, SourceResult } from "./types.js";

export const MLH_BASE = "https://www.mlh.com";

/** MLH seasons run August to July and are named by the year they end in (Nov 2026 → 2027). */
export function mlhSeason(now: Date): number {
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

export function mlhPageUrl(season: number, page: number): string {
  const base = `${MLH_BASE}/seasons/${String(season)}/events`;
  return page === 1 ? base : `${base}?upcoming_page=${String(page)}`;
}

// Only the fields we use; unknown fields are ignored so additions on MLH's side don't break us.
const eventSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string().nullish(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  url: z.string().nullish(),
  websiteUrl: z.url().nullish(),
  location: z.string().nullish(),
  formatType: z.string().nullish(),
  venueAddress: z
    .object({
      city: z.string().nullish(),
      state: z.string().nullish(),
      country: z.string().nullish(),
    })
    .nullish(),
  organizationName: z.string().nullish(),
});

// The season page is an Inertia app: its data sits in <script data-page="app">.
const pageSchema = z.object({
  props: z.object({ upcomingEvents: z.array(z.unknown()) }),
  scrollProps: z
    .object({ upcomingEvents: z.object({ nextPage: z.number().nullable() }).optional() })
    .optional(),
});

type MlhEvent = z.infer<typeof eventSchema>;

/** The JSON the season page embeds; throws if the page no longer has it (layout changed). */
export function readPageData(html: string): z.infer<typeof pageSchema> {
  const script = /<script\b[^>]*\bdata-page="app"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (script === undefined) throw new Error("no page data found (layout changed?)");
  const parsed = pageSchema.safeParse(JSON.parse(script));
  if (!parsed.success) throw new Error("unexpected page data shape");
  return parsed.data;
}

function countryName(code: string | null | undefined): string | null {
  if (code === null || code === undefined || !/^[A-Z]{2}$/i.test(code.trim())) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code.trim().toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

/** "Urbana, Illinois" + US → "Urbana, Illinois, United States", so the location tier can see the country. */
function locationText(event: MlhEvent): string {
  if (event.formatType === "digital") return "Online";
  const venue = event.venueAddress;
  const base = cleanText(
    event.location ??
      [venue?.city, venue?.state].filter((part) => typeof part === "string").join(", "),
  );
  const country = countryName(venue?.country);
  if (country === null || containsPhrase(base, country)) return base;
  return base === "" ? country : `${base}, ${country}`;
}

export function toSourceItem(event: MlhEvent): SourceItem | null {
  const url =
    event.websiteUrl ??
    (event.url === null || event.url === undefined ? null : new URL(event.url, MLH_BASE).href);
  if (url === null) return null;
  const location = locationText(event);
  const unverified = ["access"];
  if (location === "") unverified.push("location");
  return {
    source: "mlh",
    sourceId: event.id,
    url,
    title: cleanText(event.name),
    organiser: event.organizationName?.trim() || null,
    type: "hackathon",
    // Listed as UTC instants, often with a placeholder time (01:11:11): only the dates are used.
    startDate: event.startsAt.slice(0, 10),
    endDate: event.endsAt.slice(0, 10),
    locationText: location,
    isOnline: event.formatType === "digital",
    // MLH lists member events; whether entry is open or screened is on each event's own page.
    accessType: null,
    registerUrl: url,
    prizes: null,
    tags: [],
    unverifiedFields: unverified,
  };
}

/** Major League Hacking's season page (upcoming member hackathons), page by page. */
export class MlhSource implements Source {
  readonly name = "mlh";

  constructor(
    private readonly http: Http,
    private readonly now: () => Date,
    private readonly maxPages = 10,
  ) {}

  async fetch(): Promise<SourceResult> {
    const season = mlhSeason(this.now());
    const items: SourceItem[] = [];
    const warnings: string[] = [];
    for (let page = 1; ; page++) {
      let data;
      try {
        data = readPageData(await this.http.getText(mlhPageUrl(season, page)));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Page 1 failing means the source is down or changed; a later page keeps what we have.
        if (page === 1) throw new Error(`mlh page 1: ${reason}`, { cause: error });
        warnings.push(
          `mlh page ${String(page)}: ${reason}; kept ${String(items.length)} items from earlier pages`,
        );
        break;
      }
      let unreadable = 0;
      for (const raw of data.props.upcomingEvents) {
        const event = eventSchema.safeParse(raw);
        if (!event.success) {
          unreadable++;
          warnings.push(`mlh page ${String(page)}: skipped malformed item`);
          continue;
        }
        if (/cancel/i.test(event.data.status ?? "")) continue;
        const item = toSourceItem(event.data);
        if (item === null) {
          unreadable++;
          warnings.push(`mlh: skipped ${event.data.name} (no link)`);
        } else items.push(item);
      }
      // Every listed event unreadable means the format changed: a failed run, not an empty one.
      const listed = data.props.upcomingEvents.length;
      if (page === 1 && listed > 0 && unreadable === listed) {
        throw new Error(
          `mlh page 1: none of ${String(listed)} listed events could be read (format changed?)`,
        );
      }
      const next = data.scrollProps?.upcomingEvents?.nextPage ?? null;
      if (next === null) break;
      if (page >= this.maxPages) {
        warnings.push(`mlh: stopped at page ${String(page)}`);
        break;
      }
    }
    return { items, warnings };
  }
}
