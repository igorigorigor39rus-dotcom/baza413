import { photoSize } from "./tracking.mjs";
import { createLocationSource } from "./location.mjs";
import { createPurchasing } from "./purchasing.mjs";
import { createBreedPicker } from "./breeds.mjs";
import { dogPortrait } from "./dog.mjs";
import { createHeadquarters } from "./headquarters.mjs";
import { createChat } from "./chat.mjs";
import { formatDailyRate, payoutText } from "./income.mjs";
import { createShop } from "./shop.mjs";
import { createPresence } from "./presence.mjs";
import { createMapFullscreen } from "./fullscreen.mjs";
import { createNotifications } from "./notifications.mjs";
import { setBonesText } from "./numbers.mjs";
import { createClient } from "./client.mjs";
import {
  colorHue,
  colorSaturation,
  hueColor,
  paintPath,
} from "./appearance.mjs";
import { compressPhoto } from "./photo.mjs";

// Telegram передаёт подписанную строку initData. Самостоятельно придуманному
// user.id сервер не верит: подпись проверяется в Supabase Edge Function.
const telegram = window.Telegram?.WebApp;
const client = createClient({
  location: window.location,
  storage: {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  },
  clipping: window.polygonClipping,
  fetch: window.fetch.bind(window),
});
const PAW = new URL("./assets/paw.svg", import.meta.url).href;
const locationSource = createLocationSource({
  telegram,
  navigator,
  secureContext: window.isSecureContext,
});
telegram?.ready();
telegram?.expand();
const $ = (id) => document.getElementById(id);
const state = {
  config: null,
  pet: null,
  connected: false,
  busy: false,
  previewUrl: null,
  refreshId: 0,
  live: null,
  buying: false,
};
// До обновления сервера соблюдаем его прежний порог (15 м).
const maxAccuracy = () => state.config?.maxAccuracy ?? 15;
let map,
  territoriesLayer,
  liveRouteLayer;
