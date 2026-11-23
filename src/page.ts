import { createHash } from "node:crypto";

/** Text sent to the LLM is capped so one page can't blow the per-call cost (~15k tokens). */
export const MAX_PAGE_CHARS = 60_000;

export interface Page {
  url: string;
  /** Readable text: visible text plus any JSON-LD event data, whitespace collapsed. */
  text: string;
  /** True when `text` was cut at MAX_PAGE_CHARS. */
  truncated: boolean;
  /** Absolute http(s) link targets found on the page. */
  links: Set<string>;
  /** sha256 of `text`, stored with the cached extraction. */
  contentHash: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  euro: "€",
  pound: "£",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const point = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function collectLinks(html: string, baseUrl: string): Set<string> {
  const links = new Set<string>();
  for (const match of html.matchAll(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const raw = decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
    try {
      const url = new URL(raw, baseUrl);
      if (url.protocol === "http:" || url.protocol === "https:") links.add(url.toString());
    } catch {
      // not a URL; ignore
    }
  }
  return links;
}

/**
 * Turns an event page into compact text for extraction. Scripts and styles are dropped, except
 * JSON-LD blocks, which often carry exact start/end times with offsets.
 */
export function readPage(url: string, html: string): Page {
  const jsonLd: string[] = [];
  for (const match of html.matchAll(
    /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    const body = (match[1] ?? "").replace(/\s+/g, " ").trim();
    if (body !== "") jsonLd.push(body);
  }

  const visible = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(
        /<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");

  let text = jsonLd.length > 0 ? `${visible}\n\nStructured data:\n${jsonLd.join("\n")}` : visible;
  const truncated = text.length > MAX_PAGE_CHARS;
  if (truncated) text = text.slice(0, MAX_PAGE_CHARS);
  return {
    url,
    text,
    truncated,
    links: collectLinks(html, url),
    contentHash: createHash("sha256").update(text).digest("hex"),
  };
}
