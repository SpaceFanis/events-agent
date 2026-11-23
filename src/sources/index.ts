import type { Criteria } from "../config.js";
import type { Http } from "../http.js";
import { DevpostSource } from "./devpost.js";
import { IcsSource } from "./ics.js";
import { LumaSource } from "./luma.js";
import { MlhSource } from "./mlh.js";
import { RssSource } from "./rss.js";
import type { Source } from "./types.js";

/** Builds one adapter per configured source. */
export function buildSources(criteria: Criteria, http: Http, now: () => Date): Source[] {
  const zone = criteria.home.timezone;
  return criteria.sources.map((config): Source => {
    switch (config.kind) {
      case "devpost":
        return new DevpostSource(http);
      case "mlh":
        return new MlhSource(http, now);
      case "luma":
        return new LumaSource(http, config, zone);
      case "rss":
        return new RssSource(http, config);
      case "ics":
        return new IcsSource(http, config, zone);
    }
  });
}
