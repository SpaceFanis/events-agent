import { z } from "zod";
import {
  keyboardFor,
  needsCalendarEntry,
  needsHoldRemoval,
  reasonLabel,
  statusLabel,
} from "./buttons.js";
import { calendarEntryFor, calendarEntryId, type CalendarWriter } from "./calendar.js";
import { SchemaMismatchError, type Store } from "./db/store.js";
import { SETTING_TENTATIVE_HOLD } from "./settings.js";
import { canApply, decodePress, TRANSITIONS, type Press } from "./status.js";
import type { CallbackApi } from "./telegram.js";
import type { ActionableEvent, CalendarState } from "./types.js";

/** Everything the webhook touches, injected so tests and replay use fakes. */
export interface WebhookDeps {
  store: Pick<
    Store,
    | "getEvent"
    | "transitionStatus"
    | "recordDismissReason"
    | "latestReason"
    | "setCalendarEntry"
    | "getSetting"
  >;
  telegram: CallbackApi;
  calendar: CalendarWriter;
  /** The only chat whose presses count (TELEGRAM_CHAT_ID). */
  chatId: string;
  /** setWebhook's secret_token; Telegram echoes it in X-Telegram-Bot-Api-Secret-Token. */
  secret: string;
  now: () => Date;
  /**
   * Runs once the request is known to be authentic, before any DB work (the Worker passes
   * store.checkSchema). A SchemaMismatchError answers 500 so Telegram redelivers after a redeploy;
   * any other failure (DB down) is answered with a "try again" toast.
   */
  checkSchema?: () => Promise<void>;
  /** Where errors go (console.error in the Worker). Never given tokens. */
  log: (message: string) => void;
}

const update = z.object({
  update_id: z.number(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      message: z
        .object({
          message_id: z.number(),
          chat: z.object({ id: z.union([z.number(), z.string()]) }),
        })
        .optional(),
    })
    .optional(),
});

/** Constant-time string comparison, so the secret can't be guessed byte by byte from timings. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Telegram webhook (Cloudflare Worker): a button press updates the event status in the DB, writes
 * to Google Calendar when needed, replaces the message's buttons and answers with a toast.
 *
 * Always answers 200 once the request is authentic: Telegram redelivers non-2xx updates and holds
 * back newer ones meanwhile. Presses are idempotent (compare-and-set status, deterministic calendar
 * ids), so a redelivered or doubled press changes nothing.
 */
