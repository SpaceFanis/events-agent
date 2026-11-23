import type { Http } from "../http.js";
import type { SourceItem } from "../types.js";
import { assertReadable, cleanText, feedName, fetchFeed, firstUrl, guessType } from "./feed.js";
import {
  icsDates,
  icsOrganiser,
  icsText,
  isCancelled,
  parseIcs,
  type FeedConfig,
  type IcsEvent,
} from "./ics.js";
import type { Source, SourceResult } from "./types.js";

const LUMA_HOST = /^https:\/\/(www\.)?(lu\.ma|luma\.com)\//;

/** Luma puts the event page first in the description: "Get up-to-date information at: <url>". */
export function lumaEventUrl(event: IcsEvent): string | null {
  const description = icsText(event, "DESCRIPTION") ?? "";
  const stated = /up-to-date information at:\s*(\S+)/i.exec(description)?.[1];
  for (const candidate of [stated, firstUrl(description), icsText(event, "LOCATION")]) {
    const url = candidate === undefined || candidate === null ? null : firstUrl(candidate);
    if (url !== null && LUMA_HOST.test(url)) return url;
  }
  return null;
}

/**
 * Where the event is. LOCATION holds the address, or only the event page's URL when the host hides
 * the address until you register: then the description's "Address:" block is used if it has one.
 */
export function lumaLocation(event: IcsEvent): string {
  const location = cleanText(icsText(event, "LOCATION") ?? "");
  if (location !== "" && !/^https?:\/\//i.test(location)) return location;
  const block = /(?:^|\n)Address:\n([\s\S]*?)(?:\n\n|$)/.exec(icsText(event, "DESCRIPTION") ?? "");
  const address = cleanText((block?.[1] ?? "").replace(/\n/g, ", "));
  return /check event page/i.test(address) ? "" : address;
}

/**
 * A Luma calendar or city feed (`kind: luma`, its ICS URL from the page's "Add to calendar" / RSS
 * menu, e.g. https://api.lu.ma/ics/get?entity=discover&id=discplace-…). Luma has no public search.
 */
export class LumaSource implements Source {
  readonly name: string;

  constructor(
    private readonly http: Http,
    private readonly config: FeedConfig,
    /** Home zone: Luma's UTC times are turned into dates there. */
    private readonly timeZone: string,
  ) {
    this.name = feedName("luma", config);
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
      const url = lumaEventUrl(event);
      if (title === "" || url === null) {
        unreadable++;
        warnings.push(`${this.name}: skipped an event without a title or Luma link`);
        continue;
      }
      const location = lumaLocation(event);
      const { start, end } = icsDates(event, this.timeZone);
      // Luma events may need the host's approval; only the page says so.
      const unverified = ["access"];
      if (start === null) unverified.push("dates");
      if (location === "") unverified.push("location");
      items.push({
        source: "luma",
        sourceId: event.get("UID")?.[0]?.value.trim() || url,
        url,
        title,
        organiser: icsOrganiser(event),
        type: guessType(title) ?? this.config.type ?? "meetup",
        startDate: start,
        endDate: end,
        locationText: location,
        isOnline: /^(online|virtual)\b/i.test(location),
        accessType: null,
        registerUrl: url,
        prizes: null,
        tags: [],
        unverifiedFields: unverified,
      });
    }
    assertReadable(events.length, unreadable);
    return { items, warnings };
  }
}
