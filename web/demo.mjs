import { meters } from "./tracking.mjs";

// Полностью локальное демо. Оно не обращается к Supabase и не выдаёт фиктивные
// координаты за настоящую прогулку. Отличается от общей серверной карты.
export const DEMO_ROUTE = [
  [20.451, 54.7100],
  [20.453, 54.7100],
  [20.453, 54.7110],
  [20.451, 54.7110],
  [20.451, 54.7100],
];
const KEY = "paws:browser-demo:v1";
const neighbor = {
  id: "demo-neighbor",
  name: "Бублик",
  age: 3,
  description: "Вымышленный сосед для демонстрации перезахвата.",
  color: "#E9A33B",
  photo: null,
};
const seed = () => ({
  version: 1,
  pet: null,
  territories: [{
    id: "neighbor-land",
    ownerId: neighbor.id,
    geometry: {
      type: "MultiPolygon",
      coordinates: [[[[20.452, 54.7103], [20.454, 54.7103], [20.454, 54.7113], [
        20.452,
        54.7113,
      ], [20.452, 54.7103]]]],
    },
  }],
});
function ringArea(ring) {
  const latitude = ring.reduce((s, p) => s + p[1], 0) / ring.length * Math.PI /
    180;
  const scale = 6371008.8 * Math.PI / 180;
  const local = ring.map((
    [x, y],
  ) => [
    (x - ring[0][0]) * scale * Math.cos(latitude),
    (y - ring[0][1]) * scale,
  ]);
  return Math.abs(
    local.reduce((s, p, i) => {
      const q = local[(i + 1) % local.length];
      return s + p[0] * q[1] - q[0] * p[1];
    }, 0) / 2,
  );
}
const area = (geometry) =>
  geometry.coordinates.reduce(
    (sum, rings) =>
      sum + ringArea(rings[0]) -
      rings.slice(1).reduce((s, r) => s + ringArea(r), 0),
    0,
  );
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (
      (a[1] > y) !== (b[1] > y) &&
      x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]
    ) inside = !inside;
  }
  return inside;
}
function marker(geometry) {
  for (const rings of geometry.coordinates) {
    const xs = rings[0].map((p) => p[0]), ys = rings[0].map((p) => p[1]);
    for (let i = 1; i < 20; i++) {
      for (let j = 1; j < 20; j++) {
        const p = [
          Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * i / 20,
          Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * j / 20,
        ];
        if (
          inRing(p, rings[0]) && !rings.slice(1).some((r) => inRing(p, r))
        ) return [p[1], p[0]];
      }
    }
  }
  const [x, y] = geometry.coordinates[0][0][0];
  return [y, x];
}
export function createDemoApi(storage, clipping) {
  function load() {
    const raw = storage.getItem(KEY);
    if (!raw) return seed();
    try {
      const data = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.territories)) {
        throw new Error();
      }
      return data;
    } catch {
      throw new Error(
        "Не удалось прочитать локальное демо. Очистите данные этого сайта, чтобы начать заново.",
      );
    }
  }
  function save(data) {
    try {
      storage.setItem(KEY, JSON.stringify(data));
    } catch {
      throw new Error(
        "Не удалось сохранить демо на устройстве. Проверьте свободное место и доступность localStorage.",
      );
    }
  }
  const me = (data) => ({
    pet: data.pet,
    area: data.territories.filter((t) => t.ownerId === data.pet?.id).reduce(
      (s, t) => s + area(t.geometry),
      0,
    ),
  });
  return async function demoApi(path, options = {}) {
    if (path === "/api/config") {
      return {
        demoMode: true,
        localDemo: true,
        demoRoute: DEMO_ROUTE,
        closureMeters: 20,
        maxAccuracy: 20,
        features: {
          crossingRoutes: true,
          purchases: true,
          purchasePrice: 10,
          territoryLeaderboard: true,
        },
      };
    }
    const data = load(), method = options.method ?? "GET";
    const settleFor = (id) => {
      data.wallets ??= {};
      if (data.pet && data.wallet && !data.wallets[data.pet.id]) {
        data.wallets[data.pet.id] = data.wallet;
      }
      const rate = data.territories.filter((t) => t.ownerId === id).reduce(
        (sum, t) => sum + area(t.geometry),
        0,
      );
      const w = data.wallets[id] ??= {
        balance: 0,
        rate,
        asOf: Date.now() / 1000,
      };
      const now = Date.now() / 1000;
      w.balance += w.rate * Math.max(0, now - w.asOf) / 3600;
      w.asOf = now;
      w.rate = rate;
      return w;
    };
    if (path === "/api/wallet") {
      const w = settleFor(data.pet?.id ?? "demo-me");
      save(data);
      return w;
    }
    if (path.startsWith("/api/pets/")) {
      const id = decodeURIComponent(path.split("/").at(-1)),
        pet = id === neighbor.id
          ? neighbor
          : data.pet?.id === id
          ? data.pet
          : null;
      if (!pet) throw new Error("Досье не найдено.");
      const wallet = settleFor(id);
      save(data);
      return { ...pet, wallet };
    }
    if (path === "/api/top" || path === "/api/top?sort=area") {
      const pets = [neighbor, ...(data.pet ? [data.pet] : [])];
      const agents = pets.map((pet) => ({
        pet,
        wallet: settleFor(pet.id),
        area: data.territories.filter((t) => t.ownerId === pet.id).reduce(
          (sum, t) => sum + area(t.geometry),
          0,
        ),
      }))
        .sort((a, b) =>
          (path.includes("sort=area")
            ? b.area - a.area
            : b.wallet.balance - a.wallet.balance) ||
          a.pet.id.localeCompare(b.pet.id)
        ).slice(0, 10);
      save(data);
      return { agents };
    }
    if (path === "/api/purchases/quote" || path === "/api/purchases") {
      if (!data.pet) throw new Error("Сначала создайте досье.");
      const b = JSON.parse(options.body);
      if (path === "/api/purchases" && data.purchases?.[b.requestId]) {
        return data.purchases[b.requestId];
      }
      if (
        !Array.isArray(b.vertices) || b.vertices.length < 3 ||
        b.vertices.length > 100 ||
        b.vertices.some((p) =>
          !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) ||
          Math.abs(p.latitude) > 85 || Math.abs(p.longitude) > 180
        )
      ) throw new Error("Отметьте от 3 до 100 точек участка.");
      const ring = b.vertices.map((p) => [p.longitude, p.latitude]);
      ring.push(ring[0]);
      const polygon = { type: "MultiPolygon", coordinates: [[ring]] },
        sqm = area(polygon),
        cost = Math.ceil(sqm * 10);
      if (sqm < 25 || sqm > 10000000) {
        throw new Error("Площадь покупки должна быть от 25 м² до 10 км².");
      }
      if (
        data.territories.some((t) =>
          area({
            type: "MultiPolygon",
            coordinates: clipping.intersection(t.geometry.coordinates, [ring]),
          }) > .000001
        )
      ) throw new Error("Покупать можно только свободную территорию.");
      const wallet = settleFor(data.pet.id);
      if (path === "/api/purchases/quote") {
        return {
          area: sqm,
          cost,
          price: 10,
          balance: wallet.balance,
          affordable: wallet.balance >= cost,
        };
      }
      if (
        typeof b.requestId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(b.requestId) || b.maxCost < cost
      ) throw new Error("Повторите расчёт покупки.");
      if (wallet.balance < cost) throw new Error("Недостаточно косточек.");
      wallet.balance -= cost;
      const receipt = {
        id: crypto.randomUUID(),
        area: sqm,
        cost,
        requestId: b.requestId,
      };
      data.territories.push({
        id: receipt.id,
        ownerId: data.pet.id,
        geometry: polygon,
      });
      wallet.rate += sqm;
      data.purchases ??= {};
      data.purchases[b.requestId] = receipt;
      save(data);
      return receipt;
    }
    if (path === "/api/chat" && method === "GET") {
      return { messages: data.messages ?? [] };
    }
    if (path === "/api/chat" && method === "POST") {
      if (!data.pet) throw new Error("Сначала создайте досье.");
      const text = JSON.parse(options.body).text?.trim();
      if (!text || text.length > 500) {
        throw new Error("Сообщение: от 1 до 500 символов.");
      }
      data.messages ??= [];
      const now = Date.now() / 1000;
      if (data.messages.at(-1)?.createdAt > now - 3) {
        throw new Error("Подождите 3 секунды.");
      }
      data.messages.push({
        id: String(Date.now()),
        text,
        createdAt: now,
        pet: data.pet,
      });
      data.messages = data.messages.slice(-100);
      save(data);
      return { ok: true };
    }
    if (path === "/api/me" && method === "GET") return me(data);
    if (path === "/api/me" && method === "PUT") {
      const b = JSON.parse(options.body);
      if (
        typeof b.name !== "string" || !b.name.trim() || b.name.length > 40 ||
        !Number.isFinite(b.age) || b.age < 0 || b.age > 35 ||
        !/^#[0-9a-f]{6}$/i.test(b.color)
      ) throw new Error("Проверьте профиль питомца.");
      data.pet = { ...b, id: "demo-me", photo: data.pet?.photo ?? null };
      save(data);
      return me(data);
    }
    if (path === "/api/me/photo" && method === "POST") {
      if (!data.pet) throw new Error("Сначала сохраните профиль.");
      const file = options.body.get("file");
      if (!(file instanceof Blob) || file.size > 1_000_000) {
        throw new Error("Фото должно быть до 1 МБ.");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      data.pet.photo = `data:image/jpeg;base64,${btoa(binary)}`;
      save(data);
      return me(data);
    }
    if (path.startsWith("/api/territories")) {
      return {
        territories: data.territories.map((t) => ({
          ...t,
          area: area(t.geometry),
          marker: marker(t.geometry),
        })),
        pets: {
          [neighbor.id]: neighbor,
          ...(data.pet ? { [data.pet.id]: data.pet } : {}),
        },
        truncated: false,
      };
    }
    if (path === "/api/demo/capture" && method === "POST") {
      if (!data.pet) throw new Error("Сначала создайте профиль.");
      if (!clipping) {
        throw new Error(
          "Не загрузилась библиотека демо. Перезагрузите страницу.",
        );
      }
      const owners = new Set([
        data.pet.id,
        ...data.territories.map((t) => t.ownerId),
      ]);
      for (const id of owners) settleFor(id);
      const coordinates = [[DEMO_ROUTE]];
      const remaining = data.territories.flatMap((t) => {
        const rest = clipping.difference(t.geometry.coordinates, coordinates);
        return rest.length
          ? [{ ...t, geometry: { type: "MultiPolygon", coordinates: rest } }]
          : [];
      });
      const t = {
        id: crypto.randomUUID(),
        ownerId: data.pet.id,
        geometry: { type: "MultiPolygon", coordinates },
      };
      data.territories = [...remaining, t];
      for (const id of owners) {
        data.wallets[id].rate = data.territories.filter((t) => t.ownerId === id)
          .reduce((sum, t) => sum + area(t.geometry), 0);
      }
      save(data);
      return { id: t.id, area: area(t.geometry) };
    }
    throw new Error(
      "Это локальное демо. Для настоящей GPS-прогулки откройте приложение через Telegram-бота.",
    );
  };
}
