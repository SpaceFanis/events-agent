import { appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { failureMarkdown, summaryMarkdown } from "./run-summary.js";
import { createLiveDeps, createReplayDeps, runPipeline, type PipelineDeps } from "./scout.js";

const { values } = parseArgs({
  options: {
    criteria: { type: "string", default: "criteria.yaml" },
    replay: { type: "string" },
  },
});

/** Set by GitHub Actions; the run's counts and cost show up on its page. */
async function writeStepSummary(markdown: string): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) await appendFile(path, markdown);
}

async function run(deps: PipelineDeps, afterRun?: () => void): Promise<void> {
  try {
    const summary = await runPipeline(deps);
    afterRun?.();
    // stdout stays a single JSON summary line.
    console.log(JSON.stringify(summary));
    await writeStepSummary(summaryMarkdown(summary));
    // Telegram unreachable or the run log not written: fail the job so GitHub emails me.
    if (summary.failed) process.exitCode = 1;
  } finally {
    deps.store.close();
  }
}

try {
  if (values.replay === undefined) {
    await run(await createLiveDeps(values.criteria, process.env));
  } else {
    const deps = await createReplayDeps(values.replay);
    await run(deps, () => {
      // Show what would have gone to Telegram.
      for (const sent of deps.messenger.sent) {
        const buttons = (sent.keyboard ?? [])
          .map((row) => row.map((button) => `[${button.text}]`).join(" "))
          .join("\n");
        console.error(`--- telegram ---\n${sent.html}\n${buttons}\n`);
      }
    });
  }
} catch (error) {
  // Message only, no stack: Actions logs are public, and our messages are written not to leak.
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`scout failed: ${text}`);
  await writeStepSummary(failureMarkdown(text));
  process.exitCode = 1;
}
