import { parseArgs } from "node:util";
import { replayCriteriaPath, runScout } from "./scout.js";

const { values } = parseArgs({
  options: {
    criteria: { type: "string", default: "criteria.yaml" },
    replay: { type: "string" },
  },
});

const replayDir = values.replay;
const summary = await runScout(
  replayDir === undefined
    ? { criteriaPath: values.criteria }
    : { criteriaPath: replayCriteriaPath(replayDir), replayDir },
);
console.log(JSON.stringify(summary));
