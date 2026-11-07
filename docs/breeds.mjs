import { dogPortrait } from "./dog.mjs?v=1.0.0";
let catalogPromise;
export function getBreeds() {
  return catalogPromise ??= fetch(
    new URL("./assets/breeds.json?v=1.0.0", import.meta.url),
  ).then((r) => {
    if (!r.ok) throw new Error("Не удалось загрузить список пород.");
    return r.json();
  });
}
const norm = (s) =>
  s.toLocaleLowerCase("ru-RU").replaceAll("ё", "е").replace(/[-–—]/g, " ")
    .trim();
export function filterBreeds(catalog, query) {
  const q = norm(query);
  return catalog.filter((b) =>
    norm([b.name, ...b.aliases].join(" ")).includes(q)
  ).slice(0, 35);
}
export function createBreedPicker() {
  const input = document.getElementById("pet-breed"),
    list = document.getElementById("breed-results"),
    icon = document.getElementById("breed-icon");
  let selected = null, catalog = [];
  function choose(b) {
    selected = b;
    input.value = b.name;
    input.setCustomValidity("");
    icon.replaceChildren(dogPortrait(b));
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }
  async function search() {
    try {
      catalog = await getBreeds();
    } catch (e) {
      document.getElementById("breed-status").textContent = e.message;
      return;
    }
    const found = filterBreeds(catalog, input.value);
    list.replaceChildren();
    for (const b of found) {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "option";
      button.append(dogPortrait(b));
      const name = document.createElement("span");
      name.textContent = b.name;
      button.append(name);
      button.addEventListener("click", () => choose(b));
      list.append(button);
    }
    const custom = input.value.trim();
    if (custom) {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "option";
      button.textContent = `Другая порода / метис: «${custom}»`;
      button.addEventListener(
        "click",
        () => choose({ id: "custom", name: custom, family: "generic" }),
      );
      list.append(button);
    }
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }
  input.addEventListener("input", () => {
    selected = null;
    input.setCustomValidity("Выберите породу из результатов поиска.");
    void search();
  });
  input.addEventListener("focus", () => void search());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      list.querySelector("button")?.focus();
    }
  });
  list.addEventListener("keydown", (e) => {
    const buttons = [...list.querySelectorAll("button")],
      i = buttons.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    }
    if (e.key === "Escape") {
      list.hidden = true;
      input.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".breed-picker")) {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
    }
  });
  return {
    set: (pet) => {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      if (pet?.breedId) {
        choose({
          id: pet.breedId,
          name: pet.breedName,
          family: pet.breedFamily,
        });
      } else {
        selected = null;
        input.value = "";
        input.setCustomValidity("Выберите породу питомца.");
        icon.replaceChildren(dogPortrait());
      }
    },
    value: () => {
      if (!selected) throw new Error("Выберите породу питомца.");
      return {
        breedId: selected.id,
        breedCustom: selected.id === "custom" ? selected.name : null,
      };
    },
  };
}
