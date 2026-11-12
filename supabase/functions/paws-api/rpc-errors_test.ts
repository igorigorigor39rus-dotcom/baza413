import { rpcFailure, rpcFailureMessage } from "./rpc-errors.ts";
function assert(v: unknown) {
  if (!v) throw Error("assertion failed");
}
Deno.test("RPC diagnostics: allowlisted codes distinguish busy DB, missing SQL and permissions", () => {
  for (
    const [code, text] of [
      ["57014", "отведённое время"],
      ["55P03", "База занята"],
      ["40P01", "База занята"],
      ["PGRST003", "База занята"],
      ["PGRST000", "соединение с базой"],
      ["PGRST202", "серверной функции"],
      ["PGRST203", "структуры базы"],
      ["42883", "серверной функции"],
      ["42P01", "структуры базы"],
      ["42501", "недостаточно прав"],
      ["XX000", "Не удалось выполнить"],
    ]
  ) {
    const failure = rpcFailure("paws_live_capture_shared", 400, code);
    const message = rpcFailureMessage(failure);
    assert(message.includes(text) && message.includes(code));
    assert(Object.keys(failure).sort().join() === "code,rpc,status");
  }
});
Deno.test("RPC diagnostics: unexpected codes cannot expose SQL, values or secrets", () => {
  for (
    const code of [
      null,
      {},
      123,
      "SECRET_TOKEN",
      "XX000\nprivate-coordinates",
      "PGRST202?token=secret",
    ]
  ) {
    const event = rpcFailure("paws_live_capture_shared", 500, code);
    assert(event.code === "UNKNOWN");
    assert(!rpcFailureMessage(event).includes("secret"));
  }
});
