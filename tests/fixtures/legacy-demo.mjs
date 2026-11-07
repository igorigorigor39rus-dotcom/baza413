import { dailyWallet } from "../../web/income.mjs";
import { meters } from "../../web/tracking.mjs";

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
          unlimitedPurchases: true,
          mergeOwnPurchases: true,
          foreignBuyouts: true,
          notifications: true,
          starShop: true,
          largestTerritory: true,
          geoChat: true,
          dailyIncome: true,
          incomePeriodSeconds: 86400,
          sqmPerBone: 10,
        },
      };
    }
    const data = load(), method = options.method ?? "GET";
    const requestUrl = new URL(path, "https://demo.invalid");
    const settleFor = (id) => {
      data.wallets ??= {};
      if (data.pet && data.wallet && !data.wallets[data.pet.id]) {
        data.wallets[data.pet.id] = data.wallet;
      }
      const rate = data.territories.filter((t) => t.ownerId === id).reduce(
        (sum, t) => sum + area(t.geometry),
        0,
      );
      let w = data.wallets[id] ??= {
        balance: 0,
        rate: rate / 10,
        pending: 0,
        incomeCycleAt: null,
        incomePeriodSeconds: 86400,
        asOf: Date.now() / 1000,
      };
      const now = Date.now() / 1000;
      // Старое демо переводим один раз, сохранив заработанный часовой доход.
      if (w.incomePeriodSeconds !== 86400) {
        w.balance += w.rate * Math.max(0, now - w.asOf) / 3600;
        w = {
          ...w,
          asOf: now,
          incomeCycleAt: rate > 0 ? now : null,
          pending: 0,
          incomePeriodSeconds: 86400,
        };
      }
      w = dailyWallet(w, rate, now);
      data.wallets[id] = w;
      return w;
    };
    if (path === "/api/wallet") {
      const w = settleFor(data.pet?.id ?? "demo-me");
      save(data);
      return w;
    }
    if (path === "/api/notifications") {
      const own = (data.notifications ?? []).filter((n) =>
        n.recipientId === data.pet?.id
      );
      return {
        unread: own.filter((n) => !n.read).length,
        notifications: own.slice(-50).reverse(),
      };
    }
    if (path === "/api/notifications/read") {
      const ids = JSON.parse(options.body).ids;
      for (const n of data.notifications ?? []) {
        if (n.recipientId === data.pet?.id && ids.includes(n.id)) n.read = true;
      }
      save(data);
      return { ok: true };
    }
    if (path === "/api/shop") {
      return {
        debt: 0,
        packages: [[100, 10000], [250, 30000], [500, 80000], [1000, 200000]]
          .map(([stars, bones]) => ({ id: String(stars), stars, bones })),
      };
    }
    if (path.endsWith("/largest-territory")) {
      const id = decodeURIComponent(path.split("/")[3]);
      const largest = data.territories.filter((t) =>
        t.ownerId === id
      ).sort((a, b) => area(b.geometry) - area(a.geometry))[0];
      return {
        territory: largest
          ? { ...largest, area: area(largest.geometry) }
          : null,
      };
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
      const polygon = { type: "MultiPolygon", coordinates: [[ring]] };
      if (!(area(polygon) > 0)) {
        throw new Error("Отметьте участок с положительной площадью.");
      }
      const owned = data.territories.filter((t) => t.ownerId === data.pet.id);
      const free = clipping.difference(
        polygon.coordinates,
        ...owned.map((t) => t.geometry.coordinates),
      );
      const sqm = area({ type: "MultiPolygon", coordinates: free }),
        cost = Math.ceil(sqm * 10);
      if (!(sqm > 0)) {
        throw new Error(
          "Выбранная земля уже принадлежит вам. Добавьте нейтральную или чужую землю.",
        );
      }
      let coordinates = polygon.coordinates;
      const mergeIds = new Set();
      let found = true;
      while (found) {
        found = false;
        for (const t of owned) {
          if (mergeIds.has(t.id)) continue;
          const union = clipping.union(coordinates, t.geometry.coordinates);
          const overlap = area({
            type: "MultiPolygon",
            coordinates: clipping.intersection(
              coordinates,
              t.geometry.coordinates,
            ),
          });
          if (
            overlap > 0 ||
            union.length < coordinates.length + t.geometry.coordinates.length
          ) {
            mergeIds.add(t.id);
            coordinates = union;
            found = true;
          }
        }
      }
      const combined = { type: "MultiPolygon", coordinates };
      const foreign = new Map();
      const intersections = [];
      for (
        const t of data.territories.filter((t) => t.ownerId !== data.pet.id)
      ) {
        const intersection = clipping.intersection(
          free,
          t.geometry.coordinates,
        );
        const size = area({ type: "MultiPolygon", coordinates: intersection });
        if (size > 0) {
          foreign.set(t.ownerId, (foreign.get(t.ownerId) ?? 0) + size);
          intersections.push(intersection);
        }
      }
      const neutralArea = area({
        type: "MultiPolygon",
        coordinates: clipping.difference(free, ...intersections),
      });
      const foreignArea = [...foreign.values()].reduce((sum, n) => sum + n, 0);
      const wallet = settleFor(data.pet.id);
      if (path === "/api/purchases/quote") {
        return {
          area: sqm,
          selectedArea: area(polygon),
          totalArea: area(combined),
          merged: mergeIds.size > 0,
          foreignArea,
          ownersCount: foreign.size,
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
      const reparations = [];
      data.notifications ??= [];
      for (const [id, size] of foreign) {
        const amount = cost * size / (foreignArea + neutralArea) / 10;
        settleFor(id).balance += amount;
        reparations.push({ ownerId: id, amount, area: size });
        data.notifications.push({
          id: crypto.randomUUID(),
          recipientId: id,
          amount: String(amount),
          read: false,
          createdAt: Date.now() / 1000,
          message:
            `${data.pet.name} выкупил вашу территорию, вам выплачены репарации в количестве ${amount} 🦴.`,
        });
      }
      const receipt = {
        id: crypto.randomUUID(),
        area: sqm,
        totalArea: area(combined),
        merged: mergeIds.size > 0,
        cost,
        requestId: b.requestId,
        reparations,
      };
      data.territories = data.territories.filter((t) => !mergeIds.has(t.id))
        .flatMap((t) => {
          if (t.ownerId === data.pet.id) return [t];
          const coordinates = clipping.difference(
            t.geometry.coordinates,
            polygon.coordinates,
          );
          return coordinates.length
            ? [{ ...t, geometry: { type: "MultiPolygon", coordinates } }]
            : [];
        });
      data.territories.push({
        id: receipt.id,
        ownerId: data.pet.id,
        geometry: combined,
      });
      wallet.rate = data.territories.filter((t) => t.ownerId === data.pet.id)
        .reduce((sum, t) => sum + area(t.geometry), 0) / 10;
      for (const id of foreign.keys()) {
        data.wallets[id].rate = data.territories.filter((t) => t.ownerId === id)
          .reduce((sum, t) => sum + area(t.geometry), 0) / 10;
      }
      data.purchases ??= {};
      data.purchases[b.requestId] = receipt;
      settleFor(data.pet.id);
      save(data);
      return receipt;
    }
    if (requestUrl.pathname === "/api/chat") {
      const body = method === "POST" ? JSON.parse(options.body) : {};
      const channel = method === "POST"
        ? (body.channel ?? "world")
        : (requestUrl.searchParams.get("channel") ?? "world");
      if (!["district", "city", "world"].includes(channel)) {
        throw new Error("Выберите Район, Город или Мир.");
      }
      const own = data.territories.filter((t) => t.ownerId === data.pet?.id)
        .sort((a, b) => area(b.geometry) - area(a.geometry));
      const sqm = own.reduce((s, t) => s + area(t.geometry), 0),
        radius = channel === "district" ? 2000 : 20000;
      const canRead = channel === "world" || own.length > 0,
        canPost = Boolean(data.pet) &&
          (channel === "world" ? sqm >= 1000000 : own.length > 0);
      const reason = !data.pet
        ? "Сначала создайте досье питомца."
        : !canRead
        ? "Для локального чата нужна своя территория. Можно читать Мир."
        : !canPost
        ? "Мир читают все. Для отправки сообщений нужно владеть минимум 1 000 000 м²."
        : null;
      if (method === "GET") {
        return {
          channel,
          canRead,
          canPost,
          reason,
          messages: (data.messages ?? []).filter((m) => {
            if ((m.channel ?? "world") !== channel || !canRead) return false;
            if (channel === "world") return true;
            const theirs = data.territories.filter((t) =>
              t.ownerId === m.pet.id
            ).sort((a, b) =>
              area(b.geometry) - area(a.geometry)
            )[0];
            if (!theirs) return false;
            const a = marker(own[0].geometry), b = marker(theirs.geometry);
            return meters({ latitude: a[0], longitude: a[1] }, {
              latitude: b[0],
              longitude: b[1],
            }) <= radius;
          }),
        };
      }
      if (!canPost) throw new Error(reason);
      const text = body.text?.trim();
      if (!text || text.length > 500) {
        throw new Error("Сообщение: от 1 до 500 символов.");
      }
      data.messages ??= [];
      const now = Date.now() / 1000;
      if (
        data.messages.filter((m) => m.pet?.id === data.pet.id).at(-1)
          ?.createdAt > now - 3
      ) throw new Error("Подождите 3 секунды.");
      data.messages.push({
        id: String(Date.now()),
        channel,
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
          .reduce((sum, t) => sum + area(t.geometry), 0) / 10;
      }
      for (const id of owners) settleFor(id);
      save(data);
      return { id: t.id, area: area(t.geometry) };
    }
    throw new Error(
      "Это локальное демо. Для настоящей GPS-прогулки откройте приложение через Telegram-бота.",
    );
  };
}
