import type { SourceItem } from "../types.js";

export interface SourceResult {
  items: SourceItem[];
  /** Non-fatal problems, e.g. one malformed item. A thrown error means the whole source failed. */
  warnings: string[];
}

/** A source adapter. Adding a source = one file implementing this plus a recorded fixture test. */
export interface Source {
  readonly name: string;
  fetch(): Promise<SourceResult>;
}