let purchasing;
let fullscreen;
let notifications;
let shop, presence, ownerPet, focusedTerritory, headquarters;
const breedPicker = createBreedPicker();
const photoMarkers = [];
function photoIcon(pet) {
  const size = photoSize(map.getZoom()), image = avatar(pet);
  image.style.width = `${size}px`;
  image.style.height = `${size}px`;
  image.style.setProperty("--pet-color", pet.color);
  return L.divIcon({
    html: image,
    className: "pet-marker",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

async function api(path, options = {}) {
  const headers = {
    ...(telegram?.initData
      ? { Authorization: `tma ${telegram.initData}` }
      : {}),
    ...options.headers,
  };
  return client.api(path, { ...options, headers });
}
const json = (body) => ({ "Content-Type": "application/json" });
function message(text) {
  $("status").textContent = text;
}
function busy(value) {
  state.busy = value;
  document.body.classList.toggle("busy", value);
  render();
}
function avatar(pet) {
  const img = document.createElement("img");
  img.src = pet.photo || PAW;
  img.alt = pet.name;
  img.addEventListener("error", () => {
    if (img.src !== PAW) img.src = PAW;
  });
  return img;
}
function render() {
  $("goto-bot").disabled = state.busy || state.buying || !state.connected;
  $("live-panel").hidden = !state.live;
  const liveLast = state.live?.points.at(-1);
  $("live-capture").disabled = state.busy || Boolean(state.live?.error) ||
    !liveLast || Date.now() / 1000 - liveLast.timestamp > 15 ||
    state.live.points.length < 4;
  $("live-cancel").disabled = state.busy;
  $("profile-button").disabled = Boolean(state.live) || !state.connected ||
    state.busy;
  $("walk-title").textContent = state.pet
    ? `На прогулку, ${state.pet.name}?`
    : "Откроем личное дело?";
  purchasing?.refresh();
  fullscreen?.refresh();
  notifications?.render();
  shop?.render();
  presence?.render();
  headquarters?.render();
  $("show-my-territory").disabled = !state.pet ||
    !state.config?.features?.largestTerritory;
  $("show-owner-territory").disabled = !state.config?.features
    ?.largestTerritory;
}

function initMap() {
  if (map) return;
  map = L.map("map", {
    zoomControl: false,
    minZoom: 3,
    maxZoom: 19,
    maxBounds: [
      [-85, -180],
      [85, 180],
    ],
    maxBoundsViscosity: 1,
  }).setView([54.7104, 20.4522], 16);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  liveRouteLayer = L.polyline([], {
    color: "#8eb3df",
    weight: 4,
    dashArray: "6 4",
  }).addTo(map);
  map.on("zoomend", () => {
    for (const marker of photoMarkers) marker.setIcon(photoIcon(marker.agent));
  });
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
    maxZoom: 19,
    noWrap: true,
  }).addTo(map);
  tiles.on("tileerror", () => ($("map-warning").hidden = false));
  const relief = L.tileLayer("https://a.tile.opentopomap.org/{z}/{x}/{y}.png", {
    attribution:
      'Map data &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM | Map style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    maxNativeZoom: 17,
    maxZoom: 19,
  });
  let reliefErrors = 0;
  relief.on("tileerror", () => {
    if (++reliefErrors >= 3 && map.hasLayer(relief)) {
      map.removeLayer(relief);
      tiles.addTo(map);
      $("map-provider").value = "osm";
      message("Карта рельефа недоступна, оставлена OpenStreetMap.");
    }
  });
  $("map-provider").addEventListener("change", () => {
    reliefErrors = 0;
    if ($("map-provider").value === "relief") {
      map.removeLayer(tiles);
      relief.addTo(map);
    } else {
      map.removeLayer(relief);
      tiles.addTo(map);
    }
  });
  territoriesLayer = L.layerGroup().addTo(map);
  let timer;
  map.on("moveend", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.connected) {
        refreshMap().catch(() =>
          message("Не удалось обновить карту. Проверьте соединение.")
        );
      }
    }, 300);
  });
  purchasing = createPurchasing({
    map,
    api,
    context: () => state,
    onModeChange: (value) => {
      state.buying = value;
      render();
    },
    onPurchased: async () => {
      await refreshMap();
      await refreshMe();
      await refreshWallet();
    },
    message,
  });
  fullscreen = createMapFullscreen({ map, telegram, context: () => state });
  notifications = createNotifications({ api, context: () => state });
  shop = createShop({
    api,
    context: () => state,
    telegram,
    onPaid: refreshWallet,
    message,
  });
  presence = createPresence({ api, context: () => state });
  headquarters = createHeadquarters({
    api,
    context: () => state,
    onWallet: refreshWallet,
    onProfile: editProfile,
  });
  map.on("dragstart", () => {
    if (focusedTerritory) {
      map.removeLayer(focusedTerritory);
      focusedTerritory = null;
    }
  });
}
async function refreshMap() {
  const id = ++state.refreshId;
  const bounds = map.getBounds();
  const params = new URLSearchParams({
    west: Math.max(-180, bounds.getWest()),
    east: Math.min(180, bounds.getEast()),
    south: Math.max(-85, bounds.getSouth()),
    north: Math.min(85, bounds.getNorth()),
  });
  const data = await api(`/api/territories?${params}`);
  if (id !== state.refreshId) return;
  territoriesLayer.clearLayers();
  photoMarkers.length = 0;
  for (const territory of data.territories) {
    const pet = data.pets[territory.ownerId];
    if (!pet) continue;
    L.geoJSON(territory.geometry, {
      style: {
        color: pet.color,
        weight: 2,
        fillOpacity: Number(pet.opacity ?? .35),
      },
      onEachFeature: (_feature, layer) =>
        layer.on("add", () => paintPath(layer, pet)),
    })
      .on("click", () => {
        if (!state.buying) void showOwner(pet);
      })
      .addTo(territoriesLayer);
    const marker = L.marker(territory.marker, {
      icon: photoIcon(pet),
      title: pet.name,
    }).on("click", () => {
      if (!state.buying) void showOwner(pet);
    }).addTo(territoriesLayer);
    marker.agent = pet;
    photoMarkers.push(marker);
  }
  if (data.truncated) {
    message(
      "В этой области больше 200 участков. Приблизьте карту, чтобы увидеть остальные.",
    );
  }
}
async function refreshMe() {
  const data = await api("/api/me");
  state.pet = data.pet;
  $("area-label").textContent = state.pet
    ? `${Math.round(data.area).toLocaleString("ru-RU")} м² ваших открытий`
    : "Открывайте новые места";
  $("profile-button").replaceChildren(
    state.pet ? avatar(state.pet) : avatar({ name: "Досье" }),
  );
  render();
}
async function boot() {
  $("retry-button").hidden = true;
  try {
    initMap();
    if (!telegram?.initData) {
      message(
        "Откройте приложение через кнопку вашего Telegram-бота.",
      );
      state.connected = false;
      render();
      return;
    }
    state.config = await api("/api/config");
    $("closure-hint").textContent = `Замкните маршрут не дальше ${
      state.config.closureMeters ?? 15
    } м от старта. Точность GPS на старте и финише — не хуже ${maxAccuracy()} м. Пересечения трека ${
      state.config.features?.crossingRoutes
        ? "разрешены: захватывается площадь внутри внешних границ"
        : "станут доступны после обновления сервера"
    }. Гуляйте только там, где это разрешено.${
      state.config.features?.speedLimit
        ? " Средняя скорость — не выше 20 км/ч."
        : ""
    }`;
    $("server-notice").hidden = Boolean(
      state.config.features?.dossier && state.config.features?.chat &&
        state.config.features?.publicWallet &&
        state.config.features?.dailyIncome &&
        state.config.features?.geoChat && state.config.features?.liveOnly &&
        state.config.features?.headquarters && state.config.features?.breeds,
    );
    await refreshMe();
    state.connected = true;
    await refreshMap();
    void refreshWallet();
    void notifications.refresh();
    const liveState = await refreshLive();
    message(
      liveState?.result?.annulled
        ? liveState.result.detail
        : state.live
        ? "Фоновая прогулка восстановлена. Координаты поступают из трансляции Telegram."
        : "Обойдите участок и вернитесь к старту. Для записи маршрута включите трансляцию геопозиции в чате бота.",
    );
    render();
    if (!state.pet) editProfile();
  } catch (error) {
    state.connected = false;
    message(error.message);
    $("retry-button").hidden = false;
    render();
  }
}
function editProfile() {
  if (state.busy || !state.connected) return;
  const p = state.pet;
  breedPicker.set(p);
  $("pet-name").value = p?.name || "";
  $("pet-age").value = p?.age ?? "";
  $("pet-description").value = p?.description || "";
  $("pet-hue").value = p?.hue ?? colorHue(p?.color || "#397c63");
  $("pet-saturation").value = p?.saturation ??
    colorSaturation(p?.color || "#397c63");
  $("pet-opacity").value = p?.opacity ?? .35;
  $("pet-pattern").value = p?.pattern ?? "solid";
  // Предпросмотр доступен всегда, а сохранение узоров проверяется отдельно.
  for (
    const id of ["pet-hue", "pet-saturation", "pet-opacity", "pet-pattern"]
  ) {
    $(id).disabled = false;
    $(id).removeAttribute("title");
  }
  updatePreview();
  $("photo-input").value = "";
  $("photo-preview").src = p?.photo || PAW;
  $("profile-error").textContent = "";
  $("profile-territory-status").textContent = "";
  $("profile-dialog").showModal();
}
$("profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const photo = $("photo-input").files[0];
  const data = new FormData(event.target);
  busy(true);
  $("profile-error").textContent = "";
  let saved = false;
  try {
    if (!state.config?.features?.breeds) {
      throw new Error("Сохранение породы пока недоступно. Попробуйте позже.");
    }
    const compressed = photo ? await compressPhoto(photo) : null;
    await api("/api/me", {
      method: "PUT",
      headers: json(),
      body: JSON.stringify({
        ...breedPicker.value(),
        name: data.get("name"),
        age: Number(data.get("age")),
        description: data.get("description"),
        color: hueColor(
          Number(data.get("hue")),
          Number(data.get("saturation")),
        ),
        ...(!client.isPython &&
            (client.isDemo || state.config?.features?.dossier)
          ? {
            hue: Number(data.get("hue")),
            saturation: Number(data.get("saturation")),
            opacity: Number(data.get("opacity")),
            pattern: data.get("pattern"),
          }
          : {}),
      }),
    });
    saved = true;
    if (photo) {
      const form = new FormData();
      form.append("file", compressed, "pet.jpg");
      await api("/api/me/photo", { method: "POST", body: form });
    }
    await refreshMe();
    await refreshMap();
    void refreshWallet();
    $("profile-dialog").close();
    message(
      !client.isDemo && !state.config?.features?.dossier
        ? "Профиль и цвет сохранены. Для сохранения узора и плотности требуется обновление сервиса."
        : "Досье и оформление сохранены. Можно отправляться на прогулку.",
    );
  } catch (error) {
    $("profile-error").textContent = (saved
      ? "Профиль уже сохранён, но не удалось завершить обновление: "
      : "") + error.message;
    if (saved) {
      await refreshMe().catch(() => {});
    }
  } finally {
    busy(false);
  }
});
$("photo-input").addEventListener("change", () => {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  const photo = $("photo-input").files[0];
  if (photo) {
    state.previewUrl = URL.createObjectURL(photo);
    $("photo-preview").src = state.previewUrl;
  }
});

