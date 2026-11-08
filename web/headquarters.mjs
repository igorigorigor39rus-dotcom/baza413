import { headquartersPet } from "./hq-pet.mjs";
import { formatBones, fullBones } from "./numbers.mjs";
// Атлас остаётся одним изображением. ViewBox показывает отдельную комнату,
// персонаж и эффекты анимируются поверх неё как независимые 2D-слои.
const ART = new URL("./assets/hq/bunker-atlas.webp", import.meta.url).href;
const ROOMS = Array.from({ length: 10 }, (_, i) => [
  2 + (i % 2) * 529,
  2 + Math.floor(i / 2) * 297.4,
  525,
  293.4,
]);
const NAMES = [
  "Бетонный угол",
  "Первые удобства",
  "Своя территория",
  "Тёплая казарма",
  "Офицерский комфорт",
  "Надёжный бункер",
  "Командный пункт",
  "Элитный штаб",
  "Генеральские покои",
  "Легендарный штаб",
];
export const upgradeCost = (level) =>
  level < 10 ? 100000 * 2 ** (level - 1) : null;
export function createHeadquarters(
  { api, context, onWallet, onProfile, telegram },
) {
  const $ = (id) => document.getElementById(id);
  let current = null, busy = false, request = null, sceneKey = "";
  let ownFullscreen = false,
    ownOrientation = false,
    ownTelegramFullscreen = false;
  const back = telegram?.BackButton;
  let backWasVisible = false;
  async function enterNative() {
    try {
      if (telegram?.isVersionAtLeast?.("8.0") && !telegram.isFullscreen) {
        telegram.requestFullscreen?.();
        ownTelegramFullscreen = true;
      } else if (
        !document.fullscreenElement && $("hq-dialog").requestFullscreen
      ) {
        await $("hq-dialog").requestFullscreen();
        ownFullscreen = true;
      }
    } catch {}
    try {
      if (screen.orientation?.lock) {
        await screen.orientation.lock("landscape");
        ownOrientation = true;
      }
    } catch {}
    if (!$("hq-dialog").open) await leaveNative();
  }
  async function leaveNative() {
    if (ownTelegramFullscreen) {
      try {
        telegram?.exitFullscreen?.();
      } catch {}
    }
    ownTelegramFullscreen = false;
    if (ownOrientation) {
      screen.orientation?.unlock?.();
      ownOrientation = false;
    }
    if (ownFullscreen && document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {}
    }
    ownFullscreen = false;
  }
  function close() {
    if ($("hq-dialog").open) $("hq-dialog").close();
  }
  $("hq-dialog").addEventListener("close", () => {
    document.body.classList.remove("hq-is-open");
    back?.offClick?.(close);
    if (!backWasVisible) back?.hide?.();
    void leaveNative();
  });
  function scene(level) {
    const key =
      `${level}:${context().pet?.breedId}:${context().pet?.breedName}`;
    if (key === sceneKey) return;
    sceneKey = key;
    const ns = "http://www.w3.org/2000/svg",
      svg = document.createElementNS(ns, "svg");
    svg.classList.add("hq-room");
    svg.setAttribute("viewBox", ROOMS[level - 1].join(" "));
    svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Штаб ${level} уровня: ${NAMES[level - 1]}`);
    const image = document.createElementNS(ns, "image");
    image.setAttribute("href", ART);
    image.setAttribute("width", "1058");
    image.setAttribute("height", "1487");
    // Отсекаем соседние комнаты, в том числе при несовпадении пропорций окна.
    const clip = document.createElementNS(ns, "clipPath");
    clip.id = "hq-room-clip";
    const rect = document.createElementNS(ns, "rect");
    ["x", "y", "width", "height"].forEach((name, i) =>
      rect.setAttribute(name, ROOMS[level - 1][i])
    );
    clip.append(rect);
    image.setAttribute("clip-path", "url(#hq-room-clip)");
    svg.append(clip, image);
    $("hq-scene").replaceChildren(svg);
    const dog = headquartersPet(context().pet);
    dog.classList.add("hq-pet");
    $("hq-scene").append(dog);
    if (level >= 4) {
      const glow = document.createElement("div");
      glow.className = "hq-glow";
      glow.setAttribute("aria-hidden", "true");
      $("hq-scene").append(glow);
    }
  }
  function render() {
    if (!current) return;
    const s = context();
    const level = current.level;
    $("hq-level").textContent = `Уровень ${level} / 10 · ${NAMES[level - 1]}`;
    const progress = Math.round(current.progress);
    $("hq-progress").value = current.progress;
    $("hq-percent").textContent = `${progress}%`;
    $("hq-pet-name").textContent = `${s.pet.name} · ${
      s.pet.breedName ?? "Метис"
    }`;
    $("hq-balance").textContent = `🦴 ${formatBones(current.balance)}`;
    $("hq-balance").title = `${fullBones(current.balance)} 🦴`;
    $("hq-upgrade").disabled = busy || level >= 10 || !current.affordable;
    $("hq-upgrade").textContent = level >= 10
      ? "Максимальный уровень"
      : `Улучшить · ${formatBones(current.nextCost)} 🦴`;
    $("hq-upgrade").title = level >= 10
      ? "Максимальный уровень"
      : `${fullBones(current.nextCost)} 🦴`;
    scene(level);
  }
  async function refresh() {
    current = await api("/api/hq");
    render();
  }
  $("open-hq").addEventListener("click", async () => {
    if (!context().pet) {
      onProfile();
      return;
    }
    $("hq-dialog").showModal();
    document.body.classList.add("hq-is-open");
    backWasVisible = Boolean(back?.isVisible);
    back?.onClick?.(close);
    back?.show?.();
    void enterNative();
    $("hq-status").textContent = "Загружаем штаб…";
    $("hq-upgrade").disabled = true;
    if (!context().config?.features?.headquarters) {
      $("hq-status").textContent = "Штаб пока недоступен. Попробуйте позже.";
      return;
    }
    try {
      await refresh();
      $("hq-status").textContent = "";
    } catch (e) {
      $("hq-status").textContent = e.message;
    }
  });
  $("close-hq").addEventListener("click", close);
  $("hq-upgrade").addEventListener("click", async () => {
    if (busy || !current || current.level >= 10) return;
    const level = current.level, cost = current.nextCost;
    if (
      !window.confirm(
        `Улучшить штаб до уровня ${level + 1} за ${fullBones(cost)} 🦴?`,
      )
    ) return;
    busy = true;
    request ??= crypto.randomUUID();
    $("hq-status").textContent = "Улучшаем штаб…";
    render();
    try {
      const result = await api("/api/hq/upgrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: request, expectedLevel: level }),
      });
      request = null;
      current = result.headquarters;
      render();
      $("hq-status").textContent = `Штаб улучшен до уровня ${current.level}!`;
      const success = $("hq-status").textContent;
      setTimeout(() => {
        if ($("hq-status").textContent === success) {
          $("hq-status").textContent = "";
        }
      }, 3000);
      await onWallet();
    } catch (e) {
      $("hq-status").textContent = e.message;
      try {
        const before = current.level;
        await refresh();
        if (current.level !== before) request = null;
      } catch {}
    } finally {
      busy = false;
      render();
    }
  });
  return {
    walletChanged: () => {
      if ($("hq-dialog").open && !busy) void refresh().catch(() => {});
    },
    render: () => {
      $("open-hq").disabled = !context().connected || context().busy;
      if ($("hq-dialog").open && current) render();
    },
  };
}
