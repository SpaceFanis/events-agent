import { escapeHtml, formatDeadline, sourceLine } from "./alert.js";
import { keyboardFor } from "./buttons.js";
import { addDays, formatDate, formatDateTime, localDate, zonedToUtc } from "./dates.js";
import type { ReminderKind, Store } from "./db/store.js";
import { TelegramError, type Messenger } from "./telegram.js";
import type { ActionableEvent } from "./types.js";

/**
 * Deadline reminders for `watching` events, least urgent first (SPEC: 3 days and 1 day before).
 * Counted in calendar days in the event's zone: the cron runs once a day at a fixed hour, so a due
 * moment like "deadline minus 24h" could land after the day's run and push the reminder to the
 * deadline day itself.
 */
const DEADLINE_REMINDERS: readonly { kind: ReminderKind; daysBefore: number }[] = [
  { kind: "deadline_3d", daysBefore: 3 },
  { kind: "deadline_1d", daysBefore: 1 },
];

/** What a watching event's reminders count down to: its deadline, or its start if it has none. */
export function reminderAnchor(
  event: Pick<ActionableEvent, "applyDeadline" | "startsAt">,
): { at: string; what: "deadline" | "start" } | null {
  if (event.applyDeadline !== null) return { at: event.applyDeadline, what: "deadline" };
  if (event.startsAt !== null) return { at: event.startsAt, what: "start" };
  return null;
}

export interface DueReminder {
  kind: ReminderKind;
  /** UTC ISO; with the kind it identifies the reminder, so it is sent once. */
  dueAt: string;
}

/**
 * The reminder this event is due now, if any. For a watching event that is the most urgent one
 * whose time has come: a run that missed the 3-day one (or a press made 2 days before) sends only
 * one reminder, and once the 1-day one is claimed the 3-day one is never sent late.
 */
export function dueReminder(event: ActionableEvent, now: Date): DueReminder | null {
  const nowMs = now.getTime();
  if (event.status === "watching") {
    const anchor = reminderAnchor(event);
    if (anchor === null) return null;
    if (!(nowMs < Date.parse(anchor.at))) return null;
    const anchorDay = localDate(anchor.at, event.timezone);
    let due: DueReminder | null = null;
    for (const { kind, daysBefore } of DEADLINE_REMINDERS) {
      // From 00:00 local on the day that is `daysBefore` calendar days before the anchor's day.
      const dueAt = zonedToUtc(addDays(anchorDay, -daysBefore), "00:00:00", event.timezone);
      if (Date.parse(dueAt) <= nowMs) due = { kind, dueAt };
    }
    return due;
  }
  if (event.status === "awaiting_result" && event.resultsDate !== null) {
    const dueAt = resultsPassed(event.resultsDate, event.timezone);
    const ended = event.endsAt !== null && Date.parse(event.endsAt) < nowMs;
    if (Date.parse(dueAt) <= nowMs && !ended) return { kind: "results", dueAt };
  }
  return null;
}

/**
 * When the results date has passed: the next local midnight. A date-only results date is stored at
 * 00:00 local, so "results by 10 Feb" nudges on 11 Feb, not on the morning of the 10th.
 */
export function resultsPassed(resultsDate: string, timeZone: string): string {
  return zonedToUtc(addDays(localDate(resultsDate, timeZone), 1), "00:00:00", timeZone);
}

/** "today", "tomorrow" or "in 3 days": calendar days between now and `at` in `timeZone`. */
export function timeLeft(at: string, now: Date, timeZone: string): string {
  const days = Math.round(
    (Date.parse(localDate(at, timeZone)) - Date.parse(localDate(now.toISOString(), timeZone))) /
      86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${String(days)} days`;
}

/** Telegram text (HTML) for a deadline reminder or a results nudge. */
export function formatReminder(event: ActionableEvent, kind: ReminderKind, now: Date): string {
  const title = escapeHtml(event.title);
  if (kind === "results") {
    const due =
      event.resultsDate === null
        ? ""
        : ` were due ${formatDate(event.resultsDate, event.timezone)}`;
    return [
      `📬 <b>Did you get results? ${title}</b>`,
      escapeHtml(`Results${due}. Tap Accepted or Rejected to update it.`),
      sourceLine(event),
    ].join("\n");
  }
  const anchor = reminderAnchor(event);
  if (anchor === null) throw new Error("no deadline or start to remind about");
  const left = timeLeft(anchor.at, now, event.timezone);
  const label =
    anchor.what === "start"
      ? "Starts"
      : event.accessType === "application"
        ? "Applications close"
        : "Registration closes";
  const when =
    anchor.what === "deadline"
      ? formatDeadline(anchor.at, event.timezone)
      : event.unverifiedFields.includes("time")
        ? formatDate(anchor.at, event.timezone)
        : formatDateTime(anchor.at, event.timezone);
  const lines = [
    `🔔 <b>Reminder: ${title}</b>`,
    escapeHtml(`${label} ${left}: ${when} (${event.timezone})`),
  ];
  if (event.registerUrl !== null) {
    const link = event.accessType === "application" ? "Apply" : "Register / details";
    lines.push(`🔗 <a href="${escapeHtml(event.registerUrl)}">${link}</a>`);
  }
  lines.push(sourceLine(event));
  return lines.join("\n");
}

export interface ReminderDeps {
  store: Pick<
    Store,
    "eventsForReminders" | "claimReminder" | "completeReminder" | "releaseReminder"
  >;
  messenger: Messenger;
  now: () => Date;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * SPEC core flow 3: deadline reminders and results nudges, each with the event's current buttons.
 * A reminder is claimed before it is sent, so overlapping runs never send it twice. A Telegram
 * outage releases the claim and stops (retried next run); a timeout (maybe delivered) or a message
 * Telegram rejects keeps it, so it is not sent again. Returns how many were sent.
 */
export async function sendReminders(
  deps: ReminderDeps,
  errors: string[],
  /** Called when Telegram is down or misconfigured (the run should be reported as failed). */
  onOutage: () => void = () => undefined,
): Promise<number> {
  const { store, messenger } = deps;
  const now = deps.now();
  let sent = 0;
  for (const event of await store.eventsForReminders(now)) {
    const due = dueReminder(event, now);
    if (due === null) continue;
    const label = `${due.kind === "results" ? "results nudge" : "reminder"} for event ${String(event.id)}`;
    let html: string;
    try {
      html = formatReminder(event, due.kind, now);
    } catch (error) {
      errors.push(`${label}: cannot format: ${message(error)}`);
      continue;
    }
    const claim = await store.claimReminder(event.id, due.kind, due.dueAt);
    if (claim === null) continue; // sent before, or another run has it
    let result;
    try {
      result = await messenger.send(html, keyboardFor(event, null));
    } catch (error) {
      errors.push(`${label}: ${message(error)}`);
      const failure = error instanceof TelegramError ? error.failure : "systemic";
      if (failure === "systemic") {
        onOutage();
        await store.releaseReminder(claim);
        break;
      }
      continue;
    }
    sent++;
    await store.completeReminder(
      claim,
      event.id,
      due.kind,
      result.chatId,
      result.messageId,
      deps.now(),
    );
  }
  return sent;
}
