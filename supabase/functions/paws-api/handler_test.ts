import { encode } from "npm:jpeg-js@0.4.4";
import { ApiError, hmac, verifyInitData } from "./auth.ts";
import { createHandler } from "./handler.ts";

const TOKEN = "test-token-not-real";
const NOW = 1_800_000_000;
const ORIGIN = "https://igorigorigor39rus-dotcom.github.io";
const BASE = "https://project.example";
const SECRET = "test_webhook_secret_at_least_32_characters";
function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function signed(id = 42, date = NOW) {
  const fields = new Map([["auth_date", String(date)], [
    "user",
    JSON.stringify({ id, first_name: "Тест" }),
  ]]);
  const key = await hmac(new TextEncoder().encode("WebAppData"), TOKEN);
  const hash = await hmac(
    key,
    [...fields].sort().map(([k, v]) => `${k}=${v}`).join("\n"),
  );
  fields.set(
    "hash",
    [...hash].map((x) => x.toString(16).padStart(2, "0")).join(""),
  );
  return new URLSearchParams([...fields]).toString();
}
type Call = { url: string; options: RequestInit };
function fixture(
  respond?: (url: string, options: RequestInit) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const env: Record<string, string> = {
    SUPABASE_URL: BASE,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    TELEGRAM_BOT_TOKEN: TOKEN,
    APP_URL: `${ORIGIN}/baza413/`,
    WEBHOOK_SECRET: SECRET,
  };
  const handler = createHandler({
    env: (n) => env[n],
    now: () => NOW,
    fetch: ((url: string | URL | Request, options: RequestInit = {}) => {
      calls.push({ url: String(url), options });
      return Promise.resolve(
        respond ? respond(String(url), options) : Response.json(
          String(url).endsWith("/paws_capabilities")
            ? {
              dossier: true,
              chat: true,
              wallet: true,
              publicWallet: true,
              liveTracking: true,
              leaderboard: true,
              autoLiveStart: true,
              crossingRoutes: true,
              purchases: true,
              territoryLeaderboard: true,
              unlimitedPurchases: true,
              mergeOwnPurchases: true,
              foreignBuyouts: true,
              notifications: true,
              geoChat: true,
              liveOnly: true,
              captureHelp: true,
              extraCamouflage: true,
              dailyIncome: true,
              incomePeriodSeconds: 86400,
              sqmPerBone: 10,
              starShop: true,
              reminders: true,
              largestTerritory: true,
              speedLimit: true,
              maxSpeedKmh: 20,
              maxAccuracy: 20,
              closureMeters: 20,
              photoLimit: 1000000,
            }
            : { pet: null, area: 0 },
        ),
      );
    }) as typeof fetch,
  });
  return { handler, calls, env };
}
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${BASE}/functions/v1/paws-api${path}`, {
    method,
    headers: {
      Authorization: `tma ${await signed()}`,
      Origin: ORIGIN,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

Deno.test("Telegram HMAC: правильная подпись и user ID", async () =>
  assert(await verifyInitData(await signed(), TOKEN, NOW) === 42));
Deno.test("подмена, истечение, будущее, дубликаты и неверный id отклоняются", async () => {
  for (
    const raw of [
      (await signed()).replace("42", "43"),
      await signed(42, NOW - 21601),
      await signed(42, NOW + 60),
      `${await signed()}&user=duplicate`,
      await signed(-1),
    ]
  ) {
    try {
      await verifyInitData(raw, TOKEN, NOW);
      throw new Error("accepted");
    } catch (e) {
      assert(e instanceof ApiError && e.status === 401);
    }
  }
});
Deno.test("CORS preflight только для нашего origin", async () => {
  const { handler, calls } = fixture();
  const good = await handler(
    new Request(`${BASE}/paws-api/api/me`, {
      method: "OPTIONS",
      headers: { Origin: ORIGIN },
    }),
  );
  assert(
    good.status === 204 &&
      good.headers.get("Access-Control-Allow-Origin") === ORIGIN,
  );
  const bad = await handler(
    new Request(`${BASE}/paws-api/api/me`, {
      method: "OPTIONS",
      headers: { Origin: "https://attacker.example" },
    }),
  );
  assert(bad.status === 403 && !bad.headers.has("Access-Control-Allow-Origin"));
  assert(calls.length === 0);
});
Deno.test("публичный config, но профиль требует Telegram", async () => {
  const { handler, calls } = fixture();
  assert(
    (await handler(new Request(`${BASE}/paws-api/api/config`))).status === 200,
  );
  assert(
    (await handler(new Request(`${BASE}/paws-api/api/me`))).status === 401,
  );
  assert(calls.length === 1 && calls[0].url.endsWith("/paws_capabilities"));
});
Deno.test("RPC получает только проверенный user ID; ключи не возвращаются", async () => {
  const { handler, calls } = fixture();
  const r = await handler(await request("/api/me"));
  assert(r.status === 200);
  assert(JSON.parse(String(calls[0].options.body)).p_user === 42);
  const text = await r.text();
  assert(!text.includes("test-service-key") && !text.includes(TOKEN));
});
Deno.test("профиль: проверка полей и запрет подмены владельца", async () => {
  const { handler, calls } = fixture();
  for (
    const data of [
      { name: "Ричи", age: -1, description: "", color: "#397C63" },
      { name: "Ричи", age: 3, description: "", color: "#397C63", owner_id: 43 },
    ]
  ) {
    assert(
      (await handler(await request("/api/me", "PUT", data))).status === 422,
    );
  }
  assert(calls.length === 0);
  assert(
    (await handler(
      await request("/api/me", "PUT", {
        name: " Ричи ",
        age: 3,
        description: "Мяч",
        color: "#397C63",
      }),
    )).status === 200,
  );
  assert(JSON.parse(String(calls[0].options.body)).p_name === "Ричи");
});
Deno.test("карта: bbox и публичные URL аватаров", async () => {
  const { handler } = fixture(() =>
    Response.json({
      territories: [],
      pets: {
        "42": {
          id: "42",
          photo_key: "42/00000000-0000-0000-0000-000000000000.jpg",
        },
      },
      truncated: false,
    })
  );
  const r = await handler(
    await request("/api/territories?west=20&east=21&south=54&north=55"),
  );
  assert(
    (await r.json()).pets["42"].photo.startsWith(
      `${BASE}/storage/v1/object/public/`,
    ),
  );
  assert(
    (await handler(await request("/api/territories?west=22&east=21")))
      .status === 422,
  );
});
Deno.test("v09: браузерный старт и GPS-захват отключены до RPC", async () => {
  const f = fixture();
  for (const path of ["/api/walks", "/api/capture"]) {
    const response = await f.handler(
      await request(path, "POST", { points: [] }),
    );
    assert(response.status === 410);
    assert((await response.json()).detail.includes("трансляци"));
  }
  assert(f.calls.length === 0);
});
Deno.test("ошибки SQL не раскрывают внутренности и секреты", async () => {
  const { handler } = fixture(() =>
    Response.json({ code: "42P01", message: `sensitive ${TOKEN}` }, {
      status: 400,
    })
  );
  const r = await handler(await request("/api/me"));
  assert(r.status === 503);
  assert(!(await r.text()).includes(TOKEN));
  const invalid = fixture(() =>
    Response.json({ code: "P0001", message: "Контур открыт." }, { status: 400 })
  );
  const response = await invalid.handler(await request("/api/me"));
  assert(response.status === 422);
  assert((await response.json()).detail === "Контур открыт.");
});
Deno.test("webhook: без секрета нет сообщений; /start содержит Mini App", async () => {
  const { handler, calls } = fixture(() =>
    Response.json({ ok: true, result: { message_id: 1 } })
  );
  const update = {
    message: {
      text: "/start",
      chat: { id: 42, type: "private" },
      from: { id: 42 },
    },
  };
  assert(
    (await handler(await request("/webhook", "POST", update))).status === 401,
  );
  assert(calls.length === 0);
  assert(
    (await handler(
      await request("/webhook", "POST", update, {
        "X-Telegram-Bot-Api-Secret-Token": SECRET,
      }),
    )).status === 200,
  );
  const payload = JSON.parse(
    String(calls.find((c) => c.url.endsWith("/sendMessage"))!.options.body),
  );
  assert(
    payload.reply_markup.inline_keyboard[0][0].web_app.url ===
      `${ORIGIN}/baza413/`,
  );
});
Deno.test("webhook игнорирует группы и пустые сообщения", async () => {
  const { handler, calls } = fixture();
  for (
    const message of [{ text: " ", chat: { id: 42, type: "private" } }, {
      text: "/start",
      chat: { id: 42, type: "group" },
    }]
  ) {
    assert(
      (await handler(
        await request("/webhook", "POST", { message }, {
          "X-Telegram-Bot-Api-Secret-Token": SECRET,
        }),
      )).status === 200,
    );
  }
  assert(calls.length === 0);
});
Deno.test("JPEG перекодируется перед Storage, профиль связывается с новым файлом", async () => {
  const { handler, calls } = fixture((url) => {
    if (url.endsWith("/rpc/paws_me")) {
      return Response.json({ pet: { id: "42" }, area: 0 });
    }
    if (url.endsWith("/rpc/paws_photo")) {
      return Response.json({
        profile: { pet: { id: "42" }, area: 0 },
        previous: null,
      });
    }
    return Response.json({ ok: true });
  });
  const jpeg =
    encode({ width: 2, height: 2, data: new Uint8Array(16).fill(255) }, 85)
      .data;
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(jpeg)]), "pet.jpg");
  const r = await handler(
    new Request(`${BASE}/paws-api/api/me/photo`, {
      method: "POST",
      headers: { Authorization: `tma ${await signed()}`, Origin: ORIGIN },
      body: form,
    }),
  );
  assert(r.status === 200);
  assert(
    calls.some((c) => c.url.includes("/storage/v1/object/paws-photos/42/")),
  );
  assert(calls.some((c) => c.url.endsWith("/rpc/paws_photo")));
  // Имитируем commit с потерянным ответом: новый аватар нельзя удалять.
  let committed: string | null = null;
  const lost = fixture((url, options) => {
    if (url.endsWith("/rpc/paws_photo")) {
      committed = JSON.parse(String(options.body)).p_key;
      throw new Error("response lost after commit");
    }
    if (url.endsWith("/rpc/paws_me")) {
      return Response.json({
        pet: { id: "42", photo_key: committed },
        area: 0,
      });
    }
    return Response.json({ ok: true });
  });
  const again = new FormData();
  again.set("file", new Blob([new Uint8Array(jpeg)]), "pet.jpg");
  const recovered = await lost.handler(
    new Request(`${BASE}/paws-api/api/me/photo`, {
      method: "POST",
      headers: { Authorization: `tma ${await signed()}` },
      body: again,
    }),
  );
  assert(recovered.status === 200);
  assert(!lost.calls.some((c) => c.options.method === "DELETE"));
});
Deno.test("не JPEG и большой HTTP body отклоняются", async () => {
  const { handler } = fixture();
  const form = new FormData();
  form.set("file", new Blob(["<svg/>"]), "bad.svg");
  assert(
    (await handler(
      new Request(`${BASE}/paws-api/api/me/photo`, {
        method: "POST",
        headers: { Authorization: `tma ${await signed()}` },
        body: form,
      }),
    )).status === 422,
  );
  assert(
    (await handler(
      new Request(`${BASE}/paws-api/api/me`, {
        method: "PUT",
        headers: { Authorization: `tma ${await signed()}` },
        body: "x".repeat(3 * 1024 * 1024 + 1),
      }),
    )).status === 413,
  );
});

Deno.test("досье: новые поля передаются в отдельный RPC и валидируются", async () => {
  const { handler, calls } = fixture();
  const body = {
    name: "Агент",
    age: 3,
    description: "Досье",
    color: "#336699",
    hue: 210,
    saturation: 55,
    opacity: .35,
    pattern: "camo",
  };
  assert((await handler(await request("/api/me", "PUT", body))).status === 200);
  assert(calls[0].url.endsWith("/rpc/paws_save_dossier"));
  assert(JSON.parse(String(calls[0].options.body)).p_user === 42);
  assert(
    (await handler(
      await request("/api/me", "PUT", { ...body, pattern: "<script>" }),
    )).status === 422,
  );
});
Deno.test("чат и баланс всегда используют проверенного владельца", async () => {
  const { handler, calls } = fixture((url) =>
    Response.json(
      url.endsWith("/paws_chat_room") ? { messages: [] } : { ok: true },
    )
  );
  assert((await handler(await request("/api/wallet"))).status === 200);
  assert(
    (await handler(
      await request("/api/chat", "POST", { text: "Привет", owner_id: 99 }),
    )).status === 200,
  );
  assert((await handler(await request("/api/chat?after=1"))).status === 200);
  for (const c of calls) {
    assert(JSON.parse(String(c.options.body)).p_user === 42);
  }
  assert(
    (await handler(await request("/api/chat", "POST", { text: " " })))
      .status === 422,
  );
  assert((await handler(await request("/api/chat?after=bad"))).status === 422);
});

Deno.test("готовность проверяет БД, а не обещает функции при старой схеме", async () => {
  const { handler } = fixture(() =>
    Response.json({ code: "PGRST202" }, { status: 404 })
  );
  const r = await handler(new Request(`${BASE}/paws-api/api/config`));
  const config = await r.json();
  assert(
    config.version === "0.9.0" && config.features.chat === false &&
      config.features.dossier === false,
  );
});
Deno.test("карточка питомца сохраняет публичный баланс, без чужой транзакции", async () => {
  const { handler, calls } = fixture(() =>
    Response.json({
      id: "99",
      name: "Агент",
      wallet: { balance: 123.45, rate: 10 },
    })
  );
  const r = await handler(await request("/api/pets/99"));
  assert((await r.json()).wallet.balance === 123.45);
  assert(calls.length === 1 && calls[0].url.endsWith("/paws_pet"));
});
Deno.test("фото больше 1 МБ отклоняется до Storage", async () => {
  const { handler, calls } = fixture();
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(1000001)]), "pet.jpg");
  const r = await handler(
    new Request(`${BASE}/paws-api/api/me/photo`, {
      method: "POST",
      headers: { Authorization: `tma ${await signed()}` },
      body: form,
    }),
  );
  assert(r.status === 413 && calls.length === 0);
});

Deno.test("live: только подписанный Telegram update с владельцем личного чата", async () => {
  const f = fixture((url) =>
    Response.json(
      url.includes("api.telegram.org")
        ? { ok: true, result: {} }
        : { accepted: true, first: true },
    )
  );
  const m = {
    message_id: 7,
    date: NOW - 20,
    edit_date: NOW,
    from: { id: 42 },
    chat: { id: 42, type: "private" },
    location: {
      latitude: 54,
      longitude: 20,
      horizontal_accuracy: 12,
      live_period: 3600,
    },
  };
  const r = await f.handler(
    await request("/webhook", "POST", { update_id: 20, edited_message: m }, {
      "X-Telegram-Bot-Api-Secret-Token": SECRET,
    }),
  );
  assert(r.status === 200);
  const c = f.calls.find((c) => c.url.endsWith("/paws_live_receive"))!;
  const payload = JSON.parse(String(c.options.body));
  assert(
    payload.p_user === 42 && payload.p_timestamp === NOW &&
      payload.p_accuracy === 12 && payload.p_initial === false &&
      payload.p_sent_at === NOW - 20,
  );
  const before = f.calls.length;
  await f.handler(
    await request("/webhook", "POST", {
      update_id: 21,
      message: { ...m, from: { id: 43 } },
    }, { "X-Telegram-Bot-Api-Secret-Token": SECRET }),
  );
  assert(f.calls.length === before);
  assert(
    (await f.handler(await request("/api/live/point", "POST", {}))).status ===
      404,
  );
});
Deno.test("live: неизвестная точность не превращается в ноль", async () => {
  const f = fixture(() =>
    Response.json({ accepted: false, reason: "accuracy" })
  );
  const r = await f.handler(
    await request("/webhook", "POST", {
      update_id: 21,
      edited_message: {
        message_id: 7,
        date: NOW,
        from: { id: 42 },
        chat: { id: 42, type: "private" },
        location: { latitude: 54, longitude: 20, live_period: 3600 },
      },
    }, { "X-Telegram-Bot-Api-Secret-Token": SECRET }),
  );
  assert(r.status === 200);
  assert(JSON.parse(String(f.calls[0].options.body)).p_accuracy === null);
});
Deno.test("live: ошибки открытого контура отвечают пользователю и ACK Telegram", async () => {
  const f = fixture((url) =>
    url.includes("api.telegram.org")
      ? Response.json({ ok: true, result: {} })
      : Response.json({
        code: "P0001",
        message: "Контур открыт. Вернитесь в пределах 20 м.",
      }, { status: 400 })
  );
  const r = await f.handler(
    await request("/webhook", "POST", {
      message: {
        text: "/capture",
        from: { id: 42 },
        chat: { id: 42, type: "private" },
      },
    }, { "X-Telegram-Bot-Api-Secret-Token": SECRET }),
  );
  assert(r.status === 200);
  assert(f.calls.some((c) => c.url.includes("/sendMessage")));
});
Deno.test("live: старт при погрешности 20 м, запрет более 20", async () => {
  const f = fixture((url) =>
    Response.json(
      url.includes("api.telegram.org")
        ? { ok: true, result: {} }
        : { walk: { id: "live" } },
    )
  );
  assert(
    (await f.handler(
      await request("/api/live/start", "POST", { accuracy: 20 }),
    )).status === 200,
  );
  const before = f.calls.length;
  assert(
    (await f.handler(
      await request("/api/live/start", "POST", { accuracy: 20.01 }),
    )).status === 422,
  );
  assert(f.calls.length === before);
});
Deno.test("TOP: проверенный пользователь, порядок сервера и публичные аватары", async () => {
  const f = fixture(() =>
    Response.json({
      agents: [{ pet: { id: "99", name: "Лидер" }, wallet: { balance: 100 } }],
    })
  );
  const r = await f.handler(await request("/api/top"));
  const data = await r.json();
  assert(
    data.agents[0].pet.id === "99" && data.agents[0].wallet.balance === 100,
  );
  assert(JSON.parse(String(f.calls[0].options.body)).p_user === 42);
});

Deno.test("v06: кнопки прогулки проверяют отправителя и вызывают только его RPC", async () => {
  const f = fixture((url) =>
    Response.json(
      url.includes("api.telegram.org")
        ? { ok: true, result: {} }
        : { id: "capture", area: 123 },
    )
  );
  const query = {
    id: "callback-1",
    data: "walk_capture",
    from: { id: 42 },
    message: { chat: { id: 42, type: "private" } },
  };
  const headers = { "X-Telegram-Bot-Api-Secret-Token": SECRET };
  assert(
    (await f.handler(
      await request("/webhook", "POST", { callback_query: query }, headers),
    )).status === 200,
  );
  const capture = f.calls.find((c) => c.url.endsWith("/paws_live_capture"))!;
  assert(JSON.parse(String(capture.options.body)).p_user === 42);
  assert(f.calls.some((c) => c.url.endsWith("/answerCallbackQuery")));
  const count = f.calls.length;
  for (
    const invalid of [{ ...query, from: { id: 43 } }, {
      ...query,
      message: { chat: { id: 42, type: "group" } },
    }, { ...query, data: "unknown" }]
  ) {
    await f.handler(
      await request("/webhook", "POST", { callback_query: invalid }, headers),
    );
    assert(f.calls.length === count);
  }
});

Deno.test("v06: переход в чат отправляет инструкцию без запуска прогулки и GPS", async () => {
  const f = fixture(() => Response.json({ ok: true, result: {} }));
  assert(
    (await f.handler(await request("/api/live/instructions", "POST")))
      .status === 200,
  );
  assert(f.calls.length === 1 && f.calls[0].url.endsWith("/sendMessage"));
  const payload = JSON.parse(String(f.calls[0].options.body));
  assert(
    payload.chat_id === 42 &&
      payload.reply_markup.inline_keyboard[1][0].callback_data ===
        "walk_capture",
  );
  assert(
    (await f.handler(
      new Request(`${BASE}/paws-api/api/live/instructions`, { method: "POST" }),
    )).status === 401,
  );
});

Deno.test("v06: новый сервер сообщает порог БД и требует миграцию для health", async () => {
  const f = fixture();
  const config = await (await f.handler(await request("/api/config"))).json();
  assert(
    config.maxAccuracy === 20 && config.closureMeters === 20 &&
      config.features.crossingRoutes,
  );
  assert((await f.handler(await request("/health"))).status === 200);
  const old = fixture((url) =>
    Response.json(
      url.endsWith("/paws_capabilities")
        ? { liveTracking: true, leaderboard: true }
        : {},
    )
  );
  assert((await old.handler(await request("/health"))).status === 503);
  const legacy = await (await old.handler(await request("/api/config"))).json();
  assert(legacy.maxAccuracy === 15 && legacy.closureMeters === 15);
});

Deno.test("v06: новая трансляция передаёт в БД признак автоматического запуска", async () => {
  const f = fixture((url) =>
    Response.json(
      url.includes("api.telegram.org")
        ? { ok: true, result: {} }
        : { accepted: true, first: true, prepared: true },
    )
  );
  await f.handler(
    await request("/webhook", "POST", {
      update_id: 7,
      message: {
        message_id: 9,
        date: NOW,
        from: { id: 42 },
        chat: { id: 42, type: "private" },
        location: {
          latitude: 54,
          longitude: 20,
          horizontal_accuracy: 20,
          live_period: 3600,
        },
      },
    }, { "X-Telegram-Bot-Api-Secret-Token": SECRET }),
  );
  const args = JSON.parse(String(f.calls[0].options.body));
  assert(
    f.calls[0].url.endsWith("/paws_live_receive") && args.p_initial === true &&
      args.p_sent_at === NOW && args.p_accuracy === 20,
  );
});

Deno.test("v06: покупка использует владельца подписи и проверяет цену/контур до RPC", async () => {
  const f = fixture(() => Response.json({ area: 100, cost: 1000 }));
  const vertices = [{ longitude: 20, latitude: 54 }, {
    longitude: 20.001,
    latitude: 54,
  }, { longitude: 20, latitude: 54.001 }];
  assert(
    (await f.handler(
      await request("/api/purchases/quote", "POST", { vertices, user_id: 999 }),
    )).status === 200,
  );
  assert(JSON.parse(String(f.calls[0].options.body)).p_user === 42);
  const body = {
    vertices,
    requestId: "00000000-0000-0000-0000-000000000001",
    maxCost: 1000,
    user_id: 999,
  };
  assert(
    (await f.handler(await request("/api/purchases", "POST", body))).status ===
      200,
  );
  assert(f.calls.at(-1)!.url.endsWith("/paws_purchase"));
  const count = f.calls.length;
  for (
    const invalid of [{ ...body, maxCost: -1 }, { ...body, vertices: [] }, {
      ...body,
      requestId: "broken",
    }]
  ) {
    assert(
      (await f.handler(await request("/api/purchases", "POST", invalid)))
        .status === 422,
    );
  }
  assert(f.calls.length === count);
});

Deno.test("v06: рейтинг площади выбирает отдельный RPC и сохраняет фото", async () => {
  const f = fixture(() =>
    Response.json({
      agents: [{
        pet: {
          id: "42",
          photo_key: "42/00000000-0000-0000-0000-000000000001.jpg",
        },
        area: 200,
        wallet: { balance: 10 },
      }],
    })
  );
  const response = await f.handler(await request("/api/top?sort=area"));
  const data = await response.json();
  assert(
    f.calls[0].url.endsWith("/paws_top_area") && data.agents[0].area === 200 &&
      data.agents[0].pet.photo.endsWith(".jpg"),
  );
  const count = f.calls.length;
  assert(
    (await f.handler(await request("/api/top?sort=invalid"))).status === 422 &&
      f.calls.length === count,
  );
});

Deno.test("v07: покупка дороже прежнего потолка передаёт полную сумму в RPC", async () => {
  const f = fixture(() => Response.json({ id: "purchase", cost: 250000000 }));
  const r = await f.handler(
    await request("/api/purchases", "POST", {
      requestId: "00000000-0000-0000-0000-000000000001",
      maxCost: 250000000,
      vertices: [{ longitude: 20, latitude: 54 }, {
        longitude: 21,
        latitude: 54,
      }, { longitude: 20, latitude: 55 }],
    }),
  );
  assert(r.status === 200);
  assert(JSON.parse(String(f.calls[0].options.body)).p_max_cost === 250000000);
});

Deno.test("v071: выплата подтверждается до отправки и сбой Telegram не отменяет покупку", async () => {
  let claimed = false;
  const f = fixture((url) => {
    if (url.endsWith("/paws_purchase")) {
      return Response.json({
        id: "bought",
        cost: 1000,
        reparations: [{ ownerId: "43", amount: 100 }],
      });
    }
    if (url.endsWith("/paws_notify_claim")) {
      if (claimed) return Response.json({ messages: [] });
      claimed = true;
      return Response.json({
        messages: [{
          id: "00000000-0000-0000-0000-000000000001",
          recipientId: "43",
          message:
            "Рекс выкупил вашу территорию, вам выплачены репарации в количестве 100 🦴.",
          leaseToken: "00000000-0000-0000-0000-000000000002",
        }],
      });
    }
    if (url.includes("api.telegram.org")) {
      return Response.json({ ok: false }, { status: 403 });
    }
    return Response.json({ ok: true });
  });
  const response = await f.handler(
    await request("/api/purchases", "POST", {
      requestId: "00000000-0000-0000-0000-000000000001",
      maxCost: 1000,
      vertices: [{ longitude: 20, latitude: 54 }, {
        longitude: 20.001,
        latitude: 54,
      }, { longitude: 20, latitude: 54.001 }],
    }),
  );
  assert(response.status === 200 && (await response.json()).id === "bought");
  assert(f.calls[0].url.endsWith("/paws_purchase"));
  const sent = f.calls.find((c) => c.url.endsWith("/sendMessage"))!;
  assert(JSON.parse(String(sent.options.body)).chat_id === 43);
  const finish = f.calls.find((c) => c.url.endsWith("/paws_notify_finish"))!;
  assert(JSON.parse(String(finish.options.body)).p_ok === false);
});

Deno.test("v071: успешная доставка помечается, чужая история недоступна", async () => {
  let claimed = false;
  const f = fixture((url) => {
    if (url.endsWith("/paws_notifications")) {
      return Response.json({ notifications: [], unread: 0 });
    }
    if (url.endsWith("/paws_notify_claim")) {
      if (claimed) return Response.json({ messages: [] });
      claimed = true;
      return Response.json({
        messages: [{
          id: "id",
          recipientId: "43",
          message: "notification",
          leaseToken: "lease",
        }],
      });
    }
    return Response.json({ ok: true, result: {} });
  });
  assert(
    (await f.handler(await request("/api/notifications?user_id=999")))
      .status === 200,
  );
  assert(JSON.parse(String(f.calls[0].options.body)).p_user === 42);
  assert(
    JSON.parse(String(
      f.calls.find((c) => c.url.endsWith("/paws_notify_finish"))!.options.body,
    )).p_ok === true,
  );
  assert(
    (await f.handler(
      await request("/api/notifications/read", "POST", {
        ids: ["00000000-0000-0000-0000-000000000001"],
        user_id: 999,
      }),
    )).status === 200,
  );
  assert(JSON.parse(String(f.calls.at(-1)!.options.body)).p_user === 42);
  assert(
    (await f.handler(
      await request("/api/notifications/read", "POST", { ids: ["invalid"] }),
    )).status === 422,
  );
});

Deno.test("v09: захват трансляции не вызывает репарации или рассылку", async () => {
  const f = fixture(() => Response.json({ id: "captured", area: 100 }));
  assert(
    (await f.handler(await request("/api/live/capture", "POST"))).status ===
      200,
  );
  assert(f.calls.length === 1 && f.calls[0].url.endsWith("/paws_live_capture"));
});

const SPEED_WARNING = "Ай яй яй, захват аннулирован, играй честно";
const speedRefusal = {
  annulled: true,
  code: "SPEED_LIMIT",
  walkId: "00000000-0000-0000-0000-000000000001",
  detail: SPEED_WARNING,
  averageSpeedKmh: 40,
};
Deno.test("v09: захват трансляции возвращает окончательный отказ после RPC", async () => {
  const f = fixture(() => Response.json(speedRefusal));
  const response = await f.handler(await request("/api/live/capture", "POST"));
  const data = await response.json();
  assert(
    response.status === 422 && data.annulled && data.code === "SPEED_LIMIT" &&
      data.detail === SPEED_WARNING,
  );
  assert(f.calls.length === 1 && f.calls[0].url.endsWith("/paws_live_capture"));
});
Deno.test("v08: бот сообщает об аннулировании без NaN и подтверждает webhook", async () => {
  const f = fixture((url) =>
    Response.json(
      url.includes("api.telegram.org")
        ? { ok: true, result: {} }
        : speedRefusal,
    )
  );
  const response = await f.handler(
    await request("/webhook", "POST", {
      message: {
        text: "/capture",
        from: { id: 42 },
        chat: { id: 42, type: "private" },
      },
    }, { "X-Telegram-Bot-Api-Secret-Token": SECRET }),
  );
  assert(response.status === 200);
  const message = JSON.parse(
    String(f.calls.find((c) => c.url.endsWith("/sendMessage"))!.options.body),
  );
  assert(message.text === SPEED_WARNING);
});
Deno.test("v08: статус сохраняет причину аннулирования после закрытия приложения", async () => {
  const f = fixture((url) =>
    Response.json(
      url.includes("api.telegram.org")
        ? { ok: true, result: {} }
        : { walk: null, result: speedRefusal },
    )
  );
  const response = await f.handler(await request("/api/live/status"));
  assert(response.status === 200);
  assert((await response.json()).result.annulled);
  await f.handler(
    await request("/webhook", "POST", {
      message: {
        text: "/status",
        from: { id: 42 },
        chat: { id: 42, type: "private" },
      },
    }, { "X-Telegram-Bot-Api-Secret-Token": SECRET }),
  );
  const message = JSON.parse(
    String(f.calls.find((c) => c.url.endsWith("/sendMessage"))!.options.body),
  );
  assert(message.text === SPEED_WARNING);
});

Deno.test("v08: scheduler requires separate secret before queue access", async () => {
  const f = fixture((url) =>
    Response.json(
      url.endsWith("/paws_reminders_generate")
        ? { queued: 1 }
        : { messages: [] },
    )
  );
  const req = (secret: string) =>
    new Request(`${BASE}/functions/v1/paws-api/internal/scheduler`, {
      method: "POST",
      headers: { "X-Scheduler-Secret": secret },
      body: "{}",
    });
  assert((await f.handler(req(SECRET))).status === 503);
  assert(f.calls.length === 0);
  f.env.SCHEDULER_SECRET = SECRET;
  assert((await f.handler(req("wrong"))).status === 401);
  assert(f.calls.length === 0);
  assert((await f.handler(req(SECRET))).status === 200);
  assert(f.calls.some((c) => c.url.endsWith("/paws_reminders_generate")));
  assert(f.calls.some((c) => c.url.endsWith("/paws_reminders_claim")));
});
Deno.test("v08: presence and largest territory use verified caller and separate pet ID", async () => {
  const f = fixture();
  assert(
    (await f.handler(
      await request("/api/activity", "POST", {
        timezone: "Europe/Kaliningrad",
        userId: 99,
      }),
    )).status === 200,
  );
  let args = JSON.parse(String(f.calls[0].options.body));
  assert(args.p_user === 42 && args.p_timezone === "Europe/Kaliningrad");
  f.calls.length = 0;
  assert(
    (await f.handler(await request("/api/pets/43/largest-territory")))
      .status === 200,
  );
  args = JSON.parse(String(f.calls[0].options.body));
  assert(
    f.calls[0].url.endsWith("/paws_largest_territory") && args.p_user === 42 &&
      args.p_pet === 43,
  );
  const before = f.calls.length;
  assert(
    (await f.handler(
      await request("/api/reminders", "POST", { enabled: "false" }),
    )).status === 422,
  );
  assert(f.calls.length === before);
});

Deno.test("v09: category and caller are validated for both chat methods", async () => {
  const f = fixture((url) =>
    Response.json(
      url.endsWith("/paws_chat_room")
        ? { messages: [], canRead: true, canPost: false }
        : { ok: true },
    )
  );
  assert(
    (await f.handler(await request("/api/chat?channel=district"))).status ===
      200,
  );
  let payload = JSON.parse(String(f.calls[0].options.body));
  assert(payload.p_channel === "district" && payload.p_user === 42);
  assert(
    (await f.handler(
      await request("/api/chat", "POST", {
        text: "Привет",
        channel: "city",
        owner_id: 99,
      }),
    )).status === 200,
  );
  payload = JSON.parse(String(f.calls[1].options.body));
  assert(
    payload.p_channel === "city" && payload.p_user === 42 &&
      f.calls[1].url.endsWith("/paws_send_room"),
  );
  const count = f.calls.length;
  assert(
    (await f.handler(await request("/api/chat?channel=nearby"))).status === 422,
  );
  assert(
    (await f.handler(
      await request("/api/chat", "POST", { text: "x", channel: {} }),
    )).status === 422,
  );
  assert(f.calls.length === count);
});

Deno.test("v09: кнопка Захватить без трансляции даёт короткую инструкцию и ACK", async () => {
  const help =
    "Включите трансляцию: 📎 → Геопозиция → Транслировать геопозицию. Затем пройдите маршрут и нажмите «Захватить».";
  const f = fixture((url) =>
    url.endsWith("/paws_live_capture")
      ? Response.json({ code: "P0001", message: help }, { status: 400 })
      : Response.json({ ok: true, result: {} })
  );
  for (
    const update of [{
      message: {
        text: "/capture",
        from: { id: 42 },
        chat: { id: 42, type: "private" },
      },
    }, {
      callback_query: {
        id: "button",
        data: "walk_capture",
        from: { id: 42 },
        message: { chat: { id: 42, type: "private" } },
      },
    }]
  ) {
    const r = await f.handler(
      await request("/webhook", "POST", update, {
        "X-Telegram-Bot-Api-Secret-Token": SECRET,
      }),
    );
    assert(r.status === 200);
  }
  const sent = f.calls.filter((c) => c.url.endsWith("/sendMessage"));
  assert(sent.length === 2);
  assert(sent.every((c) => JSON.parse(String(c.options.body)).text === help));
});
Deno.test("v09: три дополнительных камуфляжа проходят серверную проверку досье", async () => {
  const f = fixture();
  for (const pattern of ["digital", "tiger", "flecktarn"]) {
    const r = await f.handler(
      await request("/api/me", "PUT", {
        name: "Рекс",
        age: 2,
        description: "",
        color: "#397c63",
        hue: 150,
        saturation: 55,
        opacity: .35,
        pattern,
      }),
    );
    assert(r.status === 200);
    assert(
      JSON.parse(String(f.calls.at(-1)!.options.body)).p_pattern === pattern,
    );
  }
});
