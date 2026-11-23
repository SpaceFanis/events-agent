import type { Criteria } from "../config.js";
import type { Http } from "../http.js";
import { DevpostSource } from "./devpost.js";
import type { Source } from "./types.js";

/** Builds adapters for the configured sources. Kinds without an adapter yet are reported, not failed. */
export function buildSources(
  criteria: Criteria,
  http: Http,
): { sources: Source[]; skipped: string[] } {
  const sources: Source[] = [];
  const skipped: string[] = [];
  for (const config of criteria.sources) {
    switch (config.kind) {
      case "devpost":
        sources.push(new DevpostSource(http));
        break;
      // MLH, Luma and RSS/ICS adapters land in M5 (docs/SPEC.md).
      case "mlh":
      case "luma":
      case "rss":
      case "ics":
        skipped.push(config.kind);
        break;
    }
  }
  return { sources, skipped };
}
