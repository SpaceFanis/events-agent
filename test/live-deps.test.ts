import { describe, expect, it } from "vitest";
import { createLiveDeps, replayCriteriaPath } from "../src/scout.js";

// Fails before any store is opened or network call is made, so this stays offline.
const CRITERIA = replayCriteriaPath("test/fixtures/replay-basic");
const BASE = {
  TELEGRAM_BOT_TOKEN: "bot-token-value",
  TELEGRAM_CHAT_ID: "4242",
  TURSO_DATABASE_URL: "libsql://example.invalid",
  ANTHROPIC_API_KEY: "anthropic-key-value",
};

describe("createLiveDeps", () => {
  it("requires the Google credentials in production, naming the variable but not any value", async () => {
    const env = { ...BASE, GOOGLE_CLIENT_ID: "client-id-value", GOOGLE_CLIENT_SECRET: "s3cret" };
    const error = await createLiveDeps(CRITERIA, env).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    const text = error instanceof Error ? error.message : "";
    expect(text).toBe("missing environment variable GOOGLE_REFRESH_TOKEN");
    expect(text).not.toContain("s3cret");
  });

  it("refuses a local database in GitHub Actions", async () => {
    const env = {
      ...BASE,
      GITHUB_ACTIONS: "true",
      TURSO_DATABASE_URL: "file:events.db",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REFRESH_TOKEN: "refresh",
    };
    await expect(createLiveDeps(CRITERIA, env)).rejects.toThrow(/must be a remote database/);
  });
});
