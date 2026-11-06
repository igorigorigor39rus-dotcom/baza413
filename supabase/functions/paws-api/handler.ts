import { decode, encode } from "npm:jpeg-js@0.4.4";
import { ApiError, equalSecret, verifyInitData } from "./auth.ts";

type Dependencies = {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  now?: () => number;
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
  async function bot(method: string, payload: Record<string, unknown>) {
    if (!token) {
      throw new ApiError(503, "В Supabase не задан TELEGRAM_BOT_TOKEN.");
    }
    const response = await send(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) throw new ApiError(503, "Telegram временно недоступен.");
    const data = await response.json();
    if (!data.ok) throw new ApiError(503, "Telegram отклонил запрос бота.");
  }
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
  async function route(req: Request, path: string, url: URL) {
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
      const m = (update.message ?? update.edited_message) as
        | Record<string, unknown>
        | undefined;
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
          const result = await rpc("paws_live_point", {
            p_user: id,
            p_message: message,
            p_update: updateId,
            p_timestamp: number(m?.edit_date ?? m?.date, 0, 1e12),
            p_longitude: number(location.longitude, -180, 180),
            p_latitude: number(location.latitude, -85, 85),
            p_accuracy: typeof location.horizontal_accuracy === "number"
              ? number(location.horizontal_accuracy, 0, 1500)
              : null,
            p_period: typeof location.live_period === "number"
              ? number(location.live_period, 0, 2147483647)
              : null,
          });
          if (result.first) {
            await bot("sendMessage", {
              chat_id: id,
              text:
                "Фоновая запись началась. Telegram может передавать координаты при выключенном дисплее, если разрешён фоновый доступ к геопозиции. Вернитесь к старту в пределах 15 м, затем /capture. /status — состояние, /cancel — отмена. При пропусках GPS захват отклоняется.",
            });
          } else if (result.reason === "gap") {
            await bot("sendMessage", { chat_id: id, text: result.message });
          } else if (!update.edited_message && result.reason === "accuracy") {
            await bot("sendMessage", {
              chat_id: id,
              text:
                "Трансляция получена, но точность GPS неизвестна или хуже 15 м. Выйдите на открытое место; неточные точки не записываются.",
            });
          } else if (!update.edited_message && result.reason === "not_live") {
            await bot("sendMessage", {
              chat_id: id,
              text:
                "Нужна трансляция геопозиции через скрепку → Геопозиция → Транслировать, а не разовая точка.",
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
      if (["/capture", "/cancel", "/status"].includes(command)) {
        try {
          if (command === "/capture") {
            const result = await rpc("paws_live_capture", { p_user: id });
            await bot("sendMessage", {
              chat_id: id,
              text: `Территория захвачена: ${
                Math.round(Number(result.area))
              } м². Остановите трансляцию геопозиции в Telegram.`,
            });
          } else if (command === "/cancel") {
            await rpc("paws_live_cancel", { p_user: id });
            await bot("sendMessage", {
              chat_id: id,
              text:
                "Фоновая прогулка отменена, временные точки удалены. Остановите трансляцию геопозиции Telegram.",
            });
          } else {
            const result = await rpc("paws_live_status", { p_user: id });
            const walk = result.walk;
            await bot("sendMessage", {
              chat_id: id,
              text: !walk
                ? "Активной фоновой прогулки нет."
                : walk.error
                ? walk.error
                : walk.points.length
                ? `Принято точек: ${walk.points.length}. Последняя точность ±${
                  walk.points.at(-1).accuracy
                } м, ${Math.max(0, Math.round(now() - walk.points.at(-1).timestamp))} сек. назад. Точка не старше 15 секунд нужна для захвата. /capture — захват, /cancel — отмена.`
                : "Ждём трансляцию с точностью ≤15 м. Начните её через скрепку в этом чате.",
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
            "Сохраняются Telegram ID, профиль питомца, фото и контуры захваченных территорий. Профиль и контуры видны другим участникам. Обычный GPS-маршрут проверяется без сохранения. В фоновом режиме точки временно сохраняются в базе до завершения/отмены; просроченные маршруты очищаются при обращениях к фоновому API. Не указывайте домашний адрес в профиле.",
        });
      } else {await bot("sendMessage", {
          chat_id: id,
          text:
            "🐾 Бюро собачьих дел\n\nСоздайте досье питомца, обойдите участок и вернитесь в пределах 15 м от старта. Для старта и финиша нужна точность GPS ≤15 м.\n\nОбычная запись требует открытой карты. Для выключенного экрана выберите в приложении отдельный режим Telegram, затем отправьте этому боту трансляцию геопозиции. Фоновая работа зависит от телефона и разрешений. /status — состояние, /capture — захват, /cancel — отмена.\n\n/privacy — о данных.",
          reply_markup: {
            inline_keyboard: [[{
              text: "🐾 Открыть карту",
              web_app: { url: appUrl },
            }]],
          },
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
        version: "0.5.0",
        features,
        demoMode: false,
        closureMeters: 15,
        maxAccuracy: 15,
        demoRoute: null,
        appUrl,
      };
    }
    if (path === "/health" && req.method === "GET") {
      await rpc("paws_me", { p_user: 0 });
      await rpc("paws_wallet", { p_user: 0 });
      const capabilities = await rpc("paws_capabilities", {});
      if (!capabilities.liveTracking || !capabilities.leaderboard) {
        throw new ApiError(503, "Установите полную миграцию v.0.5.");
      }
      return { ok: true, version: "0.5.0" };
    }
    const authorization = req.headers.get("Authorization") ?? "";
    if (!authorization.startsWith("tma ")) {
      throw new ApiError(
        401,
        "Откройте приложение через кнопку Telegram-бота.",
      );
    }
    const user = await verifyInitData(authorization.slice(4), token, now());
    if (path === "/api/top" && req.method === "GET") {
      const result = await rpc("paws_top", { p_user: user });
      result.agents = result.agents.map((a: Record<string, unknown>) => ({
        ...a,
        pet: pet(a.pet as Pet),
      }));
      return result;
    }
    if (path === "/api/live/status" && req.method === "GET") {
      return await rpc("paws_live_status", { p_user: user });
    }
    if (path === "/api/live/start" && req.method === "POST") {
      const b = await jsonBody(req);
      const result = await rpc("paws_live_start", {
        p_user: user,
        p_accuracy: number(b.accuracy, 0, 15),
      });
      try {
        await bot("sendMessage", {
          chat_id: user,
          text:
            "Фоновая прогулка подготовлена. В этом чате: скрепка → Геопозиция → Транслировать геопозицию. Нужна точность ≤15 м. /status — состояние; /capture — захват после возврата к старту в пределах 15 м; /cancel — отмена. Разрешите Telegram доступ к геопозиции в фоне. Точки временно сохраняются на сервере.",
        });
      } catch {
        /* интерфейс тоже показывает инструкцию, созданную прогулку не теряем */
      }
      return result;
    }
    if (path === "/api/live/capture" && req.method === "POST") {
      return await rpc("paws_live_capture", { p_user: user });
    }
    if (path === "/api/live/cancel" && req.method === "POST") {
      return await rpc("paws_live_cancel", { p_user: user });
    }
    if (path === "/api/me" && req.method === "GET") {
      return profile(await rpc("paws_me", { p_user: user }));
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
          ].includes(k)
        )
      ) throw new ApiError(422, "Лишнее поле профиля.");
      if (
        typeof b.name !== "string" || !b.name.trim() ||
        b.name.trim().length > 40 || typeof b.description !== "string" ||
        b.description.length > 400 || typeof b.color !== "string" ||
        !/^#[0-9a-f]{6}$/i.test(b.color)
      ) throw new ApiError(422, "Проверьте кличку, описание и цвет питомца.");
      if (b.hue !== undefined) {
        const hue = number(b.hue, 0, 359),
          saturation = number(b.saturation, 20, 100),
          opacity = number(b.opacity, .15, .8);
        if (
          !Number.isInteger(hue) || !Number.isInteger(saturation) ||
          !["solid", "stripes", "grid", "camo"].includes(String(b.pattern))
        ) throw new ApiError(422, "Некорректный стиль заливки.");
        return profile(
          await rpc("paws_save_dossier", {
            p_user: user,
            p_name: b.name.trim(),
            p_age: number(b.age, 0, 35),
            p_description: b.description.trim(),
            p_color: b.color,
            p_hue: hue,
            p_saturation: saturation,
            p_opacity: opacity,
            p_pattern: b.pattern,
          }),
        );
      }
      return profile(
        await rpc("paws_save_pet", {
          p_user: user,
          p_name: b.name.trim(),
          p_age: number(b.age, 0, 35),
          p_description: b.description.trim(),
          p_color: b.color,
        }),
      );
    }
    if (path === "/api/wallet" && req.method === "GET") {
      return await rpc("paws_wallet", { p_user: user });
    }
    if (path === "/api/chat" && req.method === "GET") {
      const after = url.searchParams.get("after") ?? "0";
      if (!/^\d{1,18}$/.test(after)) {
        throw new ApiError(422, "Некорректный курсор чата.");
      }
      const result = await rpc("paws_chat", { p_user: user, p_after: after });
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
      return await rpc("paws_send", { p_user: user, p_text: b.text.trim() });
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
      return await rpc("paws_start", { p_user: user });
    }
    if (path.startsWith("/api/walks/") && req.method === "DELETE") {
      const id = path.split("/").at(-1) ?? "";
      if (!UUID.test(id)) throw new ApiError(422, "Некорректная прогулка.");
      return await rpc("paws_cancel", { p_user: user, p_walk: id });
    }
    if (path === "/api/capture" && req.method === "POST") {
      const b = await jsonBody(req);
      if (
        typeof b.walk_id !== "string" || !UUID.test(b.walk_id) ||
        !Array.isArray(b.points) || b.points.length < 4 ||
        b.points.length > 5000
      ) throw new ApiError(422, "Некорректная прогулка или число GPS-точек.");
      const points = b.points.map((raw) => {
        const p = object(raw);
        return {
          latitude: number(p.latitude, -85, 85),
          longitude: number(p.longitude, -180, 180),
          accuracy: number(p.accuracy, 0, 15),
          timestamp: number(p.timestamp, 0, 1e12),
        };
      });
      return await rpc("paws_capture", {
        p_user: user,
        p_walk: b.walk_id,
        p_points: points,
      });
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
      return response(await route(req, path, url));
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
