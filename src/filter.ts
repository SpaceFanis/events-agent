import type { Criteria } from "./config.js";
import { containsPhrase } from "./normalize.js";
import type { ScoutedEvent } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type FilterResult = { keep: true } | { keep: false; reason: string };

/**
 * Free rule filter (SPEC core flow step 3). Runs before any paid call.
 * Unknown dates are kept (and flagged elsewhere) rather than guessed away.
 */
export function applyRules(event: ScoutedEvent, criteria: Criteria, now: Date): FilterResult {
  if (!criteria.eventTypes.includes(event.type)) {
    return { keep: false, reason: `type ${event.type} not wanted` };
  }

  const searchable = [event.title, event.organiser ?? "", ...event.tags];
  const matches = (keyword: string): boolean =>
    searchable.some((text) => containsPhrase(text, keyword));

  const excluded = criteria.keywords.exclude.find(matches);
  if (excluded !== undefined) return { keep: false, reason: `excluded keyword "${excluded}"` };

  if (criteria.keywords.include.length > 0 && !criteria.keywords.include.some(matches)) {
    return { keep: false, reason: "no include keyword" };
  }

  if (event.endsAt !== null && Date.parse(event.endsAt) < now.getTime()) {
    return { keep: false, reason: "already ended" };
  }

  const windowEnd = now.getTime() + criteria.dateWindowDays * DAY_MS;
  if (event.startsAt !== null && Date.parse(event.startsAt) > windowEnd) {
    return {
      keep: false,
      reason: `starts after the ${String(criteria.dateWindowDays)}-day window`,
    };
  }

  return { keep: true };
}
