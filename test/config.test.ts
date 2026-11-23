import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ConfigError, parseCriteria } from "../src/config.js";

describe("parseCriteria", () => {
  it("accepts the example criteria file and fills defaults", async () => {
    const criteria = parseCriteria(await readFile("criteria.example.yaml", "utf8"));
    expect(criteria.home.country).toBe("Greece");
    expect(criteria.minScore.abroad).toBe(9);
    expect(criteria.sources.map((s) => s.kind)).toEqual(["devpost", "mlh"]);
  });

  it("rejects unknown keys and bad sources with a readable error", () => {
    const bad = `profile: x\ninterests: [ai]\neventTypes: [hackathon]\nhome: {city: A, country: B, timezone: UTC}\nsources: [{kind: luma, url: not-a-url}]\ntypo: 1\n`;
    expect(() => parseCriteria(bad)).toThrow(ConfigError);
  });

  it("wraps YAML syntax errors in ConfigError", () => {
    expect(() => parseCriteria("profile: [unclosed")).toThrow(/not valid YAML/);
  });

  it("gives only the position of a YAML error, never the source text (Actions logs are public)", () => {
    const text = "profile: my private profile text\nhome: [Athens\nx: : y";
    let caught: unknown;
    try {
      parseCriteria(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const messageText = caught instanceof Error ? caught.message : "";
    expect(messageText).toMatch(/at line \d+, column \d+/);
    expect(messageText).not.toContain("private");
    expect(messageText).not.toContain("Athens");
  });

  it("takes feed sources with a required name and optional type, and refuses duplicates", () => {
    const base = `profile: x\ninterests: [ai]\neventTypes: [hackathon]\nhome: {city: A, country: B, timezone: UTC}\n`;
    const criteria = parseCriteria(
      `${base}sources:\n  - {kind: luma, url: "https://api.lu.ma/ics/get?entity=calendar&id=cal-1", name: AI Athens}\n  - {kind: rss, url: "https://example.org/feed", name: Feed, type: fellowship}\n  - {kind: ics, url: "https://example.org/feed", name: Feed}\n`,
    );
    expect(criteria.sources).toEqual([
      {
        kind: "luma",
        url: "https://api.lu.ma/ics/get?entity=calendar&id=cal-1",
        name: "AI Athens",
      },
      { kind: "rss", url: "https://example.org/feed", name: "Feed", type: "fellowship" },
      { kind: "ics", url: "https://example.org/feed", name: "Feed" },
    ]);
    // A feed URL may hold a token, so a name is required and errors never quote the URL.
    expect(() =>
      parseCriteria(`${base}sources: [{kind: ics, url: "https://a.org/private-tok"}]\n`),
    ).toThrow(ConfigError);
    expect(() =>
      parseCriteria(
        `${base}sources: [{kind: rss, url: "https://a.org/f", name: A}, {kind: rss, url: "https://a.org/g", name: A}]\n`,
      ),
    ).toThrow(/duplicate source "rss: A"/);
    expect(() =>
      parseCriteria(
        `${base}sources: [{kind: rss, url: "https://a.org/tok", name: A}, {kind: rss, url: "https://a.org/tok", name: B}]\n`,
      ),
    ).toThrow(/"rss: B" repeats another feed's URL/);
    expect(() => parseCriteria(`${base}sources: [{kind: mlh}, {kind: mlh}]\n`)).toThrow(
      /duplicate source "mlh"/,
    );
    expect(() =>
      parseCriteria(
        `${base}sources: [{kind: rss, url: "https://a.org/f", name: A, type: party}]\n`,
      ),
    ).toThrow(ConfigError);
  });

  it("rejects an invalid time zone", () => {
    const badTz = `profile: x\ninterests: [ai]\neventTypes: [hackathon]\nhome: {city: Athens, country: Greece, timezone: Europe/Athen}\nsources: [{kind: devpost}]\n`;
    expect(() => parseCriteria(badTz)).toThrow(/IANA time zone/);
  });
});
