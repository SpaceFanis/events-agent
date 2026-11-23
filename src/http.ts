import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** All source network reads go through this, so replay mode can serve recorded fixtures. */
/** A non-2xx response; `status` lets callers tell a gone page (404/410) from an outage. */
export class HttpError extends Error {
  override name = "HttpError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Http {
  getJson(url: string): Promise<unknown>;
  /** Fetches a page (HTML) as text. */
  getText(url: string): Promise<string>;
}

/** Pages larger than this are refused rather than read into memory. */
const MAX_PAGE_BYTES = 5_000_000;

export class FetchHttp implements Http {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  async getJson(url: string): Promise<unknown> {
    const response = await this.fetchFn(url, {
      headers: { accept: "application/json", "user-agent": "hackscout/1.0" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new HttpError(`GET ${url} failed: HTTP ${String(response.status)}`, response.status);
    }
    return response.json();
  }

  async getText(url: string): Promise<string> {
    const response = await this.fetchFn(url, {
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "hackscout/1.0" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new HttpError(`GET ${url} failed: HTTP ${String(response.status)}`, response.status);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_PAGE_BYTES)
      throw new Error(`GET ${url}: page too large (${String(declared)} bytes)`);
    const body = await response.text();
    if (body.length > MAX_PAGE_BYTES) throw new Error(`GET ${url}: page too large`);
    return body;
  }
}

const manifestSchema = z.record(z.string(), z.string());

/**
 * Serves recorded responses from `<dir>/http.json`, a map of exact URL → fixture file name.
 * Any URL without a fixture fails, so replay can never fall through to the network.
 */
export class ReplayHttp implements Http {
  private manifest: Record<string, string> | undefined;

  constructor(private readonly dir: string) {}

  async getJson(url: string): Promise<unknown> {
    return JSON.parse(await this.getText(url));
  }

  async getText(url: string): Promise<string> {
    this.manifest ??= manifestSchema.parse(
      JSON.parse(await readFile(join(this.dir, "http.json"), "utf8")),
    );
    const file = this.manifest[url];
    if (file === undefined) throw new Error(`replay: no fixture recorded for ${url}`);
    return readFile(join(this.dir, file), "utf8");
  }
}
