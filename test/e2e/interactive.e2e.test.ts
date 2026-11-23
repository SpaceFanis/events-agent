import { describe, expect, it } from "vitest";
import type { InlineKeyboard } from "../../src/buttons.js";
import { createReplayDeps, runPipeline } from "../../src/scout.js";
import { FakeCallbackApi } from "../../src/telegram.js";
import { handleWebhook, type WebhookDeps } from "../../src/webhook.js";

const FIXTURE = "test/fixtures/replay-basic";
const SECRET = "replay-secret-0123456789";

function labels(keyboard: InlineKeyboard | undefined): string[][] {
  return (keyboard ?? []).map((row) => row.map((button) => button.text));
}

/** The callback data of the button with this label. */
function data(keyboard: InlineKeyboard | undefined, label: string): string {
  const button = (keyboard ?? []).flat().find((b) => b.text === label);
  if (button === undefined) throw new Error(`no "${label}" button`);
  return button.data;
}

// docs/SPEC.md "End-to-end acceptance test", steps 4 (buttons), 6 and 7: the scout run sends alerts
// with buttons, then Telegram callbacks go through the Worker's webhook handler against the same DB.
describe("button presses in replay mode", () => {
  it("I applied → Accepted moves the status and inserts one calendar entry", async () => {
    const deps = await createReplayDeps(FIXTURE);
    const telegram = new FakeCallbackApi();
    const webhook: WebhookDeps = {
      store: deps.store,
      telegram,
      calendar: deps.calendar,
      chatId: deps.messenger.chatId,
      secret: SECRET,
      now: deps.now,
      log: (line) => {
        throw new Error(`unexpected webhook log: ${line}`);
      },
    };
    let updateId = 0;
    const press = async (buttonData: string, messageId: number): Promise<string | undefined> => {
      const response = await handleWebhook(
        new Request("https://worker.example/", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": SECRET },
          body: JSON.stringify({
            update_id: ++updateId,
            callback_query: {
              id: `q${String(updateId)}`,
              data: buttonData,
              message: { message_id: messageId, chat: { id: deps.messenger.chatId } },
            },
          }),
        }),
        webhook,
      );
      expect(response.status).toBe(200);
      return telegram.answers.at(-1)?.text;
    };

    try {
      expect((await runPipeline(deps)).alertsSent).toBe(2);
      const [online, athens] = deps.messenger.sent;
      if (online === undefined || athens === undefined) throw new Error("expected two alerts");
      // Step 4: (a) is open, (b) needs an application.
      expect(labels(online.keyboard)).toEqual([
        ["✅ Going", "🔔 Remind me"],
        ["🙅 Not interested"],
      ]);
      expect(labels(athens.keyboard)).toEqual([
        ["✍️ I applied", "🔔 Remind me"],
        ["🙅 Not interested"],
      ]);
      const athensId = Number(data(athens.keyboard, "✍️ I applied").split(":")[1]);

      // Step 6: I applied → awaiting_result, buttons become Accepted / Rejected.
      expect(await press(data(athens.keyboard, "✍️ I applied"), athens.messageId)).toBe(
        "Saved: applied, waiting for results.",
      );
      expect((await deps.store.getEvent(athensId))?.status).toBe("awaiting_result");
      const afterApply = telegram.edits.at(-1);
      expect(afterApply?.messageId).toBe(athens.messageId);
      expect(labels(afterApply?.keyboard)).toEqual([
        ["⏳ Applied · waiting for results"],
        ["🎉 Accepted", "❌ Rejected"],
      ]);
      // tentativeHoldOnApply is off by default: nothing written yet.
      expect(deps.calendar.writes).toEqual([]);

      // Step 7: Accepted → accepted, exactly one calendar insert with (b)'s span.
      expect(await press(data(afterApply?.keyboard, "🎉 Accepted"), athens.messageId)).toBe(
        "Saved: accepted. Added to your calendar.",
      );
      expect(await deps.store.getEvent(athensId)).toMatchObject({
        status: "accepted",
        calendarState: "confirmed",
      });
      expect(deps.calendar.writes).toHaveLength(1);
      expect(deps.calendar.writes[0]).toMatchObject({
        op: "upsert",
        entry: {
          summary: "Athens Robotics Challenge 2027",
          state: "confirmed",
          start: { dateTime: "2027-02-20T07:00:00.000Z", timeZone: "Europe/Athens" },
          end: { dateTime: "2027-02-22T16:00:00.000Z", timeZone: "Europe/Athens" },
        },
      });
      expect(labels(telegram.edits.at(-1)?.keyboard)).toEqual([["🎉 Accepted"]]);

      // Pressing it again (double tap or a redelivered update): no second insert.
      expect(await press(data(afterApply?.keyboard, "🎉 Accepted"), athens.messageId)).toBe(
        "Already accepted.",
      );
      expect(deps.calendar.writes).toHaveLength(1);

      // Remind me on (a) → watching (its reminders arrive with M5).
      const onlineId = Number(data(online.keyboard, "🔔 Remind me").split(":")[1]);
      await press(data(online.keyboard, "🔔 Remind me"), online.messageId);
      expect((await deps.store.getEvent(onlineId))?.status).toBe("watching");

      // The next scout run leaves pressed events alone.
      const next = await runPipeline(deps);
      expect(next).toMatchObject({ alertsSent: 0, errors: [] });
      expect((await deps.store.getEvent(athensId))?.status).toBe("accepted");
      expect((await deps.store.getEvent(onlineId))?.status).toBe("watching");
    } finally {
      deps.store.close();
    }
  });
});
