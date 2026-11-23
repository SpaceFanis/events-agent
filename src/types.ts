import type { EventType } from "./config.js";

export type LocationTier = "online" | "local" | "country" | "abroad";
export type AccessType = "open" | "application" | "invite";

/** Calendar date without a time, as "YYYY-MM-DD". */
export type IsoDate = string;

/** One item as a source adapter reports it, before normalization. */
export interface SourceItem {
  source: string;
  sourceId: string;
  url: string;
  title: string;
  organiser: string | null;
  type: EventType;
  /** Date-only start/end as listed by the source (null when it could not be parsed). */
  startDate: IsoDate | null;
  endDate: IsoDate | null;
  locationText: string;
  isOnline: boolean;
  accessType: AccessType | null;
  registerUrl: string | null;
  prizes: string | null;
  tags: string[];
  /** Fields the source could not state reliably; shown as "⚠️ unverified" in alerts. */
  unverifiedFields: string[];
}

/** An item after normalization: canonical URL, dedupe hash, location tier, UTC times. */
export interface ScoutedEvent {
  source: string;
  sourceId: string;
  canonicalUrl: string;
  /** Null when the start date is unknown (too weak to dedupe on). */
  dedupeHash: string | null;
  title: string;
  organiser: string | null;
  type: EventType;
  /** UTC ISO strings; interpret together with `timezone`. */
  startsAt: string | null;
  endsAt: string | null;
  timezone: string;
  locationText: string;
  isOnline: boolean;
  locationTier: LocationTier;
  accessType: AccessType | null;
  registerUrl: string | null;
  prizes: string | null;
  tags: string[];
  unverifiedFields: string[];
}

export interface StoredEvent extends ScoutedEvent {
  id: number;
  status: string;
}
