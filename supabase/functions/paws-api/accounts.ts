import { ApiError } from "./auth.ts";
type RPC = (name: string, args: Record<string, unknown>) => Promise<any>;
type Bot = (method: string, payload: Record<string, unknown>) => Promise<any>;
const USERNAME = /^[a-z][a-z0-9_]{4,31}$/i;
const TOKEN = /^[a-f0-9]{32}$/;
export function telegramUsername(value: unknown) {
  if (typeof value !== "string" || value.length > 120) {
    throw new ApiError(422, "Укажите ссылку t.me/username или @username.");
  }
  let name = value.trim().replace(/^@/, "");
  if (/^(https:\/\/)?t\.me\//i.test(name)) {
    const url = new URL(name.startsWith("https://") ? name : `https://${name}`);
    if (
      url.hostname !== "t.me" || url.username || url.password || url.search ||
      url.hash
    ) {
      throw new ApiError(
        422,
        "Укажите публичную ссылку t.me/username без дополнительных параметров.",
      );
    }
    name = url.pathname.replace(/^\//, "").replace(/\/$/, "");
  }
  if (!USERNAME.test(name)) {
    throw new ApiError(
      422,
      "Нужен публичный @username Telegram: 5–32 символа.",
    );
  }
  return name.toLowerCase();
}
async function hash(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
}
// Ссылка лишь приглашает: реальный ID второго человека приходит от Telegram.
// Токен в базе хранится только как SHA-256; управление доступом — у владельца.
export function createAccounts({ rpc, bot }: { rpc: RPC; bot: Bot }) {
  async function resolve(actor: number): Promise<number> {
    const result = await rpc("paws_account_resolve", { p_user: actor });
    const id = Number(result.ownerId);
    if (!Number.isSafeInteger(id) || id < 1 || id >= 2 ** 52) {
      throw new ApiError(503, "Не удалось проверить доступ к питомцу.");
    }
    return id;
  }
  async function api(
    path: string,
    method: string,
    actor: number,
    username: unknown,
    body: any,
  ) {
    if (path === "/api/accounts" && method === "GET") {
      return rpc("paws_accounts", { p_user: actor });
    }
    if (path === "/api/accounts/invite" && method === "POST") {
      const name = telegramUsername(body.username);
      if (typeof username === "string" && name === username.toLowerCase()) {
        throw new ApiError(422, "Укажите второй аккаунт, а не текущий.");
      }
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const token = [...bytes].map((x) => x.toString(16).padStart(2, "0")).join(
        "",
      );
      // Проверяем бота до создания приглашения; адрес не задаётся клиентом.
      const info = await bot("getMe", {});
      if (!USERNAME.test(info.username ?? "")) {
        throw new ApiError(503, "Не удалось получить адрес бота.");
      }
      const state = await rpc("paws_account_invite", {
        p_user: actor,
        p_username: name,
        p_hash: await hash(token),
      });
      return {
        ...state,
        url: `https://t.me/${info.username}?start=link_${token}`,
      };
    }
    if (path === "/api/accounts/invite" && method === "DELETE") {
      return rpc("paws_account_remove", { p_user: actor, p_invite_only: true });
    }
    if (path === "/api/accounts/secondary" && method === "DELETE") {
      return rpc("paws_account_remove", {
        p_user: actor,
        p_invite_only: false,
      });
    }
    throw new ApiError(404, "Запрос не найден.");
  }
  async function webhook(update: any) {
    const q = update.callback_query, m = update.message;
    const chat = q?.message?.chat ?? m?.chat, from = q?.from ?? m?.from;
    if (
      chat?.type !== "private" || chat.id !== from?.id || from.is_bot ||
      !Number.isSafeInteger(from.id)
    ) return false;
    const text = typeof m?.text === "string" ? m.text.trim() : "";
    const raw = typeof q?.data === "string" && q.data.startsWith("link_accept:")
      ? q.data.slice(12)
      : text.match(/^\/start(?:@\w+)?\s+link_([a-f0-9]{32})$/)?.[1];
    if (!raw || !TOKEN.test(raw)) return false;
    if (q) {
      try {
        await bot("answerCallbackQuery", { callback_query_id: q.id });
      } catch {}
    }
    try {
      const result = await rpc(
        q ? "paws_account_accept" : "paws_account_preview",
        {
          p_user: from.id,
          p_username: typeof from.username === "string"
            ? from.username.toLowerCase()
            : null,
          p_hash: await hash(raw),
        },
      );
      await bot("sendMessage", {
        chat_id: chat.id,
        text: q
          ? "Аккаунт привязан. Откройте карту: у вас общий питомец, территории, штаб и баланс 🦴. Управлять привязкой может основной аккаунт."
          : `Приглашение к питомцу «${result.name}». После подтверждения вы сможете гулять, менять досье, писать в чат и тратить общий баланс. Подтвердить?`,
        ...(!q
          ? {
            reply_markup: {
              inline_keyboard: [[{
                text: "Подтвердить привязку",
                callback_data: `link_accept:${raw}`,
              }]],
            },
          }
          : {}),
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        await bot("sendMessage", { chat_id: chat.id, text: e.message });
      } else throw e;
    }
    return true;
  }
  return { resolve, api, webhook };
}
