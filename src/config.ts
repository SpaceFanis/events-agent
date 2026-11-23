import { readFile } from "node:fs/promises";
import { parse, YAMLError } from "yaml";
import { z } from "zod";
import { eventTypeSchema } from "./event-type.js";
import { feedName } from "./sources/feed.js";

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export { eventTypeSchema, type EventType } from "./event-type.js";

const minScore = z.number().min(0).max(10);

/**
 * Feed sources (Luma, RSS, ICS): their URL, a name (required: logs and Telegram notices use it, never
 * the URL, which may hold a secret token), and the type for items whose title names none.
 */
const feedOptions = {
  url: z.url(),
  name: z.string().trim().min(1),
  type: eventTypeSchema.optional(),
};

export const criteriaSchema = z.strictObject({
  profile: z.string().min(1),
  interests: z.array(z.string().min(1)).min(1),
  keywords: z
    .strictObject({
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .default({ include: [], exclude: [] }),
  eventTypes: z.array(eventTypeSchema).min(1),
  home: z.strictObject({
    city: z.string().min(1),
    country: z.string().min(1),
    timezone: z.string().refine(isValidTimeZone, "must be an IANA time zone, e.g. Europe/Athens"),
  }),
  calendar: z
    .strictObject({
      /** Add a tentative "Applied: …" hold when I press "I applied". */
      tentativeHoldOnApply: z.boolean().default(false),
      /** Google calendar ids checked for conflicts ("primary" is my main calendar). */
      check: z.array(z.string().min(1)).min(1).default(["primary"]),
    })
    .default({ tentativeHoldOnApply: false, check: ["primary"] }),
  minScore: z
    .strictObject({ local: minScore, country: minScore, abroad: minScore, online: minScore })
    .default({ local: 5, country: 7, abroad: 9, online: 6 }),
  dateWindowDays: z.number().int().positive().default(180),
  eligibility: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  limits: z
    .strictObject({
      maxLlmCallsPerRun: z.number().int().positive(),
      monthlyBudgetUsd: z.number().positive(),
      /** Alerts beyond this wait for the next run, so a backlog never floods the chat. */
      maxAlertsPerRun: z.number().int().positive().default(20),
    })
    .default({ maxLlmCallsPerRun: 60, monthlyBudgetUsd: 1, maxAlertsPerRun: 20 }),
  sources: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("devpost") }),
        z.strictObject({ kind: z.literal("mlh") }),
        // One entry per Luma calendar or city feed (its ICS URL).
        z.strictObject({ kind: z.literal("luma"), ...feedOptions }),
        z.strictObject({ kind: z.literal("rss"), ...feedOptions }),
        z.strictObject({ kind: z.literal("ics"), ...feedOptions }),
      ]),
    )
    .min(1)
    .superRefine((sources, ctx) => {
      // The name keys each source's failure streak, so two entries must never share one; the same
      // feed listed twice would fetch twice. Messages show names only, never feed URLs.
      const names = new Set<string>();
      const urls = new Set<string>();
      for (const [index, source] of sources.entries()) {
        const key = "url" in source ? feedName(source.kind, source) : source.kind;
        if (names.has(key)) {
          ctx.addIssue({ code: "custom", path: [index], message: `duplicate source "${key}"` });
        }
        names.add(key);
        if ("url" in source) {
          const urlKey = `${source.kind} ${source.url}`;
          if (urls.has(urlKey)) {
            ctx.addIssue({
              code: "custom",
              path: [index],
              message: `"${key}" repeats another feed's URL`,
            });
          }
          urls.add(urlKey);
        }
      }
    }),
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
      // Position only: yaml's message quotes the source lines, and in Actions that would put
      // fragments of the profile (or a feed URL with a token) into a public log.
      const at = error.linePos?.[0];
      const where = at ? ` at line ${String(at.line)}, column ${String(at.col)}` : "";
      throw new ConfigError(`criteria.yaml is not valid YAML (${error.code})${where}`);
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
