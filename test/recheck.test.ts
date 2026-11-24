import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { parseCriteria } from "../src/config.js";
import { LibsqlStore } from "../src/db/store.js";
import { normalizeItem } from "../src/normalize.js";
import { recheckThresholds } from "../src/recheck.js";
import type { SourceItem } from "../src/types.js";

const criteria = parseCriteria(`
profile: x
interests: [AI]
keywords: { include: [AI], exclude: [crypto] }
eventTypes: [hackathon]
home: { city: Athens, country: Greece, timezone: Europe/Athens }
minScore: { local: 5, country: 7, abroad: 9, online: 6 }
sources: [{ kind: devpost }]
`);
const now = new Date("2026-12-01T09:00:00Z");

function item(id: string, title: string): SourceItem {
  return {
    source: "devpost",
    sourceId: id,
    url: `https://h${id}.devpost.com/`,
    title,
    organiser: null,
    type: "hackathon",
    startDate: null,
    endDate: null,
    locationText: "Online",
    isOnline: true,
    accessType: "open",
    registerUrl: null,
    prizes: null,
    tags: [],
    unverifiedFields: [],
  };
}

interface Case {
  title: string;
  score: number | null;
  startsAt?: string;
  endsAt?: string;
  applyDeadline?: string;
  promote: boolean;
}

const CASES: Case[] = [
  { title: "AI ok", score: 6, endsAt: "2026-12-20T00:00:00Z", promote: true },
  { title: "AI too low", score: 5, endsAt: "2026-12-20T00:00:00Z", promote: false },
  { title: "AI ended", score: 7, endsAt: "2026-11-20T00:00:00Z", promote: false },
  {
    title: "AI deadline passed",
    score: 7,
    endsAt: "2026-12-20T00:00:00Z",
    applyDeadline: "2026-11-25T00:00:00Z",
    promote: false,
  },
  { title: "AI no dates", score: 7, promote: false },
  { title: "AI start ahead, no end", score: 7, startsAt: "2026-12-10T00:00:00Z", promote: true },
  { title: "AI start passed, no end", score: 7, startsAt: "2026-11-10T00:00:00Z", promote: false },
  // Now excluded by today's rules, whatever its score.
  { title: "AI crypto jam", score: 8, endsAt: "2026-12-20T00:00:00Z", promote: false },
  { title: "AI unscored", score: null, endsAt: "2026-12-20T00:00:00Z", promote: false },
];

describe("recheckThresholds", () => {
  it("promotes only events that qualify under today's criteria and are still ahead", async () => {
    const client = createClient({ url: ":memory:" });
    const store = new LibsqlStore(client);
    try {
      await store.migrate();
      const ids: number[] = [];
      for (const [index, c] of CASES.entries()) {
        const id = await store.insertIfNew(
          normalizeItem(item(String(index), c.title), criteria),
          "below_threshold",
          now,
        );
        if (id === null) throw new Error(`insert failed for ${c.title}`);
        await client.execute({
          sql: `UPDATE events SET score = ?, starts_at = ?, ends_at = ?, apply_deadline = ? WHERE id = ?`,
          args: [c.score, c.startsAt ?? null, c.endsAt ?? null, c.applyDeadline ?? null, id],
        });
        ids.push(id);
      }

      expect(await recheckThresholds(store, criteria, now)).toBe(2);
      for (const [index, c] of CASES.entries()) {
        const id = ids[index] ?? 0;
        const status = (await store.getEvent(id))?.status;
        expect({ title: c.title, status }).toEqual({
          title: c.title,
          status: c.promote ? "new" : "below_threshold",
        });
      }
      const audit = await client.execute(
        "SELECT event_id, action FROM actions WHERE action = 'threshold_recheck' ORDER BY event_id",
      );
      expect(audit.rows.map((row) => row["event_id"])).toEqual([ids[0], ids[5]]);

      // Idempotent: nothing left to promote.
      expect(await recheckThresholds(store, criteria, now)).toBe(0);
    } finally {
      store.close();
    }
  });
});
