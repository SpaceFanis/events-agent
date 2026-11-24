import type { EventType } from "./event-type.js";

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
  /**
   * The source's own data about the event as plain text (Devpost's API listing). Extraction falls
   * back to it, as weaker evidence, when the event page blocks us (401/403).
   */
  listingText?: string;
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
  /** See SourceItem.listingText. */
  listingText?: string;
}

/**
 * Fields only the page extraction (M2) can fill. Each is null when the page doesn't state it
 * or the statement couldn't be verified (then the field name is in `unverifiedFields`).
 */
export interface EventDetails {
  city: string | null;
  country: string | null;
  registerSteps: string | null;
  /** UTC ISO strings, shown in the event's `timezone`. */
  applyDeadline: string | null;
  resultsDate: string | null;
  cost: string | null;
  travelSupport: string | null;
  eligibility: string | null;
  /** Worth score 0–10 against the profile, with a one-line reason. */
  score: number | null;
  scoreReason: string | null;
}

export const NO_DETAILS: EventDetails = {
  city: null,
  country: null,
  registerSteps: null,
  applyDeadline: null,
  resultsDate: null,
  cost: null,
  travelSupport: null,
  eligibility: null,
  score: null,
  scoreReason: null,
};

/**
 * pending_extraction → new (alerted) | below_threshold (→ new later if a lowered minScore lets it through) | closed (deadline passed or ended per the page)
 * | extraction_failed (the LLM kept failing on this page). After the alert, my button presses move
 * it through the status machine (src/status.ts).
 */
export type EventStatus =
  | "pending_extraction"
  | "new"
  | "below_threshold"
  | "closed"
  | "extraction_failed"
  | InteractiveStatus;

/** Statuses only button presses reach (SPEC "Event status machine"). */
export type InteractiveStatus =
  "going" | "watching" | "dismissed" | "awaiting_result" | "accepted" | "rejected";

export interface StoredEvent extends ScoutedEvent, EventDetails {
  id: number;
  status: string;
}

/** What the Google Calendar holds for an event: a tentative "Applied" hold or the confirmed entry. */
export type CalendarState = "tentative" | "confirmed";

/** An event as the webhook sees it: with the calendar entry it created, if any. */
export interface ActionableEvent extends StoredEvent {
  calendarEventId: string | null;
  calendarState: CalendarState | null;
}
