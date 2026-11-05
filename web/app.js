import { goodFix, shouldAppend, meters, length } from "./tracking.mjs";
import { createLocationSource } from "./location.mjs";

// Telegram передаёт подписанную строку initData. Самостоятельно придуманному
// user.id сервер не верит: подпись проверяется в backend/auth.py.
const telegram = window.Telegram?.WebApp;
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
  walk: null,
  route: [],
  latest: null,
  watcher: null,
  generation: 0,
  starting: false,
  previewUrl: null,
  refreshId: 0,
  wake: null,
};
let map, territoriesLayer, routeLayer, startMarker, positionMarker;

async function api(path, options = {}) {
  const headers = {
    ...(telegram?.initData
      ? { Authorization: `tma ${telegram.initData}` }
      : {}),
    ...options.headers,
  };
  const response = await fetch(path, { ...options, headers });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Сервер вернул неожиданный ответ. Повторите подключение.");
  }
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Проверьте заполненные поля и GPS-данные.",
    );
  return data;
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
  img.src = pet.photo || "/static/assets/paw.svg";
  img.alt = pet.name;
  img.addEventListener("error", () => {
    if (!img.src.endsWith("/static/assets/paw.svg"))
      img.src = "/static/assets/paw.svg";
  });
  return img;
}
function render() {
  const walking = Boolean(state.walk);
  $("start-button").hidden = walking;
  $("start-button").disabled = state.busy || !state.connected;
  $("start-button").firstChild.textContent = state.starting
    ? "Подключаем GPS… "
    : state.pet
      ? "Начать захват "
      : "Создать профиль питомца ";
  $("capture-button").hidden = !walking;
  const fresh =
    state.latest && Date.now() / 1000 - state.latest.timestamp <= 15;
  $("capture-button").disabled =
    state.busy ||
    (state.walk?.demo
      ? state.route.length < state.config.demoRoute.length
      : !fresh || state.route.length < 4);
  $("cancel-button").hidden = !walking;
  $("cancel-button").disabled = state.busy;
  $("demo-button").hidden =
    !state.config?.demoMode || !state.pet || (walking && !state.walk.demo);
  $("demo-button").disabled =
    state.busy ||
    (state.walk?.demo && state.route.length >= state.config.demoRoute.length);
  $("demo-button").textContent = state.walk?.demo
    ? `Следующая точка · ${state.route.length}/${state.config.demoRoute.length}`
    : "Пройти демомаршрут";
  $("profile-button").disabled =
    !state.connected || walking || state.busy || state.starting;
  $("walk-stats").hidden = !walking;
  $("walk-title").textContent = walking
    ? "Идём за новыми открытиями"
    : state.pet
      ? `На прогулку, ${state.pet.name}?`
      : "Начнём знакомство?";
  $("distance").textContent = `${Math.round(length(state.route))} м`;
  $("gap").textContent =
    `${Math.round(state.route.length ? meters(state.route[0], state.route.at(-1)) : 0)} м`;
  $("accuracy").textContent = state.latest
    ? `±${Math.round(state.latest.accuracy)} м`
    : "—";
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
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
    maxZoom: 19,
    noWrap: true,
  }).addTo(map);
  tiles.on("tileerror", () => ($("map-warning").hidden = false));
  territoriesLayer = L.layerGroup().addTo(map);
  routeLayer = L.polyline([], { color: "#397C63", weight: 4 }).addTo(map);
  let timer;
  map.on("moveend", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.connected)
        refreshMap().catch(() =>
          message("Не удалось обновить карту. Проверьте соединение."),
        );
    }, 300);
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
  for (const territory of data.territories) {
    const pet = data.pets[territory.ownerId];
    if (!pet) continue;
    L.geoJSON(territory.geometry, {
      style: { color: pet.color, weight: 2, fillOpacity: 0.25 },
    })
      .on("click", () => showOwner(pet))
      .addTo(territoriesLayer);
    const icon = avatar(pet);
    icon.style.setProperty("--pet-color", pet.color);
    L.marker(territory.marker, {
      icon: L.divIcon({
        html: icon,
        className: "pet-marker",
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      }),
      title: pet.name,
    })
      .on("click", () => showOwner(pet))
      .addTo(territoriesLayer);
  }
  if (data.truncated)
    message(
      "В этой области больше 200 участков. Приблизьте карту, чтобы увидеть остальные.",
    );
}
async function refreshMe() {
  const data = await api("/api/me");
  state.pet = data.pet;
  $("area-label").textContent = state.pet
    ? `${Math.round(data.area).toLocaleString("ru-RU")} м² ваших открытий`
    : "Открывайте новые места";
  $("profile-button").replaceChildren(
    state.pet ? avatar(state.pet) : document.createTextNode("🐾"),
  );
  render();
}
async function boot() {
  $("retry-button").hidden = true;
  try {
    initMap();
    state.config = await api("/api/config");
    $("mode-banner").hidden = !state.config.demoMode;
    await refreshMe();
    state.connected = true;
    await refreshMap();
    message(
      state.config.demoMode
        ? "Это демо с общей тестовой базой. Попробуйте перезахватить участок Бублика без GPS."
        : "Обойдите участок и вернитесь к старту. Во время прогулки оставляйте мини-приложение открытым.",
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
  if (state.walk || state.busy || !state.connected) return;
  const p = state.pet;
  $("pet-name").value = p?.name || "";
  $("pet-age").value = p?.age ?? "";
  $("pet-description").value = p?.description || "";
  document
    .querySelectorAll("[name=color]")
    .forEach(
      (input) => (input.checked = input.value === (p?.color || "#397C63")),
    );
  $("photo-input").value = "";
  $("photo-preview").src = p?.photo || "/static/assets/paw.svg";
  $("profile-error").textContent = "";
  $("profile-dialog").showModal();
}
$("profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const photo = $("photo-input").files[0];
  if (photo && photo.size > 2 * 1024 * 1024) {
    $("profile-error").textContent = "Фото должно быть не больше 2 МБ.";
    return;
  }
  const data = new FormData(event.target);
  busy(true);
  $("profile-error").textContent = "";
  let saved = false;
  try {
    await api("/api/me", {
      method: "PUT",
      headers: json(),
      body: JSON.stringify({
        name: data.get("name"),
        age: Number(data.get("age")),
        description: data.get("description"),
        color: data.get("color"),
      }),
    });
    saved = true;
    if (photo) {
      const form = new FormData();
      form.append("file", photo);
      await api("/api/me/photo", { method: "POST", body: form });
    }
    await refreshMe();
    await refreshMap();
    $("profile-dialog").close();
    message("Профиль сохранён. Можно отправляться за новыми территориями!");
  } catch (error) {
    $("profile-error").textContent =
      (saved
        ? "Профиль уже сохранён, но не удалось завершить обновление: "
        : "") + error.message;
    if (saved) await refreshMe().catch(() => {});
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
function showOwner(pet) {
  $("owner-photo").src = pet.photo || "/static/assets/paw.svg";
  $("owner-photo").style.borderColor = pet.color;
  $("owner-name").textContent = `${pet.name} · ${pet.age} лет`;
  $("owner-description").textContent =
    pet.description || "Любит гулять и открывать новые места.";
  if (!$("owner-dialog").open) $("owner-dialog").showModal();
}

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
function drawRoute() {
  routeLayer
    .setStyle({ color: state.pet?.color || "#397C63" })
    .setLatLngs(state.route.map((p) => [p.latitude, p.longitude]));
  if (startMarker) {
    map.removeLayer(startMarker);
    startMarker = null;
  }
  if (state.route.length)
    startMarker = L.circleMarker(
      [state.route[0].latitude, state.route[0].longitude],
      {
        radius: 7,
        color: "#fff",
        weight: 3,
        fillColor: "#397C63",
        fillOpacity: 1,
      },
    )
      .bindTooltip("Старт")
      .addTo(map);
  render();
}
async function keepAwake() {
  try {
    state.wake = await navigator.wakeLock?.request("screen");
  } catch {
    /* WebView может не поддерживать Wake Lock. */
  }
}
function stopWalk({ notify = true } = {}) {
  state.generation++;
  state.starting = false;
  state.watcher?.();
  state.watcher = null;
  const walk = state.walk;
  state.walk = null;
  state.route = [];
  state.latest = null;
  if (walk && !walk.demo && notify)
    api(`/api/walks/${walk.id}`, { method: "DELETE", keepalive: true }).catch(
      () => {},
    );
  if (state.wake) state.wake.release().catch(() => {});
  state.wake = null;
  telegram?.disableClosingConfirmation?.();
  drawRoute();
}
function onPosition(position, generation) {
  if (generation !== state.generation || !state.walk) return;
  const p = positionSample(position);
  if (!goodFix(p) || Date.now() / 1000 - p.timestamp > 15) {
    state.latest = null;
    message("Слабый GPS. Выйдите на открытое место: нужна точность до 15 м.");
    render();
    return;
  }
  state.latest = p;
  if (shouldAppend(state.route.at(-1), p)) {
    if (state.route.length >= 5000) {
      stopWalk();
      message("Достигнут предел 5000 точек. Начните более короткую прогулку.");
      return;
    }
    state.route.push(p);
    drawRoute();
  }
  if (positionMarker) positionMarker.setLatLng([p.latitude, p.longitude]);
  else
    positionMarker = L.circleMarker([p.latitude, p.longitude], {
      radius: 6,
      color: "white",
      weight: 2,
      fillColor: "#527de0",
      fillOpacity: 1,
    }).addTo(map);
  if (state.route.length === 1) map.setView([p.latitude, p.longitude], 17);
  message(
    `Записываем прогулку · GPS ±${Math.round(p.accuracy)} м. Вернитесь к старту в пределах 5 м.`,
  );
  render();
}
async function startWalk() {
  if (state.busy || state.walk) return;
  if (!state.pet) {
    editProfile();
    return;
  }
  state.starting = true;
  busy(true);
  const generation = ++state.generation;
  try {
    const position = await currentPosition();
    if (generation !== state.generation) return;
    if (!goodFix(positionSample(position)))
      throw new Error(
        "GPS пока неточный. Выйдите на открытое место и повторите.",
      );
    const walk = await api("/api/walks", { method: "POST" });
    if (generation !== state.generation) {
      api(`/api/walks/${walk.id}`, { method: "DELETE" }).catch(() => {});
      return;
    }
    state.walk = walk;
    state.route = [];
    state.latest = null;
    if (position.timestamp / 1000 >= walk.startedAt - 5)
      onPosition(position, generation);
    telegram?.enableClosingConfirmation?.();
    void keepAwake();
    const cleanup = await locationSource.watchPosition(
      (p) => onPosition(p, generation),
      () => {
        if (generation !== state.generation) return;
        state.latest = null;
        message(
          "GPS временно недоступен. Если перерыв превысит 45 секунд, запись будет отменена.",
        );
        render();
      },
    );
    if (generation !== state.generation) cleanup();
    else state.watcher = cleanup;
  } catch (error) {
    if (generation === state.generation) {
      stopWalk();
      message(error.message);
    }
  } finally {
    state.starting = false;
    busy(false);
  }
}
function demoStep() {
  if (!state.config.demoMode || !state.pet || state.busy) return;
  if (!state.walk) {
    state.walk = { demo: true };
    state.route = [];
    state.latest = null;
    map.setView([54.7104, 20.4522], 16);
  }
  if (!state.walk.demo || state.route.length >= state.config.demoRoute.length)
    return;
  const [longitude, latitude] = state.config.demoRoute[state.route.length];
  const p = { longitude, latitude, accuracy: 3, timestamp: Date.now() / 1000 };
  state.route.push(p);
  state.latest = p;
  message(
    state.route.length === state.config.demoRoute.length
      ? "Демоконтур замкнут. Нажмите «Захватить территорию»."
      : "Нажимайте «Следующая точка», чтобы обойти демонстрационный участок.",
  );
  drawRoute();
}
async function capture() {
  if (state.busy || !state.walk) return;
  const walk = state.walk;
  busy(true);
  try {
    let points = state.route;
    if (!walk.demo) {
      if (!state.latest || Date.now() / 1000 - state.latest.timestamp > 15)
        throw new Error("Дождитесь свежего точного GPS.");
      if (state.latest.timestamp > points.at(-1).timestamp)
        points = [...points, state.latest];
    }
    const result = await api(walk.demo ? "/api/demo/capture" : "/api/capture", {
      method: "POST",
      ...(walk.demo
        ? {}
        : {
            headers: json(),
            body: JSON.stringify({ walk_id: walk.id, points }),
          }),
    });
    stopWalk({ notify: false });
    // Захват уже сохранён. Ошибка обновления карты не должна выглядеть как отказ захвата.
    message(
      `Территория ваша! Захвачено ${Math.round(result.area)} м². Нажмите на фото владельца на карте.`,
    );
    telegram?.HapticFeedback?.notificationOccurred("success");
    try {
      await refreshMe();
      await refreshMap();
    } catch {
      message(
        `Захват ${Math.round(result.area)} м² сохранён, но карта не обновилась. Перезапустите приложение.`,
      );
    }
  } catch (error) {
    message(error.message);
  } finally {
    busy(false);
  }
}

setInterval(() => {
  if (!state.walk || state.walk.demo || state.busy) return;
  const last = state.route.at(-1)?.timestamp ?? state.walk.startedAt;
  if (Date.now() / 1000 - last > 45) {
    stopWalk();
    message(
      "Прогулка отменена: точный GPS отсутствовал больше 45 секунд. Начните новую запись.",
    );
  } else render();
}, 1000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (state.walk || state.starting)) {
    stopWalk();
    message(
      "Запись прервана: мини-приложение ушло в фон. Начните новую прогулку.",
    );
  }
});
window.addEventListener("pagehide", () => {
  if (state.walk) stopWalk();
});
$("start-button").addEventListener("click", startWalk);
$("capture-button").addEventListener("click", capture);
$("demo-button").addEventListener("click", demoStep);
$("cancel-button").addEventListener("click", () => {
  if (
    window.confirm("Отменить прогулку? Незахваченный маршрут будет удалён.")
  ) {
    stopWalk();
    message("Прогулка отменена.");
  }
});
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
void boot();
