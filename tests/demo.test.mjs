import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createDemoApi } from "./fixtures/legacy-demo.mjs";
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

test("демо: покупка свободного участка, цена 10, повтор без списания и рейтинг площади", async () => {
  const s = storage(), api = createDemoApi(s, clipping);
  await api("/api/me", {
    method: "PUT",
    body: JSON.stringify({ name: "Генерал", age: 2, color: "#397C63" }),
  });
  await api("/api/demo/capture", { method: "POST" });
  const key = "paws:browser-demo:v1", data = JSON.parse(s.getItem(key));
  data.wallets["demo-me"].balance = 100000;
  s.setItem(key, JSON.stringify(data));
  const vertices = [
    { longitude: 20.46, latitude: 54.71 },
    { longitude: 20.4602, latitude: 54.71 },
    { longitude: 20.4602, latitude: 54.7102 },
    { longitude: 20.46, latitude: 54.7102 },
  ];
  const quote = await api("/api/purchases/quote", {
    method: "POST",
    body: JSON.stringify({ vertices }),
  });
  assert.equal(quote.cost, Math.ceil(quote.area * 10));
  assert.equal(quote.affordable, true);
  const body = JSON.stringify({
    vertices,
    maxCost: quote.cost,
    requestId: crypto.randomUUID(),
  });
  const receipt = await api("/api/purchases", { method: "POST", body });
  const before = JSON.parse(s.getItem(key)).wallets["demo-me"].balance;
  assert.deepEqual(
    await api("/api/purchases", { method: "POST", body }),
    receipt,
  );
  assert.equal(JSON.parse(s.getItem(key)).wallets["demo-me"].balance, before);
  await assert.rejects(
    api("/api/purchases/quote", {
      method: "POST",
      body: JSON.stringify({ vertices }),
    }),
    /уже принадлежит/,
  );
  const top = await api("/api/top?sort=area");
  assert.equal(top.agents[0].pet.id, "demo-me");
  assert.ok(top.agents[0].area > receipt.area);
});

test("демо: расширение своего участка оплачивает только новую часть", async () => {
  const s = storage(), api = createDemoApi(s, clipping);
  await api("/api/me", {
    method: "PUT",
    body: JSON.stringify({ name: "Генерал", age: 2, color: "#397C63" }),
  });
  await api("/api/demo/capture", { method: "POST" });
  const key = "paws:browser-demo:v1", data = JSON.parse(s.getItem(key));
  data.wallets["demo-me"].balance = 1000000;
  s.setItem(key, JSON.stringify(data));
  const vertices = [
    { longitude: 20.46, latitude: 54.71 },
    { longitude: 20.4602, latitude: 54.71 },
    { longitude: 20.4602, latitude: 54.7102 },
    { longitude: 20.46, latitude: 54.7102 },
  ];
  let quote = await api("/api/purchases/quote", {
    method: "POST",
    body: JSON.stringify({ vertices }),
  });
  await api("/api/purchases", {
    method: "POST",
    body: JSON.stringify({
      vertices,
      maxCost: quote.cost,
      requestId: crypto.randomUUID(),
    }),
  });
  const before = (await api("/api/territories")).territories.length;
  const extended = vertices.map((p) => ({
    ...p,
    longitude: p.longitude + .0001,
  }));
  quote = await api("/api/purchases/quote", {
    method: "POST",
    body: JSON.stringify({ vertices: extended }),
  });
  assert.equal(quote.merged, true);
  assert.ok(quote.area < quote.selectedArea * .51);
  await api("/api/purchases", {
    method: "POST",
    body: JSON.stringify({
      vertices: extended,
      maxCost: quote.cost,
      requestId: crypto.randomUUID(),
    }),
  });
  assert.equal((await api("/api/territories")).territories.length, before);
});

test("демо: выкуп соседа начисляет 10% и повтор не платит второй раз", async () => {
  const s = storage(), api = createDemoApi(s, clipping);
  await api("/api/me", {
    method: "PUT",
    body: JSON.stringify({ name: "Рекс", age: 2, color: "#397C63" }),
  });
  await api("/api/wallet");
  const key = "paws:browser-demo:v1", data = JSON.parse(s.getItem(key));
  data.wallets["demo-me"].balance = 1000000;
  s.setItem(key, JSON.stringify(data));
  const vertices = [
    { longitude: 20.4522, latitude: 54.7104 },
    { longitude: 20.4524, latitude: 54.7104 },
    { longitude: 20.4524, latitude: 54.7106 },
    { longitude: 20.4522, latitude: 54.7106 },
  ];
  const quote = await api("/api/purchases/quote", {
    method: "POST",
    body: JSON.stringify({ vertices }),
  });
  assert.equal(quote.ownersCount, 1);
  assert.ok(quote.foreignArea > 0);
  const body = JSON.stringify({
    vertices,
    requestId: crypto.randomUUID(),
    maxCost: quote.cost,
  });
  const receipt = await api("/api/purchases", { method: "POST", body });
  assert.equal(receipt.reparations[0].amount, receipt.cost / 10);
  assert.deepEqual(
    await api("/api/purchases", { method: "POST", body }),
    receipt,
  );
  const saved = JSON.parse(s.getItem(key));
  assert.equal(saved.notifications.length, 1);
  assert.equal(saved.wallets["demo-neighbor"].balance, receipt.cost / 10);
  assert.ok(
    saved.notifications[0].message.startsWith("Рекс выкупил вашу территорию"),
  );
  assert.equal((await api("/api/notifications")).notifications.length, 0);
});

test("демо: физический демомаршрут не создаёт репараций", async () => {
  const s = storage(), api = createDemoApi(s, clipping);
  await api("/api/me", {
    method: "PUT",
    body: JSON.stringify({ name: "Рекс", age: 2, color: "#397C63" }),
  });
  await api("/api/demo/capture", { method: "POST" });
  assert.equal(
    JSON.parse(s.getItem("paws:browser-demo:v1")).notifications?.length ?? 0,
    0,
  );
});

test("клиент сохраняет признак окончательного аннулирования из ответа сервера", async () => {
  const client = createClient({
    location: { search: "" },
    fetch: async () =>
      Response.json({
        annulled: true,
        code: "SPEED_LIMIT",
        detail: "Ай яй яй, захват аннулирован, играй честно",
      }, { status: 422 }),
  });
  await assert.rejects(
    client.api("/api/capture", { method: "POST" }),
    (error) =>
      error.annulled === true && error.code === "SPEED_LIMIT" &&
      error.message.includes("захват аннулирован"),
  );
});
