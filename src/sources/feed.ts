import type { EventType } from "../event-type.js";
import type { Http } from "../http.js";

/** Shared by the feed adapters (ICS, Luma, RSS): their items carry no event type or clean URL. */

/** Checked in order: "AI Summer School Hackathon" is a summer school before it is a hackathon. */
const TYPE_PATTERNS: readonly [EventType, RegExp][] = [
  ["summer_school", /\b(summer|winter|spring|autumn) school\b/],
  ["hackathon", /\bhack(athon|athons|s|day|fest)?\b|\bbuildathon\b/],
  ["competition", /\b(competition|challenge|contest|olympiad)\b/],
  ["fellowship", /\b(fellowship|fellowships|scholarship|scholarships|residency)\b/],
  ["conference", /\b(conference|summit|symposium|congress|expo|convention)\b/],
  ["workshop", /\b(workshop|bootcamp|masterclass|tutorial)\b/],
  ["meetup", /\b(meetup|meet-up|meetups|networking|mixer)\b/],
];

/** The event type a title names ("… Hackathon 2027" → hackathon), or null if it names none. */
export function guessType(title: string): EventType | null {
  const text = title.toLowerCase();
  for (const [type, pattern] of TYPE_PATTERNS) if (pattern.test(text)) return type;
  return null;
}

/** The first http(s) URL in free text, without trailing punctuation. */
export function firstUrl(text: string): string | null {
  const match = /https?:\/\/[^\s<>"']+/.exec(text);
  if (match === null) return null;
  const url = match[0].replace(/[).,;:!?]+$/, "");
  return URL.canParse(url) ? url : null;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decodes XML/HTML character references (`&amp;`, `&#8217;`, `&#x2019;`); unknown ones stay. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith("#")) {
      const code =
        ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** Zero-width space, non-joiner, joiner and BOM, written as escapes so they stay visible. */
const ZERO_WIDTH = new RegExp("[\\u200B-\\u200D\\uFEFF]", "g");

/** Collapses whitespace, including the zero-width characters some feeds leave in titles. */
export function cleanText(text: string): string {
  return text.replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
}

/**
 * A feed's name in errors, run logs, source_health and Telegram notices. Always the configured
 * name, never the URL: feed URLs can carry secret tokens (private calendar addresses, auth query
 * strings). The broken-source streak is keyed on it, so renaming a feed starts a new streak.
 */
export function feedName(kind: string, config: { name: string }): string {
  return `${kind}: ${config.name}`;
}

/** Fetches a feed; errors name the feed's URL as "<feed url>" so its secrets stay out of logs. */
export async function fetchFeed(http: Http, url: string): Promise<string> {
  try {
    return await http.getText(url);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // Only messages reach logs; the cause stays in memory for debugging.
    throw new Error(text.split(url).join("<feed url>"), { cause: error });
  }
}

/**
 * Throws when a feed listed items but none could be read (each lacking a title or link): its
 * format changed, so the run counts as a failure of the source rather than an empty feed.
 */
export function assertReadable(listed: number, unreadable: number): void {
  if (listed > 0 && unreadable === listed) {
    throw new Error(`none of ${String(listed)} items could be read (format changed?)`);
  }
}
