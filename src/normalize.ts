import { createHash } from "node:crypto";
import type { Criteria } from "./config.js";
import { zonedToUtc } from "./dates.js";
import type { LocationTier, ScoutedEvent, SourceItem } from "./types.js";

const TRACKING_PARAMS = /^(utm_.*|ref|ref_src|fbclid|gclid|mc_cid|mc_eid)$/i;

/** Canonical form used for dedupe: https, lowercase host, no hash, no tracking params, sorted query. */
export function canonicalUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
  }
  parsed.searchParams.sort();
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }
  return parsed.toString();
}

/** Lowercase, accents removed, punctuation collapsed to single spaces. */
export function foldText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Whole-word (or whole-phrase) match, case- and accent-insensitive. */
export function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = foldText(phrase);
  if (needle === "") return false;
  return ` ${foldText(haystack)} `.includes(` ${needle} `);
}

/** Hash of title, start date and organiser: catches the same event listed under two URLs. */
export function dedupeHash(
  title: string,
  startDate: string | null,
  organiser: string | null,
): string {
  return createHash("sha256")
    .update([foldText(title), startDate ?? "", foldText(organiser ?? "")].join("|"))
    .digest("hex");
}

export function locationTier(
  item: Pick<SourceItem, "isOnline" | "locationText">,
  home: Criteria["home"],
): { tier: LocationTier; certain: boolean } {
  if (item.isOnline) return { tier: "online", certain: true };
  const hasCity = containsPhrase(item.locationText, home.city);
  const hasCountry = containsPhrase(item.locationText, home.country);
  if (hasCity && hasCountry) return { tier: "local", certain: true };
  if (hasCountry) return { tier: "country", certain: true };
  // A city name alone is ambiguous (Athens, GA): keep it local but flag it.
  if (hasCity) return { tier: "local", certain: false };
  return { tier: "abroad", certain: true };
}

export function normalizeItem(item: SourceItem, criteria: Criteria): ScoutedEvent {
  const { tier, certain } = locationTier(item, criteria.home);
  const unverified = new Set(item.unverifiedFields);
  if (!certain) unverified.add("location");

  // Sources like Devpost list dates without times or zones. Until the page is extracted (M2) we read
  // them in the home zone when the event is online or in the home country, else in UTC, and flag it.
  const timezone = tier === "abroad" ? "UTC" : criteria.home.timezone;
  if (item.startDate !== null || item.endDate !== null) unverified.add("time");
  if (tier === "abroad" && item.startDate !== null) unverified.add("timezone");

  return {
    source: item.source,
    sourceId: item.sourceId,
    canonicalUrl: canonicalUrl(item.url),
    dedupeHash:
      item.startDate === null ? null : dedupeHash(item.title, item.startDate, item.organiser),
    title: item.title,
    organiser: item.organiser,
    type: item.type,
    startsAt: item.startDate === null ? null : zonedToUtc(item.startDate, "00:00:00", timezone),
    endsAt: item.endDate === null ? null : zonedToUtc(item.endDate, "23:59:59", timezone),
    timezone,
    locationText: item.locationText,
    isOnline: item.isOnline,
    locationTier: tier,
    accessType: item.accessType,
    registerUrl: item.registerUrl,
    prizes: item.prizes,
    tags: item.tags,
    unverifiedFields: [...unverified],
    ...(item.listingText === undefined ? {} : { listingText: item.listingText }),
  };
}
