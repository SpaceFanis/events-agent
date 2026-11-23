import { describe, expect, it } from "vitest";
import { summaryMarkdown } from "../src/run-summary.js";
import type { RunSummary } from "../src/scout.js";

const base: RunSummary = {
  mode: "live",
  sources: 4,
  itemsFetched: 120,
  itemsFiltered: 100,
  itemsNew: 6,
  llmCalls: 7,
  alertsSent: 2,
  remindersSent: 1,
  costUsd: 0.012345,
  errors: [],
  failed: false,
};

describe("summaryMarkdown", () => {
  it("renders counts and cost as a table", () => {
    const markdown = summaryMarkdown(base);
    expect(markdown).toContain("## Scout run (live)");
    expect(markdown).toContain("| LLM calls | 7 |");
    expect(markdown).toContain("| LLM cost | $0.0123 |");
    expect(markdown).toContain("| Alerts sent | 2 |");
    expect(markdown).toContain("| Reminders sent | 1 |");
    expect(markdown).not.toContain("### Errors");
  });

  it("lists errors on one line each and caps the list", () => {
    const errors = Array.from({ length: 23 }, (_, i) => `source ${String(i)} | down\nretry`);
    const markdown = summaryMarkdown({ ...base, errors });
    expect(markdown).toContain("| Errors | 23 |");
    expect(markdown).toContain("- source 0 \\| down retry");
    expect(markdown).toContain("- source 19 \\| down retry");
    expect(markdown).not.toContain("source 20 ");
    expect(markdown).toContain("- … and 3 more (see `runs.errors`)");
  });
});
