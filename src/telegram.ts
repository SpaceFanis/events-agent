import { z } from "zod";
import type { InlineKeyboard } from "./buttons.js";

/** Plain setTimeout, so this module also runs in the Cloudflare Worker. */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface SentMessage {
  chatId: string;
  messageId: number;
}

/** Telegram, behind an interface so replay mode and tests use a fake. */
export interface Messenger {
  readonly chatId: string;
  /** Sends an HTML-formatted message, with inline buttons if given. Throws if Telegram rejects it. */
  send(html: string, keyboard?: InlineKeyboard): Promise<SentMessage>;
}

/**
 * - `message`: Telegram rejects this message (retrying it won't help; counts toward the attempt cap).
 * - `systemic`: outage, bad token/chat, rate limit (no message would get through; stop and retry next run).
 * - `unknown`: the request may have been delivered (timeout); never resend automatically.
 */
export type TelegramFailure = "message" | "systemic" | "unknown";

export class TelegramError extends Error {
  override name = "TelegramError";
  constructor(
    message: string,
    readonly failure: TelegramFailure,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const sendMessageResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.object({ message_id: z.number() }) }),
  z.object({
    ok: z.literal(false),
    description: z.string().default("unknown error"),
    parameters: z.object({ retry_after: z.number().optional() }).optional(),
  }),
]);

/** Telegram allows about one message per second per chat. */
const MIN_GAP_MS = 1_100;
/** Longest 429 back-off we wait out within a run; longer ones are retried next run. */
const MAX_RETRY_AFTER_S = 30;

export class TelegramMessenger implements Messenger {
  private lastSentAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly botToken: string,
    readonly chatId: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<unknown> = delay,
    private readonly clock: () => number = Date.now,
  ) {}

  async send(html: string, keyboard?: InlineKeyboard): Promise<SentMessage> {
    const first = await this.post(html, keyboard);
    if (first.ok) return first.sent;
    const retryAfter = first.retryAfter;
    if (retryAfter === undefined || retryAfter > MAX_RETRY_AFTER_S) throw first.error;
    await this.sleep(retryAfter * 1000);
    const second = await this.post(html, keyboard);
    if (second.ok) return second.sent;
    throw second.error;
  }

  private async post(
    html: string,
    keyboard: InlineKeyboard | undefined,
  ): Promise<
    | { ok: true; sent: SentMessage }
    | { ok: false; error: TelegramError; retryAfter: number | undefined }
  > {
    const wait = this.lastSentAt + MIN_GAP_MS - this.clock();
    if (wait > 0) await this.sleep(wait);
    this.lastSentAt = this.clock();
    let response: Response;
    let body: unknown;
    try {
      const fetchFn = this.fetchFn; // plain call: see GoogleCalendar.request
      response = await fetchFn(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(keyboard === undefined ? {} : { reply_markup: replyMarkup(keyboard) }),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      // Errors never include the URL: it contains the bot token.
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      return {
        ok: false,
        // A timeout may fire after Telegram accepted the message; a connection failure happens before it.
        error: new TelegramError(
          timedOut
            ? "telegram sendMessage timed out; it may have been delivered"
            : "telegram sendMessage: network error",
          timedOut ? "unknown" : "systemic",
          { cause: error },
        ),
        retryAfter: undefined,
      };
    }
    try {
      body = await response.json();
    } catch {
      body = null; // unreadable or not JSON; handled below
    }
    const parsed = sendMessageResponse.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        // A 2xx we couldn't read may still mean Telegram accepted the message: never resend that.
        error: new TelegramError(
          `telegram sendMessage: unreadable response (HTTP ${String(response.status)})`,
          response.ok ? "unknown" : "systemic",
        ),
        retryAfter: undefined,
      };
    }
    if (!parsed.data.ok) {
      return {
        ok: false,
        error: new TelegramError(
          `telegram sendMessage failed: ${parsed.data.description}`,
          classify(response.status, parsed.data.description),
        ),
        retryAfter: parsed.data.parameters?.retry_after,
      };
    }
    return { ok: true, sent: { chatId: this.chatId, messageId: parsed.data.result.message_id } };
  }
}

/**
 * Only known content errors are the message's fault. Every other 400 (chat upgraded to supergroup,
 * not enough rights, chat not found, …) is setup, and must not use up events' attempts.
 */
