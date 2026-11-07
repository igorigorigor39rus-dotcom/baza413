// Один SVG-персонаж с общим скелетом. Пропорции и шерсть задаются породой;
// анимация дыхания, ушей, глаз и хвоста не требует видео или внешних картинок.
const TYPES = {
  generic: [45, 29, 27, 30, "drop", "#a59888", "#ddd9cf", 16],
  retriever: [51, 32, 29, 33, "drop", "#b7a184", "#e6dfcf", 18],
  shepherd: [51, 29, 35, 31, "point", "#a48d72", "#303943", 19],
  spitz: [44, 33, 24, 32, "point", "#ced0ca", "#f0ede2", 15],
  bat: [42, 32, 20, 34, "bat", "#b4aaa0", "#e5dfd1", 10],
  flat: [42, 32, 18, 35, "fold", "#b5a18a", "#343b43", 7],
  long: [63, 24, 12, 28, "long", "#96806c", "#c7b39a", 22],
  sighthound: [59, 22, 43, 25, "fold", "#b9b9b0", "#e9e5d8", 27],
  curly: [41, 31, 31, 31, "fluffy", "#c2c6ca", "#e7e8df", 15],
  spaniel: [44, 30, 24, 31, "long", "#988678", "#e0ddd1", 16],
  mastiff: [58, 36, 29, 37, "fold", "#899199", "#c4c6c4", 18],
  terrier: [39, 27, 27, 28, "fold", "#939b9f", "#c4b39c", 19],
  hound: [48, 28, 31, 29, "long", "#d7d4c8", "#8e7967", 20],
  hairless: [42, 25, 29, 27, "bat", "#9f9993", "#b9b4ad", 17],
};
export function dogPortrait(
  breed = {},
  { animated = false, helmet = true } = {},
) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 220 220");
  svg.setAttribute("role", "img");
  const name = String(breed.name ?? breed.breedName ?? "Питомец");
  svg.setAttribute("aria-label", `Стилизованный питомец: ${name}`);
  svg.classList.add("dog-avatar");
  if (animated) svg.classList.add("is-animated");
  const family = breed.family ?? breed.breedFamily ?? "generic";
  let [body, deep, leg, head, ears, coat, bib, snout] = TYPES[family] ??
    TYPES.generic;
  const n = (name + " " + (breed.aliases ?? []).join(" ")).toLowerCase();
  if(/чихуа|chihuahua|йорк|yorkshire|той|toy|померан|pomeranian/.test(n))svg.classList.add("size-toy");
  if(/мастиф|mastiff|сенбер|bernard|немецкий дог|great dane|ньюфаунд|newfoundland/.test(n))svg.classList.add("size-giant");
  let spots = false, saddle = family === "shepherd", mask = family === "flat";
  if (/далмат|dalmat/.test(n)) {
    coat = "#e1e3dc";
    bib = "#e8e9e0";
    spots = true;
  }
  if (/хаски|husky|маламут|malamute/.test(n)) {
    coat = "#7c8a97";
    bib = "#e6e9e2";
    mask = true;
  }
  if (/корги|corgi/.test(n)) {
    body = 52;
    leg = 14;
    ears = "bat";
    coat = "#b59a7c";
    bib = "#ece5d6";
  }
  if (/добер|doberman|ротвей|rottweiler/.test(n)) {
    coat = "#343e48";
    bib = "#ae9276";
    saddle = false;
  }
  if (/йорк|yorkshire/.test(n)) {
    body = 33;
    leg = 20;
    head = 27;
    coat = "#717e8b";
    bib = "#b8a184";
    ears = "point";
  }
  if (/бигл|beagle/.test(n)) {
    coat = "#dad7ca";
    bib = "#ac9174";
    saddle = true;
  }
  if (/шиба|сиба|shiba|chow|чау/.test(n)) {
    coat = "#ab9176";
    bib = "#ded4c0";
  }
  if (/сенбер|bernard|бернск|bernese/.test(n)) {
    coat = "#6c7378";
    bib = "#e8e3d7";
  }
  const ground = 194,
    torsoY = ground - leg - deep + 4,
    hy = torsoY - deep + 3,
    hx = 73;
  const stroke = "#172029",
    outline =
      `stroke="${stroke}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"`;
  const ellipse = (cx, cy, rx, ry, fill) =>
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" ${outline}/>`;
  let art =
    `<ellipse cx="111" cy="201" rx="70" ry="8" fill="#10151c" opacity=".2"/><g class="dog-body">`;
  art += `<g class="dog-tail"><path d="M${112 + body - 7} ${torsoY - 9} Q197 ${
    torsoY - 42
  } 177 ${torsoY - 48} Q162 ${torsoY - 45} 179 ${
    torsoY - 27
  }" fill="none" stroke="${stroke}" stroke-width="16" stroke-linecap="round"/><path d="M${
    112 + body - 7
  } ${torsoY - 9} Q197 ${torsoY - 42} 177 ${torsoY - 48} Q162 ${
    torsoY - 45
  } 179 ${
    torsoY - 27
  }" fill="none" stroke="${coat}" stroke-width="10" stroke-linecap="round"/></g>`;
  for (const x of [91, 145]) {
    art += `<path d="M${x} ${torsoY + 8}l-3 ${
      ground - torsoY - 8
    }q10 7 20 0l-1-${ground - torsoY - 8}Z" fill="${bib}" ${outline}/>`;
  }
  art += ellipse(119, torsoY, body, deep, coat);
  if (saddle) {
    art += `<path d="M99 ${
      torsoY - deep + 3
    }q26-11 49 5l10 20q-32 11-59-4Z" fill="#3d4852" opacity=".95"/>`;
  }
  if (spots) {
    for (
      const [x, y, r] of [[105, torsoY - 7, 7], [136, torsoY + 11, 6], [
        142,
        torsoY - 13,
        5,
      ], [118, torsoY + 15, 4]]
    ) art += `<circle cx="${x}" cy="${y}" r="${r}" fill="#3d4852"/>`;
  }
  art += ellipse(83, torsoY + 12, 19, deep * .84, bib);
  art += `<path d="M72 ${torsoY + 14}l-2 ${ground - torsoY - 14}q12 8 23 0l-3-${
    ground - torsoY - 14
  }Z" fill="${coat}" ${outline}/>`;
  const ear = (x, left) =>
    ears === "point" || ears === "bat"
      ? `<path d="M${x - 10} ${hy - 12} Q${x - 16} ${hy - head - 33} ${x + 1} ${
        hy - head - 24
      } L${x + 15} ${hy - 10}Z" fill="${coat}" ${outline}/><path d="M${x - 5} ${
        hy - 18
      }L${x} ${hy - head - 11}l8 ${
        head - 5
      }" fill="none" stroke="${bib}" stroke-width="6" stroke-linecap="round"/>`
      : `<path d="M${x - 12} ${hy - 17}q${left ? -22 : 20} 9 ${
        left ? -8 : 14
      } ${
        ears === "long" ? 52 : 34
      }q15 13 19-10l-2-28Z" fill="${bib}" ${outline}/>`;
  art += `<g class="dog-head">${ear(hx - 19, true)}${
    ellipse(hx, hy, head, head * .94, coat)
  }${ear(hx + 23, false)}`;
  if (family === "curly") {
    for (let i = 0; i < 7; i++) {
      art += ellipse(
        hx - head + 8 + i * (head * 2 - 16) / 6,
        hy - head + 2,
        8,
        8,
        coat,
      );
    }
  }
  if (family === "spitz") {
    art += `<path d="M${hx - head + 7} ${
      hy + 3
    }q7 38 31 24 23 9 28-21l-18 7-12-10-14 10Z" fill="${bib}" opacity=".8"/>`;
  }
  art += ellipse(
    hx - 10,
    hy + head * .48,
    snout + 10,
    head * .43,
    mask ? "#5a6269" : bib,
  );
  art += `<g class="dog-eye"><ellipse cx="${hx - 14}" cy="${
    hy - 2
  }" rx="3.8" ry="5" fill="${stroke}"/><ellipse cx="${hx + 10}" cy="${
    hy - 2
  }" rx="3.8" ry="5" fill="${stroke}"/></g><path d="M${hx - 20} ${
    hy + 12
  }q10-7 18 0l-8 7Z" fill="${stroke}"/><path d="M${hx - 10} ${
    hy + 18
  }v6m-8 0q8 8 16 0" fill="none" ${outline}/>`;
  if (helmet) {
    art += `<path d="M${hx - 29} ${
      hy - 20
    }q-3-35 27-35 29 0 30 35Z" fill="#647083" ${outline}/><path d="M${
      hx - 34
    } ${
      hy - 19
    }q32-10 68 0" fill="none" stroke="${stroke}" stroke-width="7" stroke-linecap="round"/><path d="M${
      hx - 12
    } ${hy - 46}q8-4 16 0" stroke="#a8b5c6" stroke-width="4" fill="none"/>`;
  }
  art += "</g></g>";
  // В строке SVG только фиксированные цвета и числовые пропорции; имя идёт в aria-label.
  svg.innerHTML = art;
  return svg;
}
