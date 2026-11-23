import { z } from "zod";
import { parseMonthDayRange } from "../dates.js";
import type { Http } from "../http.js";
import type { SourceItem } from "../types.js";
import type { Source, SourceResult } from "./types.js";

export const DEVPOST_API = "https://devpost.com/api/hackathons";

// Only the fields we use; unknown fields are ignored so additions on Devpost's side don't break us.
const hackathonSchema = z.object({
  id: z.number(),
  title: z.string().min(1),
  url: z.url(),
  displayed_location: z.object({ location: z.string() }),
  open_state: z.string(),
  submission_period_dates: z.string(),
  themes: z.array(z.object({ name: z.string() })).default([]),
  prize_amount: z.string().nullish(),
  organization_name: z.string().nullish(),
  invite_only: z.boolean().nullish(),
});

const pageSchema = z.object({
  hackathons: z.array(z.unknown()),
  meta: z.object({ total_count: z.number(), per_page: z.number() }),
});

type Hackathon = z.infer<typeof hackathonSchema>;

export function devpostPageUrl(page: number): string {
  // Built by hand so the string is stable for replay fixtures.
  return `${DEVPOST_API}?status[]=upcoming&status[]=open&page=${String(page)}`;
}

/** "$<span data-currency-value>10,000</span>" → "$10,000"; zero amounts → null. */
export function cleanPrize(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null;
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const digits = text.replace(/[^\d]/g, "");
  if (text === "" || digits === "" || /^0+$/.test(digits)) return null;
  return text;
}

export function toSourceItem(hackathon: Hackathon): SourceItem {
  const location = hackathon.displayed_location.location.trim();
  const dates = parseMonthDayRange(hackathon.submission_period_dates);
  // Devpost lists registration as open, but some hackathons still screen entrants on their own page.
  const unverified = ["access"];
  if (dates === null) unverified.push("dates");
  return {
    source: "devpost",
    sourceId: String(hackathon.id),
    url: hackathon.url,
    title: hackathon.title.trim(),
    organiser: hackathon.organization_name?.trim() || null,
    type: "hackathon",
    startDate: dates?.start ?? null,
    endDate: dates?.end ?? null,
    locationText: location,
    isOnline: location.toLowerCase() === "online",
    accessType: hackathon.invite_only === true ? "invite" : "open",
    registerUrl: hackathon.url,
    prizes: cleanPrize(hackathon.prize_amount),
    tags: hackathon.themes.map((theme) => theme.name),
    unverifiedFields: unverified,
  };
}

/** Devpost's public JSON listing of upcoming and open hackathons. */
export class DevpostSource implements Source {
  readonly name = "devpost";

  constructor(
    private readonly http: Http,
    private readonly maxPages = 25,
  ) {}

  async fetch(): Promise<SourceResult> {
    const items: SourceItem[] = [];
    const warnings: string[] = [];
    for (let page = 1; ; page++) {
      let parsed;
      try {
        const body = await this.http.getJson(devpostPageUrl(page));
        parsed = pageSchema.safeParse(body);
        if (!parsed.success) throw new Error("unexpected response shape");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Page 1 failing means the source is down; a later page failing keeps what we already have.
        if (page === 1) throw new Error(`devpost page 1: ${reason}`, { cause: error });
        warnings.push(
          `devpost page ${String(page)}: ${reason}; kept ${String(items.length)} items from earlier pages`,
        );
        break;
      }
      const { hackathons, meta } = parsed.data;
      for (const raw of hackathons) {
        const hackathon = hackathonSchema.safeParse(raw);
        if (!hackathon.success) {
          warnings.push(`devpost page ${String(page)}: skipped malformed item`);
          continue;
        }
        if (hackathon.data.open_state === "ended") continue;
        items.push(toSourceItem(hackathon.data));
      }
      if (hackathons.length === 0 || page * meta.per_page >= meta.total_count) break;
      if (page >= this.maxPages) {
        warnings.push(
          `devpost: stopped at page ${String(page)} of ${String(Math.ceil(meta.total_count / meta.per_page))}`,
        );
        break;
      }
    }
    return { items, warnings };
  }
}
