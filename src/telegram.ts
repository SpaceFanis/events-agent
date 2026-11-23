import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

export interface SentMessage {
  chatId: string;
  messageId: number;
}

/** Telegram, behind an interface so replay mode and tests use a fake. */
export interface Messenger {
  readonly chatId: string;
  /** Sends an HTML-formatted message. Throws if Telegram rejects it. */
  send(html: string): Promise<SentMessage>;
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

  async send(html: string): Promise<SentMessage> {
    const first = await this.post(html);
    if (first.ok) return first.sent;
    const retryAfter = first.retryAfter;
    if (retryAfter === undefined || retryAfter > MAX_RETRY_AFTER_S) throw first.error;
    await this.sleep(retryAfter * 1000);
    const second = await this.post(html);
    if (second.ok) return second.sent;
    throw second.error;
  }

  private async post(
    html: string,
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
      response = await this.fetchFn(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: html,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
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

/** Records messages instead of sending them. Used by replay mode and tests. */
export class FakeMessenger implements Messenger {
  readonly sent: { chatId: string; messageId: number; html: string }[] = [];
  private nextId = 1;

  constructor(readonly chatId = "replay-chat") {}

  send(html: string): Promise<SentMessage> {
    const message = { chatId: this.chatId, messageId: this.nextId++, html };
    this.sent.push(message);
    return Promise.resolve({ chatId: message.chatId, messageId: message.messageId });
  }
}
