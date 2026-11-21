import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

// Acceptance test skeleton (docs/SPEC.md "End-to-end acceptance test").
// Grows into the full replay scenario as milestones M1–M5 land.
describe("scout CLI in replay mode", () => {
  it("runs offline against fixtures and prints a run summary", async () => {
    const { stdout } = await run("npx", [
      "tsx",
      "src/main.ts",
      "--replay",
      "test/fixtures/replay-basic",
    ]);
    const summary = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(summary).toMatchObject({ mode: "replay", sources: 2, llmCalls: 0, costUsd: 0 });
  });
});
