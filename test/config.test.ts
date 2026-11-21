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

  it("rejects an invalid time zone", () => {
    const badTz = `profile: x\ninterests: [ai]\neventTypes: [hackathon]\nhome: {city: Athens, country: Greece, timezone: Europe/Athen}\nsources: [{kind: devpost}]\n`;
    expect(() => parseCriteria(badTz)).toThrow(/IANA time zone/);
  });
});
