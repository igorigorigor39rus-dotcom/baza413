// Сокращаем только подпись. В балансах, цене и запросах остаются исходные числа.
export function formatBones(value) {
  const amount = Math.floor(Number(value));
  if (!Number.isFinite(amount)) return "—";
  if (Math.abs(amount) < 100000) return amount.toLocaleString("ru-RU");
  let power = 1;
  while (Math.abs(amount) >= 1000 ** (power + 1)) power++;
  // Не округляем вверх: 999999 не должны выглядеть как уже заработанный миллион.
  const coefficient = Math.trunc(amount / (1000 ** power / 100)) / 100;
  return `${coefficient}${power === 1 ? "k" : "к".repeat(power)}`;
}

export function fullBones(value) {
  const amount = Math.floor(Number(value));
  return Number.isFinite(amount) ? amount.toLocaleString("ru-RU") : "—";
}

export function setBonesText(element, value, prefix = "", suffix = "") {
  element.textContent = `${prefix}${formatBones(value)}${suffix}`;
  element.title = `${prefix}${fullBones(value)}${suffix}`;
  element.setAttribute("aria-label", element.title);
}
