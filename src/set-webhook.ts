import { parseArgs } from "node:util";
import { setWebhook } from "./telegram.js";

/**
 * Points the Telegram bot at the deployed Worker:
 *   npm run telegram:webhook -- --url https://<worker>.workers.dev/
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (the same secret the Worker has) from .env.
 */
const { values } = parseArgs({ options: { url: { type: "string" } } });
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (values.url === undefined || !values.url.startsWith("https://")) {
  throw new Error("pass --url https://… (the Worker's public URL)");
}
if (!token || !secret) throw new Error("set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET");
if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
  throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16–256 characters of A-Z, a-z, 0-9, _ or -");
}
await setWebhook(token, values.url, secret);
console.log(`webhook set to ${values.url} (button presses only)`);