const MESSAGE_ERRORS =
  /can't parse entities|message is too long|text must be non-empty|message text is empty/i;

function classify(status: number, description: string): TelegramFailure {
  return status === 400 && MESSAGE_ERRORS.test(description) ? "message" : "systemic";
}

function replyMarkup(keyboard: InlineKeyboard): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.data })),
    ),
  };
}

/** Records messages instead of sending them. Used by replay mode and tests. */
export class FakeMessenger implements Messenger {
  readonly sent: {
    chatId: string;
    messageId: number;
    html: string;
    keyboard: InlineKeyboard | undefined;
  }[] = [];
  private nextId = 1;

  constructor(readonly chatId = "replay-chat") {}

  send(html: string, keyboard?: InlineKeyboard): Promise<SentMessage> {
    const message = { chatId: this.chatId, messageId: this.nextId++, html, keyboard };
    this.sent.push(message);
    return Promise.resolve({ chatId: message.chatId, messageId: message.messageId });
  }
}

/** The Bot API calls the webhook makes after a button press. */
export interface CallbackApi {
  /** Stops the button's spinner and shows `text` as a toast. */
  answer(callbackQueryId: string, text: string): Promise<void>;
  /** Replaces the buttons under a message (its text stays as it is). */
  editButtons(chatId: string, messageId: number, keyboard: InlineKeyboard): Promise<void>;
}

const okResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), description: z.string().default("unknown error") }),
]);

/** Toasts longer than this are cut by Telegram (answerCallbackQuery allows 0–200 characters). */
const MAX_TOAST_CHARS = 200;

/** Calls a Bot API method; errors never include the URL (it contains the bot token). */
async function callBotApi(
  fetchFn: typeof fetch,
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; description: string }> {
  let response: Response;
  try {
    response = await fetchFn(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new TelegramError(`telegram ${method}: network error or timeout`, "systemic", {
      cause: error,
    });
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // handled below
  }
  const parsed = okResponse.safeParse(json);
  if (!parsed.success) {
    throw new TelegramError(
      `telegram ${method}: unreadable response (HTTP ${String(response.status)})`,
      "systemic",
    );
  }
  return parsed.data.ok ? { ok: true } : { ok: false, description: parsed.data.description };
}

export class TelegramCallbackApi implements CallbackApi {
  constructor(
    private readonly botToken: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async answer(callbackQueryId: string, text: string): Promise<void> {
    const chars = Array.from(text);
    const toast =
      chars.length > MAX_TOAST_CHARS ? `${chars.slice(0, MAX_TOAST_CHARS - 1).join("")}…` : text;
    const result = await callBotApi(this.fetchFn, this.botToken, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: toast,
    });
    if (!result.ok) {
      throw new TelegramError(`telegram answerCallbackQuery: ${result.description}`, "systemic");
    }
  }

  async editButtons(chatId: string, messageId: number, keyboard: InlineKeyboard): Promise<void> {
    const result = await callBotApi(this.fetchFn, this.botToken, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup(keyboard),
    });
    // Re-rendering the same buttons (a double press) is not an error.
    if (!result.ok && !/message is not modified/i.test(result.description)) {
      throw new TelegramError(`telegram editMessageReplyMarkup: ${result.description}`, "systemic");
    }
  }
}

/** Records toasts and button edits. Used by tests. */
export class FakeCallbackApi implements CallbackApi {
  readonly answers: { callbackQueryId: string; text: string }[] = [];
  readonly edits: { chatId: string; messageId: number; keyboard: InlineKeyboard }[] = [];

  answer(callbackQueryId: string, text: string): Promise<void> {
    this.answers.push({ callbackQueryId, text });
    return Promise.resolve();
  }

  editButtons(chatId: string, messageId: number, keyboard: InlineKeyboard): Promise<void> {
    this.edits.push({ chatId, messageId, keyboard });
    return Promise.resolve();
  }
}

/**
 * Points the bot at the Worker. Telegram then sends `secret` in the X-Telegram-Bot-Api-Secret-Token
 * header of every update, and only button presses (callback queries) are delivered.
 */
export async function setWebhook(
  botToken: string,
  url: string,
  secret: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const result = await callBotApi(fetchFn, botToken, "setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["callback_query"],
  });
  if (!result.ok) throw new TelegramError(`telegram setWebhook: ${result.description}`, "systemic");
}
