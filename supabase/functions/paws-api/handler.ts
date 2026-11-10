import { decode, encode } from "npm:jpeg-js@0.4.4";
import { ApiError, equalSecret, verifyInitData } from "./auth.ts";
import { createAccounts } from "./accounts.ts";
import { createCommerce } from "./commerce.ts";
import { createEngagement } from "./engagement.ts";

type Dependencies = {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  now?: () => number;
  defer?: (task: Promise<void>) => void;
};
type Pet = Record<string, unknown> & { photo_key?: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO = /^[0-9]+\/[0-9a-f-]{36}\.jpg$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "Ожидается объект с данными.");
  }
  return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number) {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < min ||
    value > max
  ) throw new ApiError(422, "Некорректное число в запросе.");
  return value;
}
function purchaseVertices(value: unknown) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 100) {
    throw new ApiError(422, "Отметьте от 3 до 100 точек участка.");
  }
  return value.map((v) => {
    const p = object(v);
    return {
      longitude: number(p.longitude, -180, 180),
      latitude: number(p.latitude, -85, 85),
    };
  });
}
async function readBody(req: Request, limit = 3 * 1024 * 1024) {
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(
          413,
          "Запрос слишком большой. Фото после сжатия должно быть до 1 МБ.",
        );
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
async function jsonBody(req: Request) {
  const bytes = await readBody(req);
  try {
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(422, "Некорректный JSON.");
  }
}

// Зависимости передаются явно: тесты заменяют сеть и настройки, не отправляя
// настоящих сообщений и не изменяя ваш Supabase.
export function createHandler(deps: Dependencies) {
  const env = deps.env, send = deps.fetch;
  const now = deps.now ?? (() => Date.now() / 1000);
  const base = (env("SUPABASE_URL") ?? "").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = env("TELEGRAM_BOT_TOKEN") ?? "";
  const appUrl = env("APP_URL") ?? "";
  const adminHeaders = { apikey: key, Authorization: `Bearer ${key}` };
  let origin = "";
  try {
    const u = new URL(appUrl);
    if (u.protocol === "https:" && !u.username && !u.password) {
      origin = u.origin;
    }
  } catch { /* настройку проверим при запросе */ }

  async function rpc(name: string, args: Record<string, unknown>) {
    if (!base || !key) {
      throw new ApiError(
        503,
        "Supabase не настроен. Проверьте серверные секреты функции.",
      );
    }
    const response = await send(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { ...adminHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({})) as {
        code?: string;
        message?: string;
      };
      if (detail.code === "P0001") {
        throw new ApiError(422, detail.message ?? "Проверьте маршрут.");
      }
      if (["22003", "22P02", "23514", "23502"].includes(detail.code ?? "")) {
        throw new ApiError(422, "Проверьте данные профиля или GPS.");
      }
      throw new ApiError(
        503,
        "База пока недоступна или миграция не установлена.",
      );
    }
    return await response.json();
  }
  function pet(value: Pet | null) {
    if (!value) return null;
    const { photo_key, ...rest } = value;
    return {
      ...rest,
      photo: photo_key && PHOTO.test(photo_key)
        ? `${base}/storage/v1/object/public/paws-photos/${photo_key}`
        : null,
    };
  }
  function profile(value: { pet: Pet | null; area: number }) {
    return { ...value, pet: pet(value.pet) };
  }
  async function bot(
    method: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ) {
    if (!token) {
      throw new ApiError(503, "В Supabase не задан TELEGRAM_BOT_TOKEN.");
    }
    const controller = timeoutMs ? new AbortController() : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
    let response: Response;
    try {
      response = await send(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller?.signal,
        },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new ApiError(503, "Telegram временно недоступен.");
    const data = await response.json();
    if (!data.ok) throw new ApiError(503, "Telegram отклонил запрос бота.");
    return data.result;
  }
  const accounts = createAccounts({ rpc, bot });
  async function accountRpc(name: string, args: Record<string, unknown>) {
    return rpc(
      name,
      typeof args.p_user === "number" && args.p_user > 0
        ? { ...args, p_user: await accounts.resolve(args.p_user) }
        : args,
    );
  }
  const commerce = createCommerce({
    rpc: (name, args) =>
      ["paws_activity", "paws_payment_support", "paws_star_catalog"].includes(
          name,
        )
        ? accountRpc(name, args)
        : rpc(name, args),
    bot,
  });
  const engagement = createEngagement({ rpc: accountRpc, bot, appUrl });
  async function deliverNotifications(filters: Record<string, unknown>) {
    try {
      // Очередь остаётся в БД. Следующее обращение обработает оставшееся,
      // если один запрос не успеет отправить большую рассылку.
      for (let batch = 0; batch < 4; batch++) {
        const claimed = await rpc("paws_notify_claim", {
          ...filters,
          p_limit: 20,
        });
        if (!Array.isArray(claimed.messages) || !claimed.messages.length) break;
        for (let offset = 0; offset < claimed.messages.length; offset += 4) {
          await Promise.all(
            claimed.messages.slice(offset, offset + 4).map(
              async (note: Record<string, unknown>) => {
                let ok = false;
                try {
                  await bot("sendMessage", {
                    chat_id: Number(note.recipientId),
                    text: note.message,
                  }, 10000);
                  ok = true;
                } catch {
                  /* Запись и выплата сохраняются при недоступности Telegram. */
                }
                await rpc("paws_notify_finish", {
                  p_id: note.id,
                  p_token: note.leaseToken,
                  p_ok: ok,
                });
              },
            ),
          );
        }
      }
    } catch { /* Просроченная аренда позволит повторить доставку позднее. */ }
  }
  async function scheduleNotifications(filters: Record<string, unknown>) {
    const task = deliverNotifications(filters);
    if (deps.defer) deps.defer(task);
    else await task; // В тестах проверяем доставку без настоящего EdgeRuntime.
  }
  const walkButtons = {
    inline_keyboard: [
      [{ text: "🐾 Карта и досье", web_app: { url: appUrl } }],
      [
        { text: "✓ Захватить", callback_data: "walk_capture" },
        { text: "⌖ Статус", callback_data: "walk_status" },
        { text: "Отмена", callback_data: "walk_cancel" },
      ],
    ],
  };
  const liveInstructions =
    "Чтобы гулять с выключенным экраном: скрепка → Геопозиция → Транслировать геопозицию. Запись начнётся сама, когда погрешность GPS будет не больше 20 м. Разрешите Telegram точную геопозицию в фоне. После возвращения к старту в пределах 20 м нажмите «Захватить» ниже.\n\nTelegram требует включить трансляцию вручную; обычная отправка одной точки не записывает маршрут. Точки временно хранятся на сервере. Работа в фоне зависит от телефона и частоты обновлений Telegram. Средняя скорость прогулки — не выше 20 км/ч.";
  async function removePhoto(path: string | null | undefined) {
    if (!path || !PHOTO.test(path)) return;
    try {
      const r = await send(`${base}/storage/v1/object/paws-photos`, {
        method: "DELETE",
        headers: { ...adminHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: [path] }),
      });
      if (!r.ok) console.warn("Не удалось убрать старый аватар.");
    } catch {
      console.warn("Очистка аватара отложена.");
    }
  }
  async function cleanupDeletedPhotos() {
    const claimed = await rpc("paws_photo_cleanup_claim", { p_limit: 5 });
    for (const photo of Array.isArray(claimed.photos) ? claimed.photos : []) {
      if (
        typeof photo.key !== "string" || !PHOTO.test(photo.key) ||
        typeof photo.token !== "string" || !UUID.test(photo.token)
      ) continue;
      let ok = false;
      try {
        const result = await send(`${base}/storage/v1/object/paws-photos`, {
          method: "DELETE",
          headers: { ...adminHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes: [photo.key] }),
          signal: AbortSignal.timeout(10000),
        });
        ok = result.ok || result.status === 404;
      } catch {}
      await rpc("paws_photo_cleanup_finish", {
        p_key: photo.key,
        p_token: photo.token,
        p_ok: ok,
      });
    }
  }
  async function route(req: Request, path: string, url: URL) {
    if (path === "/internal/scheduler" && req.method === "POST") {
      const expected = env("SCHEDULER_SECRET") ?? "";
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(expected)) {
        throw new ApiError(503, "Планировщик не настроен.");
      }
      if (
        !await equalSecret(
          req.headers.get("X-Scheduler-Secret") ?? "",
          expected,
        )
      ) throw new ApiError(401, "Недействительный ключ планировщика.");
      const result = await rpc("paws_reminders_generate", {});
      const task = Promise.all([
        engagement.deliver(),
        deliverNotifications({}),
        cleanupDeletedPhotos(),
      ])
        .then(() => {}).catch(() => {});
      if (deps.defer) deps.defer(task);
      else await task;
      return { ok: true, ...result };
    }
    if (path === "/webhook" && req.method === "POST") {
      const expected = env("WEBHOOK_SECRET") ?? "";
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(expected)) {
        throw new ApiError(503, "WEBHOOK_SECRET не настроен.");
      }
      if (
        !await equalSecret(
          req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "",
          expected,
        )
      ) throw new ApiError(401, "Недействительный webhook.");
      const update = await jsonBody(req);
      if (
        await accounts.webhook(update) || await commerce.webhook(update) ||
        await engagement.webhook(update)
      ) {
        return { ok: true };
      }
      let m = (update.message ?? update.edited_message) as
        | Record<string, unknown>
        | undefined;
      const callback = update.callback_query as
        | Record<string, unknown>
        | undefined;
      if (callback) {
        const source = callback.message as Record<string, unknown> | undefined,
          chat = source?.chat as Record<string, unknown> | undefined,
          from = callback.from as Record<string, unknown> | undefined;
        const commands: Record<string, string> = {
          walk_capture: "/capture",
          walk_status: "/status",
          walk_cancel: "/cancel",
        };
        const command = typeof callback.data === "string"
          ? commands[callback.data]
          : undefined;
        if (
          !command || chat?.type !== "private" || from?.id !== chat.id ||
          from?.is_bot ||
          typeof callback.id !== "string" || callback.id.length > 256
        ) return { ok: true };
        // Устаревшая кнопка не должна мешать идемпотентной серверной операции.
        try {
          await bot("answerCallbackQuery", { callback_query_id: callback.id });
        } catch { /* кнопка могла истечь */ }
        m = { chat, from, text: command };
      }
      const location = m?.location as Record<string, unknown> | undefined;
      const sender = m?.from as Record<string, unknown> | undefined;
      const locationChat = m?.chat as Record<string, unknown> | undefined;
      if (
        location && locationChat?.type === "private" &&
        sender?.id === locationChat.id && !sender?.is_bot &&
        !m?.forward_origin && !m?.forward_date && !m?.via_bot
      ) {
        try {
          const id = number(locationChat.id, 1, 2 ** 52 - 1);
          if (!Number.isSafeInteger(id)) {
            throw new ApiError(422, "Некорректный владелец геопозиции.");
          }
          const message = number(m?.message_id, 1, 2 ** 52 - 1),
            updateId = number(update.update_id, 0, 2 ** 52 - 1);
          if (
            !Number.isSafeInteger(message) || !Number.isSafeInteger(updateId)
          ) {
            throw new ApiError(422, "Некорректное обновление.");
          }
          const result = await rpc("paws_live_receive_shared", {
            p_actor: id,
            p_message: message,
            p_update: updateId,
            p_timestamp: number(m?.edit_date ?? m?.date, 0, 1e12),
            p_sent_at: number(m?.date, 0, 1e12),
            p_initial: !update.edited_message,
            p_longitude: number(location.longitude, -180, 180),
            p_latitude: number(location.latitude, -85, 85),
            p_accuracy: typeof location.horizontal_accuracy === "number"
              ? number(location.horizontal_accuracy, 0, 1500)
              : null,
            p_period: typeof location.live_period === "number"
              ? number(location.live_period, 0, 2147483647)
              : null,
          });
          if (!update.edited_message) await engagement.touch(id);
          if (result.first) {
            await bot("sendMessage", {
              chat_id: id,
              text:
                "Прогулка началась — можно выключить экран. Вернитесь к старту в пределах 20 м, дождитесь свежей точки GPS и нажмите «Захватить». Пересечения трека разрешены. Одновременно у питомца может идти только одна трансляция.",
              reply_markup: walkButtons,
            });
          } else if (
            result.reason === "gap" ||
            (!update.edited_message && result.reason === "other_account")
          ) {
            await bot("sendMessage", { chat_id: id, text: result.message });
          } else if (!update.edited_message && result.reason === "accuracy") {
            await bot("sendMessage", {
              chat_id: id,
              text:
                "Трансляция включена. Ждём GPS с погрешностью не больше 20 м — запись начнётся сама. Выйдите на открытое место; неточные точки не записываются.",
              reply_markup: walkButtons,
            });
          } else if (!update.edited_message && result.reason === "not_live") {
            await bot("sendMessage", {
              chat_id: id,
              text: liveInstructions,
              reply_markup: walkButtons,
            });
          } else if (
            !update.edited_message &&
            ["profile", "foreground_active", "other_message", "old"].includes(
              result.reason,
            )
          ) {
            const texts: Record<string, string> = {
              profile:
                "Сначала создайте досье питомца через кнопку «Карта и досье», затем включите новую трансляцию геопозиции.",
              foreground_active:
                "На карте уже идёт обычная GPS-запись. Завершите или отмените её, затем включите новую трансляцию.",
              other_message:
                "Прогулка уже связана с другой трансляцией. Продолжите её или нажмите «Отмена», затем включите новую трансляцию.",
              old:
                "Эта трансляция пришла слишком поздно. Остановите её и включите новую, чтобы начать прогулку.",
            };
            await bot("sendMessage", {
              chat_id: id,
              text: texts[result.reason],
              reply_markup: walkButtons,
            });
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 422) {
            await bot("sendMessage", {
              chat_id: locationChat.id,
              text: error.message,
            });
          } else throw error;
        }
        return { ok: true };
      }
      const chat = m?.chat as Record<string, unknown> | undefined;
      if (
        !m || chat?.type !== "private" || typeof m.text !== "string" ||
        !m.text.trim()
      ) return { ok: true };
      const id = number(chat.id, 1, 2 ** 52 - 1);
      if (!Number.isSafeInteger(id)) {
        throw new ApiError(422, "Некорректный chat id.");
      }
      const command = m.text.trim().split(/\s/)[0].split("@")[0];
      await engagement.touch(id);
      if (["/capture", "/cancel", "/status"].includes(command)) {
        try {
          if (command === "/capture") {
            const result = await rpc("paws_live_capture_shared", {
              p_actor: id,
            });
            await bot("sendMessage", {
              chat_id: id,
              text: result.annulled
                ? result.detail
                : `Территория захвачена: ${
                  Math.round(Number(result.area))
                } м². Остановите трансляцию геопозиции в Telegram.`,
              reply_markup: walkButtons,
            });
          } else if (command === "/cancel") {
            await rpc("paws_live_cancel", {
              p_user: await accounts.resolve(id),
            });
            await bot("sendMessage", {
              chat_id: id,
              text:
                "Фоновая прогулка отменена, временные точки удалены. Остановите трансляцию геопозиции Telegram.",
              reply_markup: walkButtons,
            });
          } else {
            const result = await rpc("paws_live_status_shared", {
              p_actor: id,
            });
            const walk = result.walk;
            await bot("sendMessage", {
              chat_id: id,
              text: result.result?.annulled
                ? result.result.detail
                : !walk
                ? "Активной прогулки нет. Чтобы начать, включите трансляцию: скрепка → Геопозиция → Транслировать геопозицию."
                : walk.error
                ? walk.error
                : walk.points.length
                ? `Принято точек: ${walk.points.length}. Последняя точность ±${
                  walk.points.at(-1).accuracy
                } м, ${
                  Math.max(0, Math.round(now() - walk.points.at(-1).timestamp))
                } сек. назад. Точка не старше 15 секунд нужна для захвата. /capture — захват, /cancel — отмена.`
                : "Ждём GPS с погрешностью ≤20 м. Запись начнётся автоматически.",
              reply_markup: walkButtons,
            });
          }
        } catch (e) {
          if (e instanceof ApiError && e.status === 422) {
            await bot("sendMessage", { chat_id: id, text: e.message });
          } else throw e;
        }
        return { ok: true };
      }
      if (command === "/privacy") {
        await bot("sendMessage", {
          chat_id: id,
          text:
            "Сохраняются Telegram ID, профиль питомца, фото и контуры захваченных территорий. Профиль и контуры видны другим участникам. История выкупа и репараций сохраняется; уведомление доступно только получателю. Маршрут поступает только из трансляции геопозиции Telegram; точки временно сохраняются в базе до завершения/отмены; просроченные маршруты очищаются при обращениях к фоновому API. Не указывайте домашний адрес в профиле.",
        });
      } else {await bot("sendMessage", {
          chat_id: id,
          text:
            `🐾 DogWars. Захвати мир!\n\nСоздайте досье питомца по кнопке «Карта и досье».\n\n${liveInstructions}\n\nЗахват доступен только через трансляцию геопозиции в этом чате. /privacy — о данных.`,
          reply_markup: walkButtons,
        });}
      return { ok: true };
    }
    if (path === "/api/config" && req.method === "GET") {
      let features: Record<string, unknown> = {
        dossier: false,
        chat: false,
        wallet: false,
        publicWallet: false,
      };
      try {
        features = await rpc("paws_capabilities", {});
      } catch {
        try {
          await rpc("paws_wallet", { p_user: 0 });
          features = {
            dossier: true,
            chat: true,
            wallet: true,
            publicWallet: false,
          };
        } catch { /* старую БД нельзя объявлять готовой */ }
      }
      return {
        version: "1.1.2",
        features,
        demoMode: false,
        closureMeters: features.closureMeters ?? 15,
        maxAccuracy: features.maxAccuracy ?? 15,
        demoRoute: null,
        appUrl,
        schedulerConfigured: /^[A-Za-z0-9_-]{32,256}$/.test(
          env("SCHEDULER_SECRET") ?? "",
        ),
      };
    }
    if (path === "/health" && req.method === "GET") {
      await rpc("paws_me", { p_user: 0 });
      await rpc("paws_wallet", { p_user: 0 });
      const capabilities = await rpc("paws_capabilities", {});
      if (
        !capabilities.autoLiveStart || !capabilities.crossingRoutes ||
        !capabilities.purchases || !capabilities.territoryLeaderboard ||
        !capabilities.unlimitedPurchases || !capabilities.mergeOwnPurchases ||
        !capabilities.foreignBuyouts || !capabilities.notifications ||
        !capabilities.speedLimit || !capabilities.starShop ||
        !capabilities.reminders || !capabilities.largestTerritory ||
        !capabilities.dailyIncome || !capabilities.geoChat ||
        !capabilities.liveOnly || !capabilities.captureHelp ||
        !capabilities.extraCamouflage || !capabilities.breeds ||
        !capabilities.headquarters || !capabilities.sharedPet ||
        !capabilities.unlimitedGpsGap || !capabilities.deletePet || !capabilities.efficientSync
      ) {
        throw new ApiError(503, "Установите миграцию оптимизации v.1.1.2 после v.1.1.1.");
      }
      return { ok: true, version: "1.1.2" };
    }
    const authorization = req.headers.get("Authorization") ?? "";
    if (!authorization.startsWith("tma ")) {
      throw new ApiError(
        401,
        "Откройте приложение через кнопку Telegram-бота.",
      );
    }
    const actor = await verifyInitData(authorization.slice(4), token, now());
    if (path === "/api/sync" && req.method === "POST") {
      const b = await jsonBody(req);
      const after = b.after ?? 0;
      if ((b.walk != null && (typeof b.walk !== "string" || !UUID.test(b.walk))) ||
          typeof after !== "number" || !Number.isInteger(after) || after < 0 || after > 5000 ||
          (b.channel != null && (typeof b.channel !== "string" || !["district", "city", "world"].includes(b.channel))) ||
          !/^\d{1,18}$/.test(String(b.chatAfter ?? "0")) ||
          (b.context != null && (typeof b.context !== "string" || b.context.length > 128)) ||
          (b.notificationsKey != null && (typeof b.notificationsKey !== "string" || !/^[a-f0-9]{32}$/.test(b.notificationsKey))) ||
          typeof b.timezone !== "string" || b.timezone.length > 100) {
        throw new ApiError(422, "Не удалось обновить данные. Откройте приложение заново.");
      }
      const result = await rpc("paws_sync", {p_actor: actor,p_walk:b.walk ?? null,p_after:b.after ?? 0,
        p_channel:b.channel ?? null,p_chat_after:b.chatAfter ?? "0",p_context:b.context ?? null,
        p_notifications_key:b.notificationsKey ?? null,p_timezone:b.timezone});
      if (result.deliveryPending) await scheduleNotifications({});
      delete result.deliveryPending;
      if (result.chat) result.chat.messages = result.chat.messages.map((m: Record<string, unknown>) => ({...m,pet:pet(m.pet as Pet)}));
      return result;
    }
    if (path.startsWith("/api/accounts")) {
      // user.username читаем только после успешной проверки всей initData.
      const identity = JSON.parse(
        new URLSearchParams(authorization.slice(4)).get("user") ?? "{}",
      );
      return accounts.api(
        path,
        req.method,
        actor,
        identity.username,
        req.method === "POST" ? await jsonBody(req) : {},
      );
    }
    if (
      (path === "/api/shop" && req.method === "GET") ||
      (path.startsWith("/api/shop/orders/") && req.method === "GET") ||
      (path === "/api/shop/invoice" && req.method === "POST")
    ) {
      return await commerce.api(
        path,
        actor,
        req.method === "POST" ? await jsonBody(req) : {},
      );
    }
    if (path === "/api/me" && req.method === "DELETE") {
      const b = await jsonBody(req);
      if (
        typeof b.profileId !== "string" || !UUID.test(b.profileId) ||
        typeof b.requestId !== "string" || !UUID.test(b.requestId) ||
        typeof b.confirmation !== "string" || !b.confirmation.trim() ||
        b.confirmation.length > 40 || b.confirmed !== true ||
        Object.keys(b).some((k) =>
          !["profileId", "requestId", "confirmation", "confirmed"].includes(k)
        )
      ) throw new ApiError(422, "Подтвердите удаление точной кличкой питомца.");
      const result = await rpc("paws_delete_pet", {
        p_actor: actor,
        p_profile: b.profileId,
        p_name: b.confirmation.trim(),
        p_request: b.requestId,
      });
      const task = cleanupDeletedPhotos().catch(() => {});
      if (deps.defer) deps.defer(task);
      else await task;
      return result;
    }
    const user = await accounts.resolve(actor);
    if (path === "/api/activity" && req.method === "POST") {
      const b = await jsonBody(req);
      if (typeof b.timezone !== "string" || b.timezone.length > 100) {
        throw new ApiError(422, "Укажите часовой пояс устройства.");
      }
      return await rpc("paws_activity", {
        p_user: user,
        p_timezone: b.timezone,
      });
    }
    if (path === "/api/reminders" && req.method === "POST") {
      const b = await jsonBody(req);
      if (typeof b.enabled !== "boolean") {
        throw new ApiError(422, "Некорректная настройка напоминаний.");
      }
      return await rpc("paws_reminders_set", {
        p_user: user,
        p_enabled: b.enabled,
      });
    }
    if (
      /^\/api\/pets\/\d+\/largest-territory$/.test(path) && req.method === "GET"
    ) {
      const petId = number(Number(path.split("/")[3]), 1, 2 ** 52 - 1);
      return {
        territory: await rpc("paws_largest_territory", {
          p_user: user,
          p_pet: petId,
        }),
      };
    }
    if (path === "/api/notifications" && req.method === "GET") {
      const result = await rpc("paws_notifications", { p_user: user });
      await scheduleNotifications({});
      return result;
    }
    if (path === "/api/notifications/read" && req.method === "POST") {
      const b = await jsonBody(req);
      if (
        !Array.isArray(b.ids) || b.ids.length > 50 ||
        b.ids.some((id) => typeof id !== "string" || !UUID.test(id))
      ) {
        throw new ApiError(422, "Некорректные уведомления.");
      }
      return await rpc("paws_notifications_read", {
        p_user: user,
        p_ids: b.ids,
      });
    }
    if (path === "/api/live/instructions" && req.method === "POST") {
      await bot("sendMessage", {
        chat_id: user,
        text: liveInstructions,
        reply_markup: walkButtons,
      });
      return { ok: true };
    }
    if (path === "/api/top" && req.method === "GET") {
      const sort = url.searchParams.get("sort") ?? "bones";
      if (!["bones", "area"].includes(sort)) {
        throw new ApiError(422, "Неизвестный рейтинг.");
      }
      const result = await rpc(sort === "area" ? "paws_top_area" : "paws_top", {
        p_user: user,
      });
      result.agents = result.agents.map((a: Record<string, unknown>) => ({
        ...a,
        pet: pet(a.pet as Pet),
      }));
      return result;
    }
    if (path === "/api/purchases/quote" && req.method === "POST") {
      const b = await jsonBody(req);
      return await rpc("paws_purchase_quote", {
        p_user: user,
        p_vertices: purchaseVertices(b.vertices),
      });
    }
    if (path === "/api/purchases" && req.method === "POST") {
      const b = await jsonBody(req);
      if (typeof b.requestId !== "string" || !UUID.test(b.requestId)) {
        throw new ApiError(422, "Некорректный номер покупки.");
      }
      const result = await rpc("paws_purchase", {
        p_user: user,
        p_request: b.requestId,
        p_vertices: purchaseVertices(b.vertices),
        p_max_cost: number(b.maxCost, 0, Number.MAX_VALUE),
      });
      if (Array.isArray(result.reparations) && result.reparations.length) {
        await scheduleNotifications({ p_buyer: user, p_request: b.requestId });
      }
      return result;
    }
    if (path === "/api/live/status" && req.method === "GET") {
      return await rpc("paws_live_status_shared", { p_actor: actor });
    }
    if (path === "/api/live/start" && req.method === "POST") {
      const b = await jsonBody(req);
      const result = await rpc("paws_live_start", {
        p_user: user,
        p_accuracy: number(b.accuracy, 0, 20),
      });
      try {
        await bot("sendMessage", {
          chat_id: user,
          text: liveInstructions,
          reply_markup: walkButtons,
        });
      } catch {
        /* интерфейс тоже показывает инструкцию, созданную прогулку не теряем */
      }
      return result;
    }
    if (path === "/api/live/capture" && req.method === "POST") {
      return await rpc("paws_live_capture_shared", { p_actor: actor });
    }
    if (path === "/api/live/cancel" && req.method === "POST") {
      return await rpc("paws_live_cancel", { p_user: user });
    }
    if (path === "/api/me" && req.method === "GET") {
      if (deps.defer) deps.defer(cleanupDeletedPhotos().catch(() => {}));
      return {
        ...profile(await rpc("paws_me", { p_user: user })),
        canDeletePet: user === actor,
      };
    }
    if (path === "/api/me" && req.method === "PUT") {
      const b = await jsonBody(req);
      if (
        Object.keys(b).some((k) =>
          ![
            "name",
            "age",
            "description",
            "color",
            "hue",
            "saturation",
            "opacity",
            "pattern",
            "breedId",
            "breedCustom",
            "profileId",
          ].includes(k)
        )
      ) throw new ApiError(422, "Лишнее поле профиля.");
      if (
        typeof b.name !== "string" || !b.name.trim() ||
        b.name.trim().length > 40 || typeof b.description !== "string" ||
        b.description.length > 400 || typeof b.color !== "string" ||
        !/^#[0-9a-f]{6}$/i.test(b.color)
      ) throw new ApiError(422, "Проверьте кличку, описание и цвет питомца.");
      if (
        !Object.hasOwn(b, "profileId") ||
        !(b.profileId === null ||
          typeof b.profileId === "string" && UUID.test(b.profileId))
      ) {
        throw new ApiError(
          422,
          "Закройте приложение и откройте заново перед сохранением анкеты.",
        );
      }
      if (b.hue !== undefined) {
        const hue = number(b.hue, 0, 359),
          saturation = number(b.saturation, 20, 100),
          opacity = number(b.opacity, .15, .8);
        if (
          !Number.isInteger(hue) || !Number.isInteger(saturation) ||
          !["solid", "stripes", "grid", "camo", "digital", "tiger", "flecktarn"]
            .includes(String(b.pattern))
        ) throw new ApiError(422, "Некорректный стиль заливки.");
        if (
          b.breedId !== undefined &&
          (typeof b.breedId !== "string" || b.breedId.length > 80 ||
            !(b.breedCustom == null ||
              typeof b.breedCustom === "string" &&
                b.breedCustom.trim().length <= 80))
        ) throw new ApiError(422, "Проверьте породу питомца.");
        return profile(
          await rpc(
            "paws_save_profile",
            {
              p_user: user,
              p_profile: b.profileId,
              p_name: b.name.trim(),
              p_age: number(b.age, 0, 35),
              p_description: b.description.trim(),
              p_color: b.color,
              p_hue: hue,
              p_saturation: saturation,
              p_opacity: opacity,
              p_pattern: b.pattern,
              ...(b.breedId === undefined ? {} : {
                p_breed: b.breedId,
                p_custom: typeof b.breedCustom === "string"
                  ? b.breedCustom.trim()
                  : null,
              }),
            },
          ),
        );
      }
      if (b.breedId !== undefined) {
        throw new ApiError(422, "Выберите породу и стиль заливки в досье.");
      }
      return profile(
        await rpc("paws_save_profile", {
          p_user: user,
          p_profile: b.profileId,
          p_name: b.name.trim(),
          p_age: number(b.age, 0, 35),
          p_description: b.description.trim(),
          p_color: b.color,
        }),
      );
    }
    if (path === "/api/hq" && req.method === "GET") {
      return await rpc("paws_hq", { p_user: user });
    }
    if (path === "/api/hq/upgrade" && req.method === "POST") {
      const b = await jsonBody(req);
      if (
        typeof b.requestId !== "string" || !UUID.test(b.requestId) ||
        typeof b.expectedLevel !== "number" ||
        !Number.isInteger(b.expectedLevel) || b.expectedLevel < 1 ||
        b.expectedLevel > 10 || Object.keys(b).some((k) =>
          !["requestId", "expectedLevel"].includes(k)
        )
      ) throw new ApiError(422, "Проверьте уровень штаба и номер улучшения.");
      return await rpc("paws_hq_upgrade", {
        p_user: user,
        p_request: b.requestId,
        p_level: b.expectedLevel,
      });
    }
    if (path === "/api/wallet" && req.method === "GET") {
      return await rpc("paws_wallet", { p_user: user });
    }
    if (path === "/api/chat" && req.method === "GET") {
      const after = url.searchParams.get("after") ?? "0";
      if (!/^\d{1,18}$/.test(after)) {
        throw new ApiError(422, "Некорректный курсор чата.");
      }
      const channel = url.searchParams.get("channel") ?? "world";
      if (
        typeof channel !== "string" ||
        !["district", "city", "world"].includes(channel)
      ) {
        throw new ApiError(422, "Выберите Район, Город или Мир.");
      }
      const result = await rpc("paws_chat_room", {
        p_user: user,
        p_channel: channel,
        p_after: after,
      });
      result.messages = result.messages.map((m: Record<string, unknown>) => ({
        ...m,
        pet: pet(m.pet as Pet),
      }));
      return result;
    }
    if (path === "/api/chat" && req.method === "POST") {
      const b = await jsonBody(req);
      if (
        typeof b.text !== "string" || !b.text.trim() ||
        b.text.trim().length > 500
      ) throw new ApiError(422, "Сообщение: от 1 до 500 символов.");
      const channel = b.channel ?? "world";
      if (
        typeof channel !== "string" ||
        !["district", "city", "world"].includes(channel)
      ) {
        throw new ApiError(422, "Выберите Район, Город или Мир.");
      }
      return await rpc("paws_send_room", {
        p_user: user,
        p_channel: channel,
        p_text: b.text.trim(),
      });
    }
    if (path === "/api/me/photo" && req.method === "POST") {
      const bytes = await readBody(req);
      const upload = new Request(req.url, {
        method: "POST",
        headers: { "Content-Type": req.headers.get("Content-Type") ?? "" },
        body: bytes as BodyInit,
      });
      let file: FormDataEntryValue | null;
      try {
        file = (await upload.formData()).get("file");
      } catch {
        throw new ApiError(422, "Некорректный файл фотографии.");
      }
      if (!(file instanceof File) || file.size > 1_000_000) {
        throw new ApiError(413, "Фото после сжатия должно быть до 1 МБ.");
      }
      let jpeg: Uint8Array;
      try {
        const image = decode(new Uint8Array(await file.arrayBuffer()), {
          useTArray: true,
          maxResolutionInMP: 2,
          maxMemoryUsageInMB: 32,
        });
        if (image.width > 1024 || image.height > 1024) {
          throw new Error("dimensions");
        }
        // Повторное кодирование очищает EXIF; 512px достаточно для аватара.
        const scale = Math.min(1, 512 / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale)),
          height = Math.max(1, Math.round(image.height * scale));
        const pixels = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const from =
              (Math.min(image.height - 1, Math.floor(y / scale)) * image.width +
                Math.min(image.width - 1, Math.floor(x / scale))) * 4;
            pixels.set(
              image.data.subarray(from, from + 4),
              (y * width + x) * 4,
            );
          }
        }
        jpeg = new Uint8Array(encode({ width, height, data: pixels }, 85).data);
        if (jpeg.length > 1_000_000) throw new Error("size");
      } catch {
        throw new ApiError(
          422,
          "Нужен JPEG до 1024×1024. Выберите фото заново в форме.",
        );
      }
      const current = await rpc("paws_me", { p_user: user });
      if (!current.pet) {
        throw new ApiError(409, "Сначала сохраните профиль питомца.");
      }
      const name = `${user}/${crypto.randomUUID()}.jpg`;
      const response = await send(
        `${base}/storage/v1/object/paws-photos/${name}`,
        {
          method: "POST",
          headers: {
            ...adminHeaders,
            "Content-Type": "image/jpeg",
            "x-upsert": "false",
          },
          body: jpeg as BodyInit,
        },
      );
      if (!response.ok) {
        throw new ApiError(
          503,
          "Не удалось сохранить фото. Проверьте bucket paws-photos.",
        );
      }
      let result;
      try {
        result = await rpc("paws_photo", { p_user: user, p_key: name });
      } catch (error) {
        // Ответ RPC мог потеряться уже после commit. Нельзя удалить файл,
        // на который сохранённый профиль теперь ссылается.
        let latest;
        try {
          latest = await rpc("paws_me", { p_user: user });
        } catch {
          throw error;
        } // при неизвестном результате оставляем файл
        if (latest.pet?.photo_key === name) return profile(latest);
        await removePhoto(name);
        throw error;
      }
      await removePhoto(result.previous);
      return profile(result.profile);
    }
    if (/^\/api\/pets\/\d+$/.test(path) && req.method === "GET") {
      const id = number(Number(path.split("/").at(-1)), 1, 2 ** 52 - 1);
      const result = await rpc("paws_pet", { p_user: user, p_pet: id });
      if (!result) throw new ApiError(404, "Профиль не найден.");
      return pet(result);
    }
    if (path === "/api/territories" && req.method === "GET") {
      const param = (key: string, fallback: number, min: number, max: number) =>
        number(
          url.searchParams.has(key)
            ? Number(url.searchParams.get(key))
            : fallback,
          min,
          max,
        );
      const west = param("west", -180, -180, 180),
        east = param("east", 180, -180, 180),
        south = param("south", -85, -85, 85),
        north = param("north", 85, -85, 85);
      if (west > east || south > north) {
        throw new ApiError(422, "Некорректная область карты.");
      }
      const result = await rpc("paws_map", {
        p_user: user,
        p_west: west,
        p_south: south,
        p_east: east,
        p_north: north,
      });
      result.pets = Object.fromEntries(
        Object.entries(result.pets as Record<string, Pet>).map((
          [id, value],
        ) => [id, pet(value)]),
      );
      return result;
    }
    if (path === "/api/walks" && req.method === "POST") {
      throw new ApiError(
        410,
        "Для захвата включите трансляцию: 📎 → Геопозиция → Транслировать геопозицию в чате бота.",
      );
    }
    if (path.startsWith("/api/walks/") && req.method === "DELETE") {
      const id = path.split("/").at(-1) ?? "";
      if (!UUID.test(id)) throw new ApiError(422, "Некорректная прогулка.");
      return await rpc("paws_cancel", { p_user: user, p_walk: id });
    }
    if (path === "/api/capture" && req.method === "POST") {
      throw new ApiError(
        410,
        "Захват доступен только через трансляцию геопозиции в чате бота.",
      );
    }
    throw new ApiError(404, "Такого действия нет.");
  }
  return async function handler(req: Request): Promise<Response> {
    const cors: Record<string, string> = {
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    };
    const incoming = req.headers.get("Origin");
    const response = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: cors });
    if (incoming && incoming !== origin) {
      return response({ detail: "Источник запроса не разрешён." }, 403);
    }
    if (incoming) cors["Access-Control-Allow-Origin"] = incoming;
    cors["Access-Control-Allow-Headers"] = "authorization,content-type";
    cors["Access-Control-Allow-Methods"] = "GET,POST,PUT,DELETE,OPTIONS";
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!origin || !token) {
      return response({
        detail: "Задайте APP_URL и TELEGRAM_BOT_TOKEN в секретах Supabase.",
      }, 503);
    }
    try {
      const url = new URL(req.url);
      const path =
        url.pathname.replace(/^\/(?:functions\/v1\/)?paws-api/, "") || "/";
      const result = await route(req, path, url);
      // Отказ уже записан RPC в walks.result. Ответ 422 не откатывает его.
      return response(result, result?.annulled === true ? 422 : 200);
    } catch (error) {
      if (error instanceof ApiError) {
        return response({ detail: error.message }, error.status);
      }
      // Не отдаём URL, заголовки и исключения HTTP-клиента: там могут быть токены.
      return response({
        detail: "Сервис временно недоступен. Повторите попытку.",
      }, 503);
    }
  };
}
