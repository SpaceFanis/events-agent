import { createClient } from "@libsql/client/web";
import { GoogleCalendar } from "../src/calendar.js";
import { LibsqlStore } from "../src/db/store.js";
import { TelegramCallbackApi } from "../src/telegram.js";
import { handleWebhook } from "../src/webhook.js";

/**
 * Cloudflare Worker: Telegram button presses (SPEC core flow step 2). Secrets are set with
 * `wrangler secret put` (docs/DEPLOY.md). All are required except TURSO_AUTH_TOKEN.
 */
export interface Env {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
}

const REQUIRED = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "TURSO_DATABASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
] as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const missing = REQUIRED.filter((name) => !env[name]);
    const {
      TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID,
      TELEGRAM_WEBHOOK_SECRET,
      TURSO_DATABASE_URL,
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REFRESH_TOKEN,
    } = env;
    if (
      !TELEGRAM_BOT_TOKEN ||
      !TELEGRAM_CHAT_ID ||
      !TELEGRAM_WEBHOOK_SECRET ||
      !TURSO_DATABASE_URL ||
      !GOOGLE_CLIENT_ID ||
      !GOOGLE_CLIENT_SECRET ||
      !GOOGLE_REFRESH_TOKEN
    ) {
      // Names only, never values.
      console.error(`worker misconfigured: missing ${missing.join(", ")}`);
      return new Response("misconfigured", { status: 500 });
    }
    const store = new LibsqlStore(
      createClient(
        env.TURSO_AUTH_TOKEN
          ? { url: TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN }
          : { url: TURSO_DATABASE_URL },
      ),
    );
    try {
      return await handleWebhook(request, {
        store,
        // Only the cron migrates; a Worker deployed against another schema version must not write.
        checkSchema: () => store.checkSchema(),
        telegram: new TelegramCallbackApi(TELEGRAM_BOT_TOKEN),
        calendar: new GoogleCalendar(
          {
            clientId: GOOGLE_CLIENT_ID,
            clientSecret: GOOGLE_CLIENT_SECRET,
            refreshToken: GOOGLE_REFRESH_TOKEN,
          },
          ["primary"],
          fetch,
          Date.now,
          // Telegram drops answers to old presses; keep the worst case (token + insert + update) short.
          4_000,
        ),
        chatId: TELEGRAM_CHAT_ID,
        secret: TELEGRAM_WEBHOOK_SECRET,
        now: () => new Date(),
        log: (message) => {
          console.error(message);
        },
      });
    } catch (error) {
      console.error(`worker: ${error instanceof Error ? error.message : String(error)}`);
      // Non-2xx makes Telegram redeliver the press later, which is safe (presses are idempotent).
      return new Response("error", { status: 500 });
    } finally {
      store.close();
    }
  },
};
