import type { Http } from "../../src/http.js";

/** Serves recorded bodies by exact URL; anything else fails like a network error. */
export class PageHttp implements Http {
  readonly requested: string[] = [];
  constructor(private readonly pages: Record<string, string>) {}
  getJson(url: string): Promise<unknown> {
    return this.getText(url).then((text) => JSON.parse(text) as unknown);
  }
  getText(url: string): Promise<string> {
    this.requested.push(url);
    const body = this.pages[url];
    return body === undefined
      ? Promise.reject(new Error(`unexpected ${url}`))
      : Promise.resolve(body);
  }
}
