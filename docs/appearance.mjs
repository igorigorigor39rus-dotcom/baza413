const CAMO_IMAGE = new URL("./assets/military-camo.png?v=0.5.0", import.meta.url).href;
const svgIds = new WeakMap();
let svgSequence = 0;
export function hueColor(hue, saturation = 55) {
  const h = ((Number(hue) % 360) + 360) % 360,
    s = Number(saturation) / 100,
    l = .45;
  return "#" + [0, 8, 4].map((n) => {
    const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16).padStart(2, "0");
  }).join("");
}
export function colorHue(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi)?.map((x) => parseInt(x, 16) / 255);
  if (!rgb || rgb.length !== 3) return 150;
  const [r, g, b] = rgb,
    hi = Math.max(...rgb),
    lo = Math.min(...rgb),
    d = hi - lo;
  if (!d) return 0;
  return Math.round(
    ((hi === r ? (g - b) / d : hi === g ? (b - r) / d + 2 : (r - g) / d + 4) *
        60 + 360) % 360,
  ) % 360;
}
export function paintPath(layer, pet) {
  const element = layer.getElement?.();
  if (!element || !["stripes", "grid", "camo"].includes(pet.pattern)) return;
  const svg = element.ownerSVGElement, ns = "http://www.w3.org/2000/svg";
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(ns, "defs");
    svg.prepend(defs);
  }
  const color = /^#[a-f0-9]{6}$/i.test(pet.color) ? pet.color : "#397c63";
  if (!svgIds.has(svg)) svgIds.set(svg, ++svgSequence);
  const id = `paws-${svgIds.get(svg)}-${pet.pattern}-${color.slice(1)}`;
  if (!defs.querySelector(`#${id}`)) {
    const make = (tag, attrs) => {
      const node = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      return node;
    };
    const pattern = make("pattern", {
      id,
      width: 24,
      height: 24,
      patternUnits: "userSpaceOnUse",
    });
    pattern.append(make("rect", { width: 24, height: 24, fill: color }));
    if (pet.pattern === "stripes") {
      pattern.append(
        make("path", {
          d: "M-6 6L6 -6M0 24L24 0M18 30L30 18",
          stroke: "#111",
          "stroke-opacity": ".5",
          "stroke-width": 6,
        }),
      );
    }
    if (pet.pattern === "grid") {
      pattern.append(
        make("path", {
          d: "M0 0H24V24H0Z",
          fill: "none",
          stroke: "#111",
          "stroke-opacity": ".6",
          "stroke-width": 2,
        }),
      );
    }
    if (pet.pattern === "camo") {
      pattern.setAttribute("width", "96");
      pattern.setAttribute("height", "96");
      pattern.replaceChildren(
        make("image", {
          href: CAMO_IMAGE,
          width: 96,
          height: 96,
          preserveAspectRatio: "none",
        }),
        make("rect", {
          width: 96,
          height: 96,
          fill: color,
          "fill-opacity": ".2",
        }),
      );
    }
    defs.append(pattern);
  }
  element.setAttribute("fill", `url(#${id})`);
}

export function colorSaturation(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi)?.map((x) => parseInt(x, 16) / 255);
  if (!rgb || rgb.length !== 3) return 55;
  const hi = Math.max(...rgb),
    lo = Math.min(...rgb),
    l = (hi + lo) / 2,
    d = hi - lo;
  return Math.max(
    20,
    Math.min(100, Math.round(d ? (d / (1 - Math.abs(2 * l - 1))) * 100 : 20)),
  );
}
