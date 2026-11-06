import { ApiError } from "./auth.ts";
type RPC = (name: string, args: Record<string, unknown>) => Promise<any>;
type Bot = (
  method: string,
  payload: Record<string, unknown>,
  timeout?: number,
) => Promise<any>;
export function createEngagement(
  { rpc, bot, appUrl }: { rpc: RPC; bot: Bot; appUrl: string },
) {
  async function touch(user: number) {
    try {
      await rpc("paws_activity", { p_user: user });
    } catch { /* Нельзя терять команды во время поэтапного обновления. */ }
  }
  async function webhook(update: any) {
    const q = update.callback_query, m = update.message;
    const chat = q?.message?.chat ?? m?.chat, from = q?.from ?? m?.from;
    if (chat?.type !== "private" || chat.id !== from?.id) return false;
    const text =
      String(q?.data ?? m?.text ?? "").trim().split(/\s/)[0].split("@")[0];
    const on = ["/reminders_on", "reminders:on"].includes(text),
      off = ["/reminders_off", "reminders:off"].includes(text);
    if (!on && !off) return false;
    if (q) await bot("answerCallbackQuery", { callback_query_id: q.id });
    try {
      await rpc("paws_reminders_set", { p_user: chat.id, p_enabled: on });
      await bot("sendMessage", {
        chat_id: chat.id,
        text: on
          ? "Напоминания включены: в 08:00 и 18:00, если вас нет более 48 часов. Откройте карту для определения часового пояса устройства."
          : "Напоминания отключены. Включить снова: /reminders_on",
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        await bot("sendMessage", { chat_id: chat.id, text: e.message });
      } else throw e;
    }
    return true;
  }
  async function deliver() {
    for (let batch = 0; batch < 4; batch++) {
      const claimed = await rpc("paws_reminders_claim", { p_limit: 20 });
      if (!Array.isArray(claimed.messages) || !claimed.messages.length) return;
      for (let offset = 0; offset < claimed.messages.length; offset += 4) {
        await Promise.all(
          claimed.messages.slice(offset, offset + 4).map(async (n: any) => {
            let ok = false;
            try {
              await bot("sendMessage", {
                chat_id: Number(n.recipientId),
                text: n.message,
                reply_markup: {
                  inline_keyboard: [[{
                    text: "🐾 Открыть карту",
                    web_app: { url: appUrl },
                  }], [{
                    text: "Отключить напоминания",
                    callback_data: "reminders:off",
                  }]],
                },
              }, 10000);
              ok = true;
            } catch { /* Повтор возможен только в том же часовом окне. */ }
            await rpc("paws_reminders_finish", {
              p_id: n.id,
              p_token: n.leaseToken,
              p_ok: ok,
            });
          }),
        );
      }
    }
  }
  return { touch, webhook, deliver };
}
