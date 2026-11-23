import type { EventStatus } from "./types.js";

/**
 * The event status machine (SPEC "Event status machine"):
 *
 *   new ──Going──────────► going (calendar entry)
 *    │  ──Not interested──► dismissed (reason optional)
 *    │  ──Remind me───────► watching ──(same choices, reminders in M5)
 *    └─ I applied ────────► awaiting_result ──Accepted──► accepted (calendar entry)
 *                                           └─Rejected──► rejected
 */
export type StatusAction = "going" | "remind" | "dismiss" | "applied" | "accepted" | "rejected";

export const TRANSITIONS: Readonly<
  Record<StatusAction, { from: readonly EventStatus[]; to: EventStatus }>
> = {
  going: { from: ["new", "watching"], to: "going" },
  remind: { from: ["new"], to: "watching" },
  dismiss: { from: ["new", "watching"], to: "dismissed" },
  applied: { from: ["new", "watching"], to: "awaiting_result" },
  accepted: { from: ["awaiting_result"], to: "accepted" },
  rejected: { from: ["awaiting_result"], to: "rejected" },
};

export function canApply(action: StatusAction, status: string): boolean {
  return (TRANSITIONS[action].from as readonly string[]).includes(status);
}

/** Optional "why not interested" answers, stored as the reason of a `dismiss_reason` action. */
export const DISMISS_REASONS = {
  t: "topic",
  p: "location",
  d: "dates",
  c: "cost",
  o: "other",
} as const;
export type DismissReason = (typeof DISMISS_REASONS)[keyof typeof DISMISS_REASONS];

/** What a button asks for, decoded from its callback data. */
export type Press =
  | { kind: "status"; action: StatusAction; eventId: number }
  | { kind: "reason"; reason: DismissReason; eventId: number }
  /** Retry the calendar entry after a failed insert. */
  | { kind: "calendar"; eventId: number }
  /** A label-only button: shows the current status. */
  | { kind: "info"; eventId: number };

const STATUS_CODES: Readonly<Record<string, StatusAction>> = {
  g: "going",
  r: "remind",
  d: "dismiss",
  a: "applied",
  y: "accepted",
  n: "rejected",
};

/** Compact callback data ("g:42", "w:42:t"): Telegram allows at most 64 bytes. */
export function encodePress(press: Press): string {
  const id = String(press.eventId);
  switch (press.kind) {
    case "status": {
      const code = Object.entries(STATUS_CODES).find(([, action]) => action === press.action)?.[0];
      if (code === undefined) throw new Error(`no code for ${press.action}`);
      return `${code}:${id}`;
    }
    case "reason": {
      const code = Object.entries(DISMISS_REASONS).find(([, r]) => r === press.reason)?.[0];
      if (code === undefined) throw new Error(`no code for ${press.reason}`);
      return `w:${id}:${code}`;
    }
    case "calendar":
      return `c:${id}`;
    case "info":
      return `i:${id}`;
  }
}

/** Decodes callback data; null for anything this code didn't produce. */
export function decodePress(data: string): Press | null {
  const match = /^([a-z]):([1-9]\d{0,15})(?::([a-z]))?$/.exec(data);
  if (match === null) return null;
  const [, code, idText, arg] = match;
  if (code === undefined || idText === undefined) return null;
  const eventId = Number(idText);
  if (!Number.isSafeInteger(eventId)) return null;
  if (code === "w") {
    const reason =
      arg === undefined ? undefined : DISMISS_REASONS[arg as keyof typeof DISMISS_REASONS];
    return reason === undefined ? null : { kind: "reason", reason, eventId };
  }
  if (arg !== undefined) return null;
  if (code === "c") return { kind: "calendar", eventId };
  if (code === "i") return { kind: "info", eventId };
  const action = STATUS_CODES[code];
  return action === undefined ? null : { kind: "status", action, eventId };
}
