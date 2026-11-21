import { join } from "node:path";
import { loadCriteria, type Criteria } from "./config.js";

export interface RunSummary {
  mode: "live" | "replay";
  sources: number;
  itemsFetched: number;
  itemsNew: number;
  llmCalls: number;
  alertsSent: number;
  costUsd: number;
}

export interface ScoutOptions {
  /** Path to criteria.yaml. */
  criteriaPath: string;
  /** Directory of recorded fixtures; when set, no network calls are made. */
  replayDir?: string;
}

/**
 * Runs one scouting pass. The pipeline stages (fetch → dedupe → filter → extract →
 * calendar → alert) land in milestones M1–M5 of docs/SPEC.md.
 */
export async function runScout(options: ScoutOptions): Promise<RunSummary> {
  const criteria: Criteria = await loadCriteria(options.criteriaPath);
  return {
    mode: options.replayDir === undefined ? "live" : "replay",
    sources: criteria.sources.length,
    itemsFetched: 0,
    itemsNew: 0,
    llmCalls: 0,
    alertsSent: 0,
    costUsd: 0,
  };
}

export function replayCriteriaPath(replayDir: string): string {
  return join(replayDir, "criteria.yaml");
}
