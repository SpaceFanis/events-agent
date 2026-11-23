/**
 * One-time setup: gets a Google OAuth refresh token for the calendar check (and M4's inserts).
 * Needs a "Desktop app" OAuth client in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (e.g. in .env).
 * Opens nothing itself: prints the consent URL, waits for Google's redirect on 127.0.0.1, then
 * prints the refresh token to put in GOOGLE_REFRESH_TOKEN.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";

const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
if (clientId === "" || clientSecret === "") {
  console.error(
    "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a Desktop app OAuth client) first.",
  );
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const redirectUri = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
consent.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  // Forces a refresh token even if this client was approved before.
  prompt: "consent",
  state,
}).toString();
console.error(`Open this URL, approve, and come back here:\n\n${consent.toString()}\n`);

const code = await new Promise<string>((resolve, reject) => {
  server.on("request", (req, res) => {
    const params = new URL(req.url ?? "/", redirectUri).searchParams;
    if (params.get("state") !== state) {
      res.writeHead(400).end("State mismatch; ignored.");
      return;
    }
    const received = params.get("code");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(received === null ? "No code received." : "Done. You can close this tab.");
    if (received === null) reject(new Error(`consent failed: ${params.get("error") ?? "no code"}`));
    else resolve(received);
  });
}).finally(() => server.close());

const response = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  }).toString(),
});
const parsed = z.object({ refresh_token: z.string() }).safeParse(await response.json());
if (!parsed.success) {
  console.error(`Token exchange failed (HTTP ${String(response.status)}).`);
  process.exit(1);
}
console.error("Put this in GOOGLE_REFRESH_TOKEN (.env locally, a repo secret for Actions):");
console.log(parsed.data.refresh_token);