let ownerRequest = 0;
async function showOwner(pet) {
  ownerPet = pet;
  $("owner-territory-status").textContent = "";
  const request = ++ownerRequest;
  $("owner-photo").src = pet.photo || PAW;
  $("owner-photo").alt = pet.name;
  $("owner-photo").style.borderColor = pet.color;
  $("owner-name").textContent = `${pet.name} · ${pet.age} лет`;
  $("owner-breed").textContent = pet.breedName ?? "Порода пока не указана";
  $("owner-breed-icon").replaceChildren(dogPortrait(pet));
  $("owner-description").textContent = pet.description ||
    "Любит гулять и открывать новые места.";
  $("owner-bones").textContent = "🦴 Загружаем…";
  if (!$("owner-dialog").open) $("owner-dialog").showModal();
  try {
    const current = await api(`/api/pets/${encodeURIComponent(pet.id)}`);
    if (request !== ownerRequest || !$("owner-dialog").open) return;
    if (current.wallet) {
      setBonesText($("owner-bones"), current.wallet.balance, "🦴 ");
    } else $("owner-bones").textContent = "🦴 Данные пока недоступны";
  } catch {
    if (request === ownerRequest) {
      $("owner-bones").textContent = "🦴 Не удалось обновить";
    }
  }
}

// Запрашиваем крупнейший участок отдельно: его может не быть в текущем окне карты.
async function showLargestTerritory(pet, dialogId, statusId, buttonId) {
  const button = $(buttonId);
  button.disabled = true;
  $(statusId).textContent = "Ищем самый большой участок…";
  try {
    const { territory } = await api(
      `/api/pets/${encodeURIComponent(pet.id)}/largest-territory`,
    );
    if (!territory) {
      $(statusId).textContent = "У этого генерала пока нет территории.";
      return;
    }
    if (focusedTerritory) map.removeLayer(focusedTerritory);
    focusedTerritory = L.geoJSON(territory.geometry, {
      style: { color: pet.color, weight: 4, fillOpacity: .15 },
    }).addTo(map);
    $(dialogId).close();
    fullscreen.open();
    requestAnimationFrame(() =>
      map.fitBounds(focusedTerritory.getBounds(), {
        padding: [35, 65],
        maxZoom: 18,
      })
    );
    message(
      `Самый большой участок: ${pet.name} · ${
        Math.round(territory.area).toLocaleString("ru-RU")
      } м²`,
    );
  } catch (e) {
    $(statusId).textContent = e.message;
  } finally {
    button.disabled = false;
  }
}
$("show-my-territory").addEventListener("click", () => {
  if (state.pet) {
    void showLargestTerritory(
      state.pet,
      "profile-dialog",
      "profile-territory-status",
      "show-my-territory",
    );
  }
});
$("show-owner-territory").addEventListener("click", () => {
  if (ownerPet) {
    void showLargestTerritory(
      ownerPet,
      "owner-dialog",
      "owner-territory-status",
      "show-owner-territory",
    );
  }
});

