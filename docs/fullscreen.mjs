// Полный экран внутри Mini App работает и в iOS/WebView без Fullscreen API.
// Смена размера Leaflet сохраняет центр, зум, GPS и точки покупки.
export function createMapFullscreen({ map, telegram, context }) {
  const wrap = document.querySelector(".map-wrap");
  const button = document.getElementById("map-fullscreen");
  const panel = document.getElementById("purchase-panel");
  const home = panel.parentNode;
  const next = panel.nextSibling;
  let active = false, scroll = 0;
  const back = telegram?.BackButton;
  const measure = () =>
    wrap.style.setProperty(
      "--purchase-panel-height",
      `${panel.getBoundingClientRect().height}px`,
    );
  if (window.ResizeObserver) new ResizeObserver(measure).observe(panel);

  function refresh() {
    const withPurchase = active && context().buying;
    if (withPurchase && panel.parentNode !== wrap) wrap.append(panel);
    if (!withPurchase && panel.parentNode !== home) {
      home.insertBefore(panel, next);
    }
    wrap.classList.toggle("with-purchase", withPurchase);
    measure();
  }
  function setActive(value) {
    if (value === active) return;
    active = value;
    if (active) scroll = window.scrollY;
    wrap.classList.toggle("map-fullscreen", active);
    document.body.classList.toggle("map-is-fullscreen", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute(
      "aria-label",
      active ? "Свернуть карту" : "Развернуть карту",
    );
    button.title = button.getAttribute("aria-label");
    button.querySelector(".expand-icon").hidden = active;
    button.querySelector(".collapse-icon").hidden = !active;
    if (active) {
      back?.onClick?.(close);
      back?.show?.();
    } else {
      back?.offClick?.(close);
      back?.hide?.();
    }
    refresh();
    requestAnimationFrame(() => {
      map.invalidateSize({ pan: true });
      if (!active) window.scrollTo(0, scroll);
    });
    button.focus({ preventScroll: true });
  }
  function close() {
    setActive(false);
  }
  button.addEventListener("click", () => setActive(!active));
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "Escape" && active && !document.querySelector("dialog[open]")
    ) {
      e.preventDefault();
      close();
    }
  });
  window.addEventListener("resize", () => {
    if (active) map.invalidateSize({ pan: true });
  });
  return { refresh, open: () => setActive(true) };
}
