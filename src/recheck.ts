import type { Criteria } from "./config.js";
import type { Store } from "./db/store.js";
import { decideStatus } from "./extract.js";
import { applyRules } from "./filter.js";
import { locationTier } from "./normalize.js";
import type { StoredEvent } from "./types.js";

/**
 * Events scored below their tier's minimum are compared with the current criteria again each run,
 * so lowering a threshold in criteria.yaml also reaches events already scored. Free: the scores are
 * stored, no LLM call. Only promotes below_threshold → new (then alerted as usual, capped by
 * maxAlertsPerRun). An event is promoted only if it still passes today's rule filter (types,
 * keywords, date window), its tier is recomputed from today's `home`, it has not ended, its
 * deadline has not passed, and it has a known date still ahead (events with no end date are not
 * promoted once their start has passed, and events with no dates at all never are: too risky to
 * alert late). Returns how many events moved to `new`.
 */
export async function recheckThresholds(
  store: Store,
  criteria: Criteria,
  now: Date,
): Promise<number> {
  const lowestMinimum = Math.min(...Object.values(criteria.minScore));
  let promoted = 0;
  for (const stored of await store.eventsBelowThreshold(now, lowestMinimum)) {
    const event = withCurrentTier(stored, criteria);
    if (!hasDateAhead(event, now)) continue;
    if (!applyRules(event, criteria, now).keep) continue;
    if (decideStatus(event, criteria, now) !== "new") continue;
    // Compare-and-set, with an audit row; an overlapping run can't promote it twice.
    if (
      await store.transitionStatus(event.id, "below_threshold", "new", "threshold_recheck", now)
    ) {
      promoted++;
    }
  }
  return promoted;
}

/** The tier under today's `home` (it may have changed since the event was scored). */
function withCurrentTier(event: StoredEvent, criteria: Criteria): StoredEvent {
  const locationText = [event.locationText, event.city, event.country]
    .filter((part): part is string => part !== null && part !== "")
    .join(", ");
  const { tier } = locationTier({ isOnline: event.isOnline, locationText }, criteria.home);
  return { ...event, locationTier: tier };
}

function hasDateAhead(event: StoredEvent, now: Date): boolean {
  const nowIso = now.toISOString();
  if (event.endsAt !== null) return event.endsAt >= nowIso;
  return event.startsAt !== null && event.startsAt >= nowIso;
}
