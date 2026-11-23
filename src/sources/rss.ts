import type { Http } from "../http.js";
import type { SourceItem } from "../types.js";
import {
  assertReadable,
  cleanText,
  decodeEntities,
  feedName,
  fetchFeed,
  firstUrl,
  guessType,
} from "./feed.js";
import type { FeedConfig } from "./ics.js";
import type { Source, SourceResult } from "./types.js";

/** Items read per feed run; feeds list their newest first, and older items were seen already. */
const MAX_ITEMS = 100;

export interface FeedEntry {
  title: string;
  link: string | null;
  id: string | null;
  categories: string[];
}

/** Text content of an element: CDATA unwrapped, markup dropped, entities decoded. */
function elementText(xml: string): string {
  const unwrapped = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, data: string) =>
    data.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  );
  return cleanText(decodeEntities(unwrapped.replace(/<[^>]*>/g, " ")));
}

/** Escapes a tag name (e.g. `dc:creator`) for use in a pattern. */
function tagPattern(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function children(xml: string, tag: string): string[] {
  const pattern = new RegExp(
    `<${tagPattern(tag)}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tagPattern(tag)}>)`,
    "g",
  );
  return [...xml.matchAll(pattern)].map((match) => match[0]);
}

function childText(xml: string, tag: string): string | null {
  const element = children(xml, tag)[0];
  if (element === undefined) return null;
  const text = elementText(element);
  return text === "" ? null : text;
}

function attribute(element: string, name: string): string | null {
  const value = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(element);
  const raw = value?.[2] ?? value?.[3];
  return raw === undefined ? null : decodeEntities(raw);
}

/** Atom entries link their page as `<link rel="alternate" href="…"/>` (rel defaults to alternate). */
function atomLink(entry: string): string | null {
  for (const link of children(entry, "link")) {
    const rel = attribute(link, "rel");
    if (rel === null || rel === "alternate") return attribute(link, "href");
  }
  return null;
}

/**
 * Reads RSS 2.0 `<item>`s and Atom `<entry>`s with patterns (no XML dependency). Throws if the text is
 * neither, e.g. an HTML error page, so the source counts as failed.
 */
export function parseFeed(xml: string): FeedEntry[] {
  const isRss = /<rss[\s>]|<rdf:RDF[\s>]/.test(xml);
  const isAtom = /<feed[\s>]/.test(xml);
  if (!isRss && !isAtom) throw new Error("not an RSS or Atom feed");
  // Comments could hide or fake items.
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  if (isRss) {
    return children(body, "item").map((item) => ({
      title: childText(item, "title") ?? "",
      link: firstUrl(childText(item, "link") ?? ""),
      id: childText(item, "guid"),
      categories: children(item, "category")
        .map(elementText)
        .filter((c) => c !== ""),
    }));
  }
  return children(body, "entry").map((entry) => ({
    title: childText(entry, "title") ?? "",
    link: atomLink(entry),
    id: childText(entry, "id"),
    categories: children(entry, "category")
      .map((c) => attribute(c, "term") ?? "")
      .filter((c) => c !== ""),
  }));
}

/**
 * Any RSS or Atom feed listed in criteria.yaml (`kind: rss`). Feeds give no event dates (the item
 * date is when it was posted), so dates, place and access all come from the page extraction.
 */
export class RssSource implements Source {
  readonly name: string;

  constructor(
    private readonly http: Http,
    private readonly config: FeedConfig,
  ) {
    this.name = feedName("rss", config);
  }

  async fetch(): Promise<SourceResult> {
    const entries = parseFeed(await fetchFeed(this.http, this.config.url));
    const items: SourceItem[] = [];
    const warnings: string[] = [];
    if (entries.length > MAX_ITEMS) {
      warnings.push(
        `${this.name}: read the first ${String(MAX_ITEMS)} of ${String(entries.length)} items`,
      );
    }
    const read = entries.slice(0, MAX_ITEMS);
    let unreadable = 0;
    for (const entry of read) {
      if (entry.title === "" || entry.link === null) {
        unreadable++;
        warnings.push(`${this.name}: skipped an item without a title or link`);
        continue;
      }
      items.push({
        source: "rss",
        sourceId: entry.id ?? entry.link,
        url: entry.link,
        title: entry.title,
        // A feed's author is whoever posted the item, not the event's organiser.
        organiser: null,
        type: guessType(entry.title) ?? this.config.type ?? "other",
        startDate: null,
        endDate: null,
        locationText: "",
        isOnline: false,
        accessType: null,
        registerUrl: entry.link,
        prizes: null,
        tags: entry.categories,
        unverifiedFields: ["dates", "location", "access"],
      });
    }
    assertReadable(read.length, unreadable);
    return { items, warnings };
  }
}
