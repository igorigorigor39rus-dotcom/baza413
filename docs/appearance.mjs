const CAMO_IMAGE = new URL("./assets/military-camo.png?v=1.1.3", import.meta.url).href;
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
  if (
    !element ||
    !["stripes", "grid", "camo", "digital", "tiger", "flecktarn"].includes(
      pet.pattern,
    )
  ) return;
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
    // Разные структуры, а не перекраска одной фотографии. Цвет остаётся
    // связан с Hue/насыщенностью, а общая прозрачность задаётся самой областью.
    if (["digital", "tiger", "flecktarn"].includes(pet.pattern)) {
      const size = pet.pattern === "digital" ? 64 : 96;
      pattern.setAttribute("width", size);
      pattern.setAttribute("height", size);
      pattern.replaceChildren(
        make("rect", { width: size, height: size, fill: color }),
      );
      if (pet.pattern === "digital") {
        const pixels = [
          "00112200",
          "00113300",
          "33003311",
          "23330011",
          "22110033",
          "03112233",
          "00112200",
          "00112200",
        ];
        const shades = {
          "1": ["#101820", .55],
          "2": ["#ffffff", .25],
          "3": ["#101820", .85],
        };
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const shade = shades[pixels[y][x]];
            if (!shade) continue;
            pattern.append(
              make("rect", {
                x: x * 8,
                y: y * 8,
                width: 8,
                height: 8,
                fill: shade[0],
                "fill-opacity": shade[1],
              }),
            );
          }
        }
      }
      if (pet.pattern === "tiger") {
        for (const [y, flip] of [[9, 1], [36, -1], [67, 1]]) {
          const group = make("g", { transform: `translate(0 ${y})` });
          group.append(
            make("path", {
              d: "M-5 3C14-7 23 8 42 2S72-8 101 3L101 12C82 9 76 19 57 13S26 16-5 12Z",
              fill: "#101820",
              "fill-opacity": .8,
            }),
          );
          group.append(
            make("path", {
              d: flip > 0
                ? "M7 20Q25 8 48 22L38 26Q20 18 7 24Z"
                : "M52 22Q76 9 93 19L95 25Q76 17 52 27Z",
              fill: "#fff",
              "fill-opacity": .26,
            }),
          );
          pattern.append(group);
        }
      }
      if (pet.pattern === "flecktarn") {
        // Фиксированный генератор даёт один рисунок в досье и на каждой карте.
        let seed = 413;
        const random = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        for (let cluster = 0; cluster < 24; cluster++) {
          const x = random() * 96, y = random() * 96, light = cluster % 4 === 0;
          for (let dot = 0; dot < 3; dot++) {
            const cx = x + (random() - .5) * 12,
              cy = y + (random() - .5) * 12,
              rx = 2 + random() * 4,
              ry = 2 + random() * 3;
            // Дублируем крайние пятна через границу плитки без видимого шва.
            for (const dx of [-96, 0, 96]) {
              for (const dy of [-96, 0, 96]) {
                if (
                  cx + dx + rx > 0 && cx + dx - rx < 96 && cy + dy + ry > 0 &&
                  cy + dy - ry < 96
                ) {
                  pattern.append(
                    make("ellipse", {
                      cx: cx + dx,
                      cy: cy + dy,
                      rx,
                      ry,
                      fill: light ? "#fff" : "#101820",
                      "fill-opacity": light
                        ? .28
                        : cluster % 3 === 0
                        ? .45
                        : .8,
                    }),
                  );
                }
              }
            }
          }
        }
      }
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
