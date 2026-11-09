import { makeHandler } from "./handler.ts";

// Это секреты отдельного бота обратной связи. Игровой TELEGRAM_BOT_TOKEN здесь не используется.
const token = Deno.env.get("FEEDBACK_BOT_TOKEN") ?? "";
const secret = Deno.env.get("FEEDBACK_WEBHOOK_SECRET") ?? "";
const base = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const config = {
  token,
  secret,
  adminIds: (Deno.env.get("FEEDBACK_ADMIN_IDS") ?? "").split(",").map(Number)
    .filter((x) => Number.isSafeInteger(x) && x > 0),
  groupId: Number(Deno.env.get("FEEDBACK_ADMIN_CHAT_ID") ?? 0),
};

// У каждого запроса ограничено время ожидания. Ошибки не включают токены или текст обращения.
async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeout: number,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error("Remote request failed");
  return response.status === 204 ? null : await response.json();
}

Deno.serve(makeHandler(config, {
  async rpc(name, args = {}) {
    return await post(
      `${base}/rest/v1/rpc/${name}`,
      { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      args,
      2500,
    );
  },
  async telegram(method, payload) {
    const data = await post(
      `https://api.telegram.org/bot${token}/${method}`,
      {},
      payload,
      4000,
    );
    if (!data?.ok) throw new Error("Telegram operation failed");
    return data.result;
  },
}));
