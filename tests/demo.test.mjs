import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createDemoApi } from "../web/demo.mjs";
import { createClient } from "../web/client.mjs";
const clipping = createRequire(import.meta.url)(
  "../web/vendor/polygon-clipping/polygon-clipping.js",
);
function storage() {
  const data = new Map();
  return { getItem: (k) => data.get(k), setItem: (k, v) => data.set(k, v) };
}
test("демо: профиль, перезахват и сохранение без реальной базы", async () => {
  const s = storage(), api = createDemoApi(s, clipping);
  await api("/api/me", {
    method: "PUT",
    body: JSON.stringify({
      name: "Луна",
      age: 2,
      color: "#397C63",
      description: "Мяч",
    }),
  });
  const captured = await api("/api/demo/capture", { method: "POST" });
  assert.ok(captured.area > 10000);
  const map = await api("/api/territories");
  assert.equal(map.territories.length, 2);
  assert.equal(map.pets["demo-neighbor"].name, "Бублик");
  const again = createDemoApi(s, clipping);
  assert.equal((await again("/api/me")).pet.name, "Луна");
  const replay = await api("/api/demo/capture", { method: "POST" });
  assert.ok(replay.area > 10000);
  assert.equal((await api("/api/territories")).territories.length, 2);
});
test("клиент Supabase использует только публичный URL и сохраняет tma-заголовок", async () => {
  let called;
  const client = createClient({
    location: { search: "" },
    fetch: async (url, options) => {
      called = { url, options };
      return Response.json({ pet: null });
    },
  });
  await client.api("/api/me", { headers: { Authorization: "tma signed" } });
  assert.match(
    called.url,
    /fywsqxijebneqkxusgro\.supabase\.co\/functions\/v1\/paws-api\/api\/me/,
  );
  assert.equal(called.options.headers.Authorization, "tma signed");
});
test("ошибка локального хранилища не выглядит успешным сохранением", async () => {
  const api = createDemoApi({
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  }, clipping);
  await assert.rejects(
    api("/api/me", {
      method: "PUT",
      body: JSON.stringify({ name: "Луна", age: 2, color: "#397C63" }),
    }),
    /сохранить демо/,
  );
});