function positionSample(position) {
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: position.coords.accuracy,
    timestamp: position.timestamp / 1000,
  };
}
function currentPosition() {
  return locationSource.getPosition();
}
$("profile-button").addEventListener("click", editProfile);
$("close-profile").addEventListener("click", () => $("profile-dialog").close());
$("close-owner").addEventListener("click", () => $("owner-dialog").close());
$("owner-done").addEventListener("click", () => $("owner-dialog").close());
$("retry-button").addEventListener("click", boot);
$("locate-button").addEventListener("click", async () => {
  try {
    const p = positionSample(await currentPosition());
    map.setView([p.latitude, p.longitude], 17);
  } catch (error) {
    message(error.message);
  }
});
$("income-rules").addEventListener(
  "click",
  () => $("rules-dialog").showModal(),
);
$("close-rules").addEventListener("click", () => $("rules-dialog").close());
void boot();

// Предпросмотр и единая маркировка всех участков владельца.
function chosenPaint() {
  return {
    hue: Number($("pet-hue").value),
    saturation: Number($("pet-saturation").value),
    opacity: Number($("pet-opacity").value),
    pattern: $("pet-pattern").value,
    color: hueColor($("pet-hue").value, $("pet-saturation").value),
  };
}
function updatePreview() {
  const pet = chosenPaint(),
    svg = $("paint-preview"),
    path = svg.querySelector(":scope > path");
  svg.querySelector("defs")?.remove();
  path.setAttribute("fill", pet.color);
  path.setAttribute("fill-opacity", pet.opacity);
  paintPath({ getElement: () => path }, pet);
  $("hue-value").textContent = `${pet.hue}°`;
}
for (const id of ["pet-hue", "pet-saturation", "pet-opacity", "pet-pattern"]) {
  $(id).addEventListener("input", updatePreview);
}
async function refreshWallet() {
  if (!state.connected || !state.pet || client.isPython) return;
  try {
    const w = await api("/api/wallet");
    setBonesText($("wallet-balance"), w.balance, "", " 🦴");
    headquarters?.walletChanged();
    if (w.incomePeriodSeconds === 86400) {
      $("wallet-rate").textContent = `${formatDailyRate(w.rate)} 🦴/сутки`;
      $("wallet-rate").title = "Доход за полные сутки при текущей площади";
      $("wallet-payout").textContent = payoutText(w);
    } else {
      $("wallet-rate").textContent =
        "Для суточного дохода обновите сервер до v.0.9";
      $("wallet-payout").textContent = "";
    }
  } catch {
    $("wallet-rate").textContent =
      "Доход недоступен: требуется обновление сервера";
  }
}
setInterval(() => {
  if (!document.hidden) void refreshWallet();
}, 30000);
createChat({ api, context: () => state, message });

