import { formatDate } from "./dates.js";
import type { ScoutedEvent } from "./types.js";

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

function when(event: ScoutedEvent): string {
  if (event.startsAt === null || event.endsAt === null) return "⚠️ dates unknown";
  const start = formatDate(event.startsAt, event.timezone);
  const end = formatDate(event.endsAt, event.timezone);
  return `${start === end ? start : `${start} – ${end}`} (${event.timezone})`;
}

function access(event: ScoutedEvent): string {
  switch (event.accessType) {
    case "open":
      return "Open";
    case "application":
      return "Application required";
    case "invite":
      return "Invite only";
    case null:
      return "unknown";
  }
}

/**
 * Telegram alert (HTML parse mode). M1 shows what the source listing states; page extraction,
 * score, calendar status and buttons are added in M2–M4.
 */
export function formatAlert(event: ScoutedEvent): string {
  const lines = [
    `<b>${escapeHtml(event.title)}</b>`,
    escapeHtml(
      [TYPE_LABELS[event.type], event.organiser].filter((part) => part !== null).join(" · "),
    ),
    `🗓 ${escapeHtml(when(event))}`,
    `📍 ${escapeHtml(event.isOnline ? "Online" : event.locationText || "location unknown")}`,
    `🎟 Access: ${access(event)}`,
  ];
  if (event.registerUrl !== null) {
    lines.push(`🔗 <a href="${escapeHtml(event.registerUrl)}">Register / details</a>`);
  }
  if (event.prizes !== null) lines.push(`🏆 Prizes: ${escapeHtml(event.prizes)}`);
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