export async function handleWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!sameSecret(request.headers.get("x-telegram-bot-api-secret-token") ?? "", deps.secret)) {
    return new Response("unauthorized", { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const parsed = update.safeParse(body);
  if (!parsed.success) return new Response("bad request", { status: 400 });
  const query = parsed.data.callback_query;
  if (query === undefined) return new Response("ignored");

  const respond = async (text: string): Promise<Response> => {
    try {
      await deps.telegram.answer(query.id, text);
    } catch (error) {
      deps.log(`answerCallbackQuery: ${message(error)}`);
    }
    return new Response("ok");
  };

  const chat = query.message?.chat.id;
  if (query.message === undefined || chat === undefined || String(chat) !== deps.chatId) {
    deps.log(`ignored a press from chat ${String(chat)}`);
    return respond("Not allowed.");
  }
  const press = decodePress(query.data ?? "");
  if (press === null) return respond("Unknown button.");

  let outcome: { toast: string; event: ActionableEvent | null };
  try {
    await deps.checkSchema?.();
    outcome = await applyPress(deps, press);
  } catch (error) {
    deps.log(`press ${query.data ?? ""}: ${message(error)}`);
    if (error instanceof SchemaMismatchError)
      return new Response("schema mismatch", { status: 500 });
    return respond("Couldn't save that, please try again.");
  }
  if (outcome.event !== null) {
    const event = outcome.event;
    try {
      const reason =
        event.status === "dismissed"
          ? await deps.store.latestReason(event.id, "dismiss_reason")
          : null;
      await deps.telegram.editButtons(
        String(chat),
        query.message.message_id,
        keyboardFor(event, reason),
      );
    } catch (error) {
      // The status is saved; only the buttons are stale. A press on them re-renders.
      deps.log(`edit buttons for event ${String(event.id)}: ${message(error)}`);
    }
  }
  return respond(outcome.toast);
}

/** Applies one press; returns the toast and the event as it now is (null if it doesn't exist). */
async function applyPress(
  deps: WebhookDeps,
  press: Press,
): Promise<{ toast: string; event: ActionableEvent | null }> {
  const { store } = deps;
  const event = await store.getEvent(press.eventId);
  if (event === null) return { toast: "That event is no longer in the database.", event: null };

  switch (press.kind) {
    case "info":
      return { toast: `Status: ${statusLabel(event.status)}.`, event };

    case "reason": {
      if (event.status !== "dismissed") {
        return { toast: `Status: ${statusLabel(event.status)}.`, event };
      }
      if (!(await store.recordDismissReason(event.id, press.reason, deps.now()))) {
        return { toast: "Reason already noted.", event };
      }
      return { toast: `Noted: ${reasonLabel(press.reason)}.`, event };
    }

    case "calendar": {
      if (needsHoldRemoval(event)) {
        return { toast: await removeHold(deps, event), event: await reload(deps, event) };
      }
      if (!needsCalendarEntry(event)) {
        return { toast: `Status: ${statusLabel(event.status)}.`, event };
      }
      const note = await writeCalendar(deps, event, "confirmed");
      return { toast: note, event: await reload(deps, event) };
    }

    case "status": {
      const { action } = press;
      if (!canApply(action, event.status)) {
        // Double press, redelivered update or an old message: show where the event really is.
        return { toast: `Already ${statusLabel(event.status)}.`, event };
      }
      const to = TRANSITIONS[action].to;
      const moved = await store.transitionStatus(event.id, event.status, to, action, deps.now());
      if (!moved) {
        // Another press got there first.
        const now = await reload(deps, event);
        return { toast: `Already ${statusLabel(now.status)}.`, event: now };
      }
      const updated: ActionableEvent = { ...event, status: to };
      const notes = [`Saved: ${statusLabel(to)}.`];
      if (action === "going" || action === "accepted") {
        notes.push(await writeCalendar(deps, updated, "confirmed"));
      } else if (action === "applied" && (await tentativeHoldOn(deps))) {
        notes.push(await writeCalendar(deps, updated, "tentative"));
      } else if (
        action === "rejected" &&
        // A hold may exist even if its id wasn't stored (the insert timed out after Google made it).
        (updated.calendarEventId !== null || (await tentativeHoldOn(deps)))
      ) {
        notes.push(await removeHold(deps, updated));
      }
      return { toast: notes.join(" "), event: await reload(deps, updated) };
    }
  }
}

async function reload(deps: WebhookDeps, fallback: ActionableEvent): Promise<ActionableEvent> {
  return (await deps.store.getEvent(fallback.id)) ?? fallback;
}

async function tentativeHoldOn(deps: WebhookDeps): Promise<boolean> {
  return (await deps.store.getSetting(SETTING_TENTATIVE_HOLD)) === "true";
}

/**
 * Creates or updates the event's calendar entry. A failure leaves the status as saved and is
 * reported in the toast; going/accepted events then show an "Add to calendar" retry button.
 */
async function writeCalendar(
  deps: WebhookDeps,
  event: ActionableEvent,
  state: CalendarState,
): Promise<string> {
  const entry = await calendarEntryFor(event, state);
  if (entry === null) return "Dates unknown, so nothing was added to your calendar.";
  try {
    await deps.calendar.upsert(entry);
  } catch (error) {
    deps.log(`calendar write for event ${String(event.id)}: ${message(error)}`);
    return `Couldn't add it to your calendar (${message(error)}).`;
  }
  await deps.store.setCalendarEntry(event.id, entry.id, state, deps.now());
  return state === "tentative"
    ? "Tentative hold added to your calendar."
    : "Added to your calendar.";
}

/**
 * Deletes the tentative hold by its deterministic id (already gone counts as done). On failure the
 * id is stored, so the rejected message shows a "Remove calendar hold" retry button.
 */
async function removeHold(deps: WebhookDeps, event: ActionableEvent): Promise<string> {
  const id = event.calendarEventId ?? (await calendarEntryId(event.canonicalUrl));
  try {
    await deps.calendar.remove(id);
  } catch (error) {
    deps.log(`calendar delete for event ${String(event.id)}: ${message(error)}`);
    await deps.store.setCalendarEntry(event.id, id, "tentative", deps.now());
    return `Couldn't remove the calendar hold (${message(error)}).`;
  }
  await deps.store.setCalendarEntry(event.id, null, null, deps.now());
  return "Calendar hold removed.";
}
