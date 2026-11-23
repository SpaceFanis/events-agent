import { z } from "zod";

/** Kept apart from config.ts (which reads files) so the Worker can use it. */
export const eventTypeSchema = z.enum([
  "hackathon",
  "conference",
  "competition",
  "meetup",
  "workshop",
  "fellowship",
  "summer_school",
  "other",
]);

export type EventType = z.infer<typeof eventTypeSchema>;
