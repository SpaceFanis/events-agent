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

      // Remind me on (a) → watching.
      const onlineId = Number(data(online.keyboard, "🔔 Remind me").split(":")[1]);
      await press(data(online.keyboard, "🔔 Remind me"), online.messageId);
      expect((await deps.store.getEvent(onlineId))?.status).toBe("watching");

      // The next scout run leaves pressed events alone, and nothing is due yet.
      const next = await runPipeline(deps);
      expect(next).toMatchObject({ alertsSent: 0, remindersSent: 0, errors: [] });
      expect((await deps.store.getEvent(athensId))?.status).toBe("accepted");
      expect((await deps.store.getEvent(onlineId))?.status).toBe("watching");

      // Step 8: (a) has no registration deadline, so its reminders count down to its start
      // (10 Dec 2026, 18:00 New York = 23:00 UTC). 3 days before → one reminder.
      const sentBefore = deps.messenger.sent.length;
      const run = (iso: string) => runPipeline({ ...deps, now: () => new Date(iso) });
      expect(await run("2026-12-07T23:00:00Z")).toMatchObject({ remindersSent: 1, errors: [] });
      const reminder = deps.messenger.sent.at(-1);
      expect(reminder?.html).toBe(
        [
          "🔔 <b>Reminder: Open AI Builders Hackathon</b>",
          "Starts in 3 days: 10 Dec 2026, 18:00 (America/New_York)",
          '🔗 <a href="https://openai-builders.devpost.com/register">Register / details</a>',
          'Source: <a href="https://openai-builders.devpost.com/">Devpost</a>',
        ].join("\n"),
      );
      // Same buttons as the alert in `watching`: they work from the reminder too.
      expect(labels(reminder?.keyboard)).toEqual([
        ["🔔 Reminders on"],
        ["✅ Going", "🙅 Not interested"],
      ]);
      // Later that day: nothing new. One day before: the last reminder. After the start: none.
      expect((await run("2026-12-08T09:00:00Z")).remindersSent).toBe(0);
      expect((await run("2026-12-09T23:00:00Z")).remindersSent).toBe(1);
      expect(deps.messenger.sent.at(-1)?.html).toContain("Starts tomorrow");
      expect((await run("2026-12-10T12:00:00Z")).remindersSent).toBe(0);
      expect((await run("2026-12-11T09:00:00Z")).remindersSent).toBe(0);
      expect(deps.messenger.sent.length - sentBefore).toBe(2);

      // Going from the reminder message → going, its buttons replaced.
      if (reminder === undefined) throw new Error("expected a reminder");
      await press(data(reminder.keyboard, "✅ Going"), reminder.messageId);
      expect((await deps.store.getEvent(onlineId))?.status).toBe("going");
      expect(telegram.edits.at(-1)?.messageId).toBe(reminder.messageId);
    } finally {
      deps.store.close();
    }
  });

  it("nudges for results once the results date passes, and the nudge's buttons work", async () => {
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
    const press = async (buttonData: string, messageId: number): Promise<void> => {
      const response = await handleWebhook(
        new Request("https://worker.example/", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": SECRET },
          body: JSON.stringify({
            update_id: messageId,
            callback_query: {
              id: `q${String(messageId)}`,
              data: buttonData,
              message: { message_id: messageId, chat: { id: deps.messenger.chatId } },
            },
          }),
        }),
        webhook,
      );
      expect(response.status).toBe(200);
    };
    const run = (iso: string) => runPipeline({ ...deps, now: () => new Date(iso) });
    try {
      await runPipeline(deps);
      const athens = deps.messenger.sent[1];
      if (athens === undefined) throw new Error("expected the Athens alert");
      await press(data(athens.keyboard, "✍️ I applied"), athens.messageId);

      // Results are due by 10 Feb 2027 (Athens): no nudge on the day, one the day after.
      expect((await run("2027-02-10T12:00:00Z")).remindersSent).toBe(0);
      expect(await run("2027-02-11T08:00:00Z")).toMatchObject({ remindersSent: 1, errors: [] });
      const nudge = deps.messenger.sent.at(-1);
      expect(nudge?.html).toBe(
        [
          "📬 <b>Did you get results? Athens Robotics Challenge 2027</b>",
          "Results were due 10 Feb 2027. Tap Accepted or Rejected to update it.",
          'Source: <a href="https://athens-robotics.devpost.com/">Devpost</a>',
        ].join("\n"),
      );
      expect(labels(nudge?.keyboard)).toEqual([
        ["⏳ Applied · waiting for results"],
        ["🎉 Accepted", "❌ Rejected"],
      ]);
      // Only once.
      expect((await run("2027-02-12T08:00:00Z")).remindersSent).toBe(0);

      if (nudge === undefined) throw new Error("expected a nudge");
      await press(data(nudge.keyboard, "❌ Rejected"), nudge.messageId);
      const athensId = Number(data(nudge.keyboard, "❌ Rejected").split(":")[1]);
      expect((await deps.store.getEvent(athensId))?.status).toBe("rejected");
    } finally {
      deps.store.close();
    }
  });
});
