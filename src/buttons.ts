import { encodePress, type DismissReason, type StatusAction } from "./status.js";
import type { ActionableEvent } from "./types.js";

/** One inline button: its label and the callback data the webhook receives. */
export interface InlineButton {
  text: string;
  data: string;
}
export type InlineKeyboard = InlineButton[][];

/** What the buttons depend on. */
export type ButtonEvent = Pick<
  ActionableEvent,
  "id" | "status" | "accessType" | "startsAt" | "endsAt" | "calendarState" | "calendarEventId"
>;

const REASON_LABELS: Record<DismissReason, string> = {
  topic: "Topic",
  location: "Location",
  dates: "Dates",
  cost: "Cost",
  other: "Other",
};

export function reasonLabel(reason: string): string {
  return reason in REASON_LABELS ? REASON_LABELS[reason as DismissReason] : reason;
}

/** A rejected application whose tentative hold couldn't be deleted. */
export function needsHoldRemoval(event: ButtonEvent): boolean {
  return event.status === "rejected" && event.calendarEventId !== null;
}

/** Going/accepted events whose dates are known but have no confirmed calendar entry yet. */
export function needsCalendarEntry(event: ButtonEvent): boolean {
  return (
    (event.status === "going" || event.status === "accepted") &&
    event.startsAt !== null &&
    event.endsAt !== null &&
    event.calendarState !== "confirmed"
  );
}

/**
 * The buttons under an alert for the event's current status (SPEC "Event status machine").
 * Open events (and invite-only or unknown access) offer Going; application events offer I applied.
 * Final statuses keep a label-only button so the message shows where it ended.
 */
export function keyboardFor(event: ButtonEvent, dismissReason: string | null): InlineKeyboard {
  const id = event.id;
  const status = (action: StatusAction, text: string): InlineButton => ({
    text,
    data: encodePress({ kind: "status", action, eventId: id }),
  });
  const info = (text: string): InlineButton[] => [
    { text, data: encodePress({ kind: "info", eventId: id }) },
  ];
  const primary =
    event.accessType === "application"
      ? status("applied", "✍️ I applied")
      : status("going", "✅ Going");
  const calendarRow: InlineButton[][] = needsCalendarEntry(event)
    ? [[{ text: "📅 Add to calendar", data: encodePress({ kind: "calendar", eventId: id }) }]]
    : [];

  switch (event.status) {
    case "new":
      return [
        [primary, status("remind", "🔔 Remind me")],
        [status("dismiss", "🙅 Not interested")],
      ];
    case "watching":
      return [info("🔔 Reminders on"), [primary, status("dismiss", "🙅 Not interested")]];
    case "awaiting_result":
      return [
        info("⏳ Applied · waiting for results"),
        [status("accepted", "🎉 Accepted"), status("rejected", "❌ Rejected")],
      ];
    case "going":
      return [info("✅ Going"), ...calendarRow];
    case "accepted":
      return [info("🎉 Accepted"), ...calendarRow];
    case "rejected":
      return needsHoldRemoval(event)
        ? [
            info("❌ Rejected"),
            [
              {
                text: "🗑 Remove calendar hold",
                data: encodePress({ kind: "calendar", eventId: id }),
              },
            ],
          ]
        : [info("❌ Rejected")];
    case "dismissed":
      // No "why?" buttons: nothing used the answers. A reason given on an older message (which
      // still shows those buttons and still works) is shown here.
      return [
        info(
          dismissReason === null
            ? "🙅 Not interested"
            : `🙅 Not interested · ${reasonLabel(dismissReason)}`,
        ),
      ];
    default:
      return [];
  }
}

/** Short status text for toasts. */
export function statusLabel(status: string): string {
  switch (status) {
    case "new":
      return "no choice yet";
    case "watching":
      return "reminders on";
    case "going":
      return "going";
    case "dismissed":
      return "not interested";
    case "awaiting_result":
      return "applied, waiting for results";
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    default:
      return status.replace(/_/g, " ");
  }
}
