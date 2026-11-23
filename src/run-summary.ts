import type { RunSummary } from "./scout.js";

/** Errors shown in the Actions summary; the full list stays in `runs.errors` and the JSON line. */
const MAX_ERRORS_SHOWN = 20;

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Markdown for `$GITHUB_STEP_SUMMARY` (SPEC: tokens and $ per run printed in the Actions summary).
 * The repository is public, so this holds counts and error text only, never criteria or secrets.
 */
export function summaryMarkdown(summary: RunSummary): string {
  const rows: [string, string][] = [
    ["Sources", String(summary.sources)],
    ["Items fetched", String(summary.itemsFetched)],
    ["Dropped by rules", String(summary.itemsFiltered)],
    ["New events", String(summary.itemsNew)],
    ["LLM calls", String(summary.llmCalls)],
    ["LLM cost", `$${summary.costUsd.toFixed(4)}`],
    ["Alerts sent", String(summary.alertsSent)],
    ["Reminders sent", String(summary.remindersSent)],
    ["Errors", String(summary.errors.length)],
  ];
  const lines = [
    `## Scout run (${summary.mode})`,
    "",
    "| | |",
    "| --- | --- |",
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
  ];
  if (summary.errors.length > 0) {
    lines.push("", "### Errors", "");
    for (const error of summary.errors.slice(0, MAX_ERRORS_SHOWN)) {
      lines.push(`- ${escapeCell(error)}`);
    }
    const hidden = summary.errors.length - MAX_ERRORS_SHOWN;
    if (hidden > 0) lines.push(`- … and ${String(hidden)} more (see \`runs.errors\`)`);
  }
  if (summary.failed) {
    lines.push("", "**Run failed:** Telegram was unreachable or the run log could not be written.");
  }
  return `${lines.join("\n")}\n`;
}

/** Summary for a run that threw before it could finish (missing secret, bad criteria, DB down). */
export function failureMarkdown(error: string): string {
  return `## Scout run failed\n\n\`\`\`\n${error.replace(/`/g, "'")}\n\`\`\`\n`;
}
