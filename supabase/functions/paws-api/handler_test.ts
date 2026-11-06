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
        respond
          ? respond(String(url), options)
          : Response.json({ pet: null, area: 0 }),
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
  assert(calls.length === 0);
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
Deno.test("маршрут: плохая точность отклоняется до базы, валидный передаётся RPC", async () => {
  const { handler, calls } = fixture(() =>
    Response.json({ id: "captured", area: 100 })
  );
  const walk = "00000000-0000-0000-0000-000000000000";
  const points = [0, 1, 2, 3].map((i) => ({
    latitude: 54,
    longitude: 20,
    accuracy: 3,
    timestamp: NOW - 3 + i,
  }));
  assert(
    (await handler(
      await request("/api/capture", "POST", {
        walk_id: walk,
        points: [...points.slice(0, 3), { ...points[3], accuracy: 16 }],
      }),
    )).status === 422,
  );
  assert(calls.length === 0);
  assert(
    (await handler(
      await request("/api/capture", "POST", { walk_id: walk, points }),
    )).status === 200,
  );
  assert(calls[0].url.endsWith("/rpc/paws_capture"));
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
  const payload = JSON.parse(String(calls[0].options.body));
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
    Response.json(url.endsWith("/paws_chat") ? { messages: [] } : { ok: true })
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
