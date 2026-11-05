// Аналог backend/auth.py: доверяем только строке initData, подписанной Telegram.
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const encoder = new TextEncoder();
async function hmac(key: Uint8Array, value: string) {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(value)),
  );
}
export async function verifyInitData(
  raw: string,
  token: string,
  now = Date.now() / 1000,
): Promise<number> {
  const invalid = () =>
    new ApiError(401, "Откройте приложение заново через кнопку Telegram-бота.");
  if (!raw || raw.length > 8192 || !token) throw invalid();
  const pairs = [...new URLSearchParams(raw)];
  const fields = new Map(pairs);
  if (pairs.length !== fields.size) throw invalid();
  const supplied = fields.get("hash") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(supplied)) throw invalid();
  fields.delete("hash");
  const check = [...fields].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map((
    [k, v],
  ) => `${k}=${v}`).join("\n");
  const secret = await hmac(encoder.encode("WebAppData"), token);
  const imported = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const bytes = Uint8Array.from(supplied.match(/../g)!, (x) => parseInt(x, 16));
  if (
    !await crypto.subtle.verify("HMAC", imported, bytes, encoder.encode(check))
  ) throw invalid();
  const date = fields.get("auth_date") ?? "";
  const age = now - Number(date);
  // Шесть часов позволяют закончить прогулку. InitData не сохраняем в браузере.
  if (!/^\d{1,12}$/.test(date) || age < -30 || age > 21600) throw invalid();
  try {
    const id = JSON.parse(fields.get("user") ?? "").id;
    if (!Number.isSafeInteger(id) || id <= 0 || id >= 2 ** 52) throw invalid();
    return id;
  } catch {
    throw invalid();
  }
}
export async function equalSecret(a: string, b: string) {
  if (!a || !b || a.length > 256 || b.length > 256) return false;
  const [x, y] = await Promise.all(
    [a, b].map((s) => crypto.subtle.digest("SHA-256", encoder.encode(s))),
  );
  const left = new Uint8Array(x), right = new Uint8Array(y);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
export { hmac };
