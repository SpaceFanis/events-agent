import { parseArgs } from "node:util";
import { createLiveDeps, createReplayDeps, runPipeline, type PipelineDeps } from "./scout.js";

const { values } = parseArgs({
  options: {
    criteria: { type: "string", default: "criteria.yaml" },
    replay: { type: "string" },
  },
});

async function run(deps: PipelineDeps, afterRun?: () => void): Promise<void> {
  try {
    const summary = await runPipeline(deps);
    afterRun?.();
    // stdout stays a single JSON summary line.
    console.log(JSON.stringify(summary));
  } finally {
    deps.store.close();
  }
}

if (values.replay === undefined) {
  await run(await createLiveDeps(values.criteria, process.env));
} else {
  const deps = await createReplayDeps(values.replay);
  await run(deps, () => {
    // Show what would have gone to Telegram.
    for (const sent of deps.messenger.sent) console.error(`--- telegram ---\n${sent.html}\n`);
  });
}
