import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** All source network reads go through this, so replay mode can serve recorded fixtures. */
export interface Http {
  getJson(url: string): Promise<unknown>;
}

export class FetchHttp implements Http {
  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  async getJson(url: string): Promise<unknown> {
    const response = await this.fetchFn(url, {
      headers: { accept: "application/json", "user-agent": "events-agent/1.0" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${String(response.status)}`);
    return response.json();
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
    this.manifest ??= manifestSchema.parse(
      JSON.parse(await readFile(join(this.dir, "http.json"), "utf8")),
    );
    const file = this.manifest[url];
    if (file === undefined) throw new Error(`replay: no fixture recorded for ${url}`);
    return JSON.parse(await readFile(join(this.dir, file), "utf8"));
  }
}
