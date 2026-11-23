import type { Store } from "./db/store.js";
import type { Messenger } from "./telegram.js";

export interface NoticeDeps {
  store: Pick<Store, "noticeSent" | "recordNotice">;
  messenger: Messenger;
  now: () => Date;
}

/**
 * Sends a plain-text notice at most once per `key` (e.g. `budget:2026-12`). A failure is reported in
 * `errors` and retried by the next run that hits the same condition; it never stops the run.
 */
export async function sendNoticeOnce(
  deps: NoticeDeps,
  key: string,
  text: string,
  errors: string[],
): Promise<void> {
  try {
    if (await deps.store.noticeSent(key)) return;
    const sent = await deps.messenger.send(text);
    await deps.store.recordNotice(key, sent.chatId, sent.messageId, deps.now());
  } catch (error) {
    errors.push(`notice ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
