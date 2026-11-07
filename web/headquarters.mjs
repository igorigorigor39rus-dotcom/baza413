import { dogPortrait } from "./dog.mjs";
import { formatBones, fullBones } from "./numbers.mjs";
// Атлас остаётся одним изображением. ViewBox показывает отдельную комнату,
// персонаж и эффекты анимируются поверх неё как независимые 2D-слои.
const ART = new URL("./assets/hq/rooms-atlas.webp", import.meta.url).href;
const ROOMS = [
  [0, 0, 355, 399],
  [357, 0, 353, 399],
  [711, 0, 354, 399],
  [1066, 0, 353, 399],
  [1420, 0, 354, 399],
  [0, 444, 333, 397],
  [334, 444, 334, 397],
  [669, 444, 326, 397],
  [996, 444, 346, 397],
  [1343, 444, 431, 397],
];
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
export function createHeadquarters({ api, context, onWallet, onProfile }) {
  const $ = (id) => document.getElementById(id);
  let current = null, busy = false, request = null;
  function scene(level) {
    const ns = "http://www.w3.org/2000/svg",
      svg = document.createElementNS(ns, "svg");
    svg.classList.add("hq-room");
    svg.setAttribute("viewBox", ROOMS[level - 1].join(" "));
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Штаб ${level} уровня: ${NAMES[level - 1]}`);
    const image = document.createElementNS(ns, "image");
    image.setAttribute("href", ART);
    image.setAttribute("width", "1774");
    image.setAttribute("height", "887");
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
    const dog = dogPortrait(context().pet, { animated: true });
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
      s.pet.breedName ?? "Выберите породу в досье"
    }`;
    $("hq-balance").textContent = `В резерве: ${
      formatBones(current.balance)
    } 🦴`;
    $("hq-balance").title = `${fullBones(current.balance)} 🦴`;
    $("hq-upgrade").disabled = busy || level >= 10 || !current.affordable;
    $("hq-upgrade").textContent = level >= 10
      ? "Максимальный уровень"
      : `Улучшить · ${formatBones(current.nextCost)} 🦴`;
    $("hq-cost").textContent = level >= 10
      ? "Ваш штаб улучшен на 100%."
      : `Следующее улучшение: ${
        fullBones(current.nextCost)
      } 🦴. Цена каждого следующего перехода удваивается.`;
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
  $("close-hq").addEventListener("click", () => $("hq-dialog").close());
  $("hq-profile").addEventListener("click", () => {
    $("hq-dialog").close();
    onProfile();
  });
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