// Состояние фонового режима хранится на сервере, отдельно от браузерного GPS.
let liveLoading = false, liveFittedId = null, shownAnnulment = null;
async function refreshLive() {
  if (
    !state.connected ||
    !state.config?.features?.liveTracking || liveLoading
  ) return;
  liveLoading = true;
  try {
    const data = await api("/api/live/status");
    const wasLive = Boolean(state.live);
    state.live = data.walk;
    if (data.result?.annulled && shownAnnulment !== data.result.walkId) {
      shownAnnulment = data.result.walkId;
      message(data.result.detail);
    }
    liveRouteLayer.setLatLngs(
      (data.walk?.points ?? []).map((p) => [p.latitude, p.longitude]),
    );
    if (state.live) {
      const points = state.live.points,
        last = points.at(-1),
        age = last ? Date.now() / 1000 - last.timestamp : Infinity;
      if (points.length && liveFittedId !== state.live.id) {
        liveFittedId = state.live.id;
        map.fitBounds(points.map((p) => [p.latitude, p.longitude]), {
          padding: [30, 30],
          maxZoom: 17,
        });
      }
      $("live-status").textContent = state.live.error ||
        (!last
          ? `Ждём трансляцию геопозиции с точностью ≤${maxAccuracy()} м.`
          : `Принято точек: ${points.length}. GPS ±${
            Math.round(last.accuracy)
          } м, ${Math.max(0, Math.round(age))} сек. назад. ${
            age > 15 ? "Для захвата дождитесь свежей точки." : ""
          }`);
    }
    // Захват командой в чате бота тоже должен обновлять открытую карту.
    if (wasLive && !state.live) {
      await refreshMap();
      await refreshMe();
      await refreshWallet();
    }
    render();
    return data;
  } catch (e) {
    $("live-status").textContent = e.message;
  } finally {
    liveLoading = false;
  }
}
$("goto-bot").addEventListener("click", async () => {
  if (state.busy) return;
  if (!state.pet) {
    editProfile();
    return;
  }
  busy(true);
  try {
    await api("/api/live/instructions", { method: "POST" });
    message("В чате бота: 📎 → Геопозиция → Транслировать геопозицию.");
    telegram?.close?.();
  } catch (e) {
    message(e.message);
  } finally {
    busy(false);
  }
});
$("live-open-chat").addEventListener("click", () => {
  if (telegram?.close) telegram.close();
  else message("Вернитесь в личный чат бота и включите трансляцию геопозиции.");
});
$("live-capture").addEventListener("click", async () => {
  if (state.busy || !state.live) return;
  busy(true);
  try {
    const result = await api("/api/live/capture", { method: "POST" });
    message(
      `Захвачено ${
        Math.round(result.area)
      } м². Остановите трансляцию геопозиции Telegram.`,
    );
    await refreshLive();
  } catch (e) {
    if (e.annulled) await refreshLive();
    message(e.message);
  } finally {
    busy(false);
  }
});
$("live-cancel").addEventListener("click", async () => {
  if (
    state.busy || !state.live ||
    !confirm("Отменить фоновую прогулку и удалить её точки?")
  ) return;
  busy(true);
  try {
    await api("/api/live/cancel", { method: "POST" });
    await refreshLive();
    message("Фоновая запись отменена. Остановите трансляцию в Telegram.");
  } catch (e) {
    message(e.message);
  } finally {
    busy(false);
  }
});
setInterval(() => {
  if (!document.hidden) void refreshLive();
}, 10000);
let rankingRequest = 0;
async function loadTop(sort = "bones") {
  if (!state.connected) {
    message("Откройте приложение через кнопку карты в Telegram-боте.");
    return;
  }
  if (!$("top-dialog").open) $("top-dialog").showModal();
  const request = ++rankingRequest;
  $("top-bones").setAttribute("aria-selected", String(sort === "bones"));
  $("top-area").setAttribute("aria-selected", String(sort === "area"));
  $("top-score").textContent = sort === "area" ? "м²" : "🦴";
  $("top-description").textContent = sort === "area"
    ? "По площади всех территорий, которыми Генерал владеет сейчас."
    : "По текущему балансу 🦴, включая начисления вне приложения.";
  $("top-error").textContent = "Загружаем рейтинг…";
  $("top-body").replaceChildren();
  try {
    const data = await api(sort === "area" ? "/api/top?sort=area" : "/api/top");
    if (request !== rankingRequest) return;
    let rank = 0;
    for (const entry of data.agents) {
      const row = document.createElement("tr"),
        place = document.createElement("td"),
        name = document.createElement("td"),
        score = document.createElement("td"),
        button = document.createElement("button"),
        photo = document.createElement("button");
      place.textContent = String(++rank);
      button.textContent = entry.pet.name;
      button.className = "text-button";
      button.addEventListener("click", () => {
        $("top-dialog").close();
        void showOwner(entry.pet);
      });
      photo.className = "photo-button ranking-photo";
      photo.type = "button";
      photo.setAttribute("aria-label", `Увеличить фото: ${entry.pet.name}`);
      photo.append(avatar(entry.pet));
      photo.addEventListener(
        "click",
        () => showPhoto(entry.pet.photo || PAW, entry.pet.name),
      );
      const agent = document.createElement("div");
      agent.className = "ranking-agent";
      agent.append(photo, button);
      name.append(agent);
      if (sort === "area") {
        score.textContent = Number(entry.area).toLocaleString("ru-RU", {
          maximumFractionDigits: 2,
        });
      } else setBonesText(score, entry.wallet.balance);
      row.append(place, name, score);
      $("top-body").append(row);
    }
    $("top-error").textContent = data.agents.length
      ? ""
      : "Пока нет Генералов.";
  } catch (e) {
    if (request === rankingRequest) $("top-error").textContent = e.message;
  }
}
$("open-top").addEventListener("click", () => void loadTop());
$("top-bones").addEventListener("click", () => void loadTop("bones"));
$("top-area").addEventListener("click", () => void loadTop("area"));
$("close-top").addEventListener("click", () => $("top-dialog").close());

function showPhoto(src, name) {
  $("large-photo").src = src;
  $("large-photo").alt = name;
  $("photo-title").textContent = name;
  $("photo-dialog").showModal();
}
$("enlarge-owner-photo").addEventListener(
  "click",
  () => showPhoto($("owner-photo").src, $("owner-photo").alt),
);
$("close-photo").addEventListener("click", () => $("photo-dialog").close());

function fitChat() {
  if ($("chat-dialog").open) {
    $("chat-dialog").style.height = `${
      window.visualViewport?.height ?? innerHeight
    }px`;
  }
}
window.visualViewport?.addEventListener("resize", fitChat);
$("open-chat").addEventListener("click", fitChat);
