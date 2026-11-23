import type { CalendarStatus } from "./calendar.js";
import { formatDate, formatDateTime } from "./dates.js";
import type { EventDetails, ScoutedEvent } from "./types.js";

export type AlertEvent = ScoutedEvent & EventDetails;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TYPE_LABELS: Record<ScoutedEvent["type"], string> = {
  hackathon: "Hackathon",
  conference: "Conference",
  competition: "Competition",
  meetup: "Meetup",
  workshop: "Workshop",
  fellowship: "Fellowship",
  summer_school: "Summer school",
  other: "Event",
};

const MAX_TAGS = 8;

const SOURCE_LABELS: Record<string, string> = { devpost: "Devpost", mlh: "MLH", luma: "Luma" };

function when(event: AlertEvent): string {
  if (event.startsAt === null || event.endsAt === null) return "⚠️ dates unknown";
  // Times are shown only when the page stated them; date-only listings show dates.
  const format = event.unverifiedFields.includes("time") ? formatDate : formatDateTime;
  const start = format(event.startsAt, event.timezone);
  const end = format(event.endsAt, event.timezone);
  return `${start === end ? start : `${start} – ${end}`} (${event.timezone})`;
}

/**
 * Deadlines the page gave as a date only are stored at 23:59:59 local time; times read from a page
 * always have :00 seconds. Zone offsets are whole minutes, so the UTC seconds tell them apart.
 */
function formatDeadline(utcIso: string, timeZone: string): string {
  return new Date(utcIso).getUTCSeconds() === 59
    ? formatDate(utcIso, timeZone)
    : formatDateTime(utcIso, timeZone);
}

function access(event: AlertEvent): string {
  switch (event.accessType) {
    case "open":
      return event.applyDeadline === null
        ? "Open"
        : `Open · register by ${formatDeadline(event.applyDeadline, event.timezone)}`;
    case "application": {
      const parts = ["Application required"];
      if (event.applyDeadline !== null) {
        parts.push(`deadline ${formatDeadline(event.applyDeadline, event.timezone)}`);
      }
      if (event.resultsDate !== null) {
        parts.push(`results ${formatDate(event.resultsDate, event.timezone)}`);
      }
      return parts.join(" · ");
    }
    case "invite":
      return "Invite only";
    case null:
      return "unknown";
  }
}

function calendarLine(status: CalendarStatus): string {
  switch (status.kind) {
    case "free":
      return "free";
    case "conflicts": {
      const titles = status.titles.map((title) => `"${title}"`).join(", ");
      const more =
        status.more > 0 ? ` +${String(status.more)} more` : status.truncated ? " and more" : "";
      return `conflicts with ${titles}${more}`;
    }
    case "unknown":
      return `couldn't check (${status.reason})`;
  }
}

/**
 * Telegram alert (HTML parse mode, SPEC "Alert content"). Shows only listing data and page facts
 * that passed validation; everything else is named in the "unverified" line. Buttons arrive in M4.
 */
export function formatAlert(event: AlertEvent, calendar: CalendarStatus): string {
  const lines = [
    `<b>${escapeHtml(event.title)}</b>`,
    escapeHtml(
      [TYPE_LABELS[event.type], event.organiser].filter((part) => part !== null).join(" · "),
    ),
    `🗓 ${escapeHtml(when(event))}`,
    `📍 ${escapeHtml(event.isOnline ? "Online" : event.locationText || "location unknown")}`,
    `🎟 Access: ${escapeHtml(access(event))}`,
  ];
  if (event.registerUrl !== null) {
    const label = event.accessType === "application" ? "Apply" : "Register / details";
    lines.push(`🔗 <a href="${escapeHtml(event.registerUrl)}">${label}</a>`);
  }
  if (event.registerSteps !== null) lines.push(`📝 ${escapeHtml(event.registerSteps)}`);
  if (event.cost !== null) lines.push(`💶 Cost: ${escapeHtml(event.cost)}`);
  if (event.travelSupport !== null) {
    lines.push(`✈️ Travel support: ${escapeHtml(event.travelSupport)}`);
  }
  if (event.prizes !== null) lines.push(`🏆 Prizes: ${escapeHtml(event.prizes)}`);
  if (event.eligibility !== null) lines.push(`🎓 Eligibility: ${escapeHtml(event.eligibility)}`);
  lines.push(`📅 Calendar: ${escapeHtml(calendarLine(calendar))}`);
  if (event.score !== null) {
    const reason = event.scoreReason === null ? "" : ` · ${escapeHtml(event.scoreReason)}`;
    lines.push(`⭐ Worth it: ${String(event.score)}/10${reason}`);
  }
  if (event.tags.length > 0) {
    // Bounded so the message stays well under Telegram's 4096-character limit.
    const shown = event.tags.slice(0, MAX_TAGS).map((tag) => tag.slice(0, 60));
    const more = event.tags.length > MAX_TAGS ? ` +${String(event.tags.length - MAX_TAGS)}` : "";
    lines.push(`🏷 ${escapeHtml(shown.join(", "))}${more}`);
  }
  const source = SOURCE_LABELS[event.source] ?? event.source;
  lines.push(`Source: <a href="${escapeHtml(event.canonicalUrl)}">${escapeHtml(source)}</a>`);
  if (event.unverifiedFields.length > 0) {
    lines.push(`⚠️ unverified: ${escapeHtml(event.unverifiedFields.join(", "))}`);
  }
  return lines.join("\n");
}
