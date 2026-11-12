import { headquartersPet } from "./hq-pet.mjs?v=1.1.4";
import { formatBones, fullBones } from "./numbers.mjs?v=1.1.4";
// Фон, персонаж и свет остаются независимыми слоями сцены.
// Каждый уровень — отдельный большой фон, без увеличения миниатюры атласа.
const ROOMS = [
  "./assets/hq/level-01.webp?v=1.1.4",
  "./assets/hq/level-02.webp?v=1.1.4",
  "./assets/hq/level-03.webp?v=1.1.4",
  "./assets/hq/level-04.webp?v=1.1.4",
  "./assets/hq/level-05.webp?v=1.1.4",
  "./assets/hq/level-06.webp?v=1.1.4",
  "./assets/hq/level-07.webp?v=1.1.4",
  "./assets/hq/level-08.webp?v=1.1.4",
  "./assets/hq/level-09.webp?v=1.1.4",
  "./assets/hq/level-10.webp?v=1.1.4",
].map((path) => new URL(path, import.meta.url).href);
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
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
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
    const image = document.createElement("img");
    image.className = "hq-room";
    image.alt = `Штаб ${level} уровня: ${NAMES[level - 1]}`;
    image.src = ROOMS[level - 1];
    image.decoding = "async";
    $("hq-scene").replaceChildren(image);
    const dog = headquartersPet(context().pet);
    dog.classList.add("hq-pet");
    dog.setAttribute("role", "button");
    dog.setAttribute("tabindex", "0");
    dog.setAttribute("aria-label", "Погладить питомца");
    const pat = () => {
      if (reducedMotion.matches) return;
      dog.classList.remove("is-petted");
      void dog.getBoundingClientRect();
      dog.classList.add("is-petted");
    };
    dog.addEventListener("click", pat);
    dog.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pat();
      }
    });
    dog.addEventListener("animationend", (e) => {
      if (e.animationName === "hq-pet-pat") dog.classList.remove("is-petted");
    });
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
