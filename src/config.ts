import { readFile } from "node:fs/promises";
import { parse, YAMLError } from "yaml";
import { z } from "zod";

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const eventType = z.enum([
  "hackathon",
  "conference",
  "competition",
  "meetup",
  "workshop",
  "fellowship",
  "summer_school",
  "other",
]);

const minScore = z.number().min(0).max(10);

export const criteriaSchema = z.strictObject({
  profile: z.string().min(1),
  interests: z.array(z.string().min(1)).min(1),
  keywords: z
    .strictObject({
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .default({ include: [], exclude: [] }),
  eventTypes: z.array(eventType).min(1),
  home: z.strictObject({
    city: z.string().min(1),
    country: z.string().min(1),
    timezone: z.string().refine(isValidTimeZone, "must be an IANA time zone, e.g. Europe/Athens"),
  }),
  calendar: z
    .strictObject({
      /** Add a tentative "Applied: …" hold when I press "I applied". */
      tentativeHoldOnApply: z.boolean(),
    })
    .default({ tentativeHoldOnApply: false }),
  minScore: z
    .strictObject({ local: minScore, country: minScore, abroad: minScore, online: minScore })
    .default({ local: 5, country: 7, abroad: 9, online: 6 }),
  dateWindowDays: z.number().int().positive().default(180),
  eligibility: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  limits: z
    .strictObject({
      maxLlmCallsPerRun: z.number().int().positive(),
      monthlyBudgetUsd: z.number().positive(),
    })
    .default({ maxLlmCallsPerRun: 60, monthlyBudgetUsd: 1 }),
  sources: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("devpost") }),
        z.strictObject({ kind: z.literal("mlh") }),
        // One entry per Luma calendar or city page (its ICS/page URL).
        z.strictObject({ kind: z.literal("luma"), url: z.url(), name: z.string().optional() }),
        z.strictObject({ kind: z.literal("rss"), url: z.url() }),
        z.strictObject({ kind: z.literal("ics"), url: z.url() }),
      ]),
    )
    .min(1),
});

export type Criteria = z.infer<typeof criteriaSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function parseCriteria(text: string): Criteria {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    if (error instanceof YAMLError) {
      throw new ConfigError(`criteria.yaml is not valid YAML: ${error.message}`);
    }
    throw error;
  }
  const result = criteriaSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid criteria.yaml:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function loadCriteria(path: string): Promise<Criteria> {
  return parseCriteria(await readFile(path, "utf8"));
}
