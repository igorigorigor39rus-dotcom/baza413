import { createHandler } from "./handler.ts";
import { hmac } from "./auth.ts";
const token = "sync-test-token", now = 1800000000;
function assert(v: unknown): void {
  if (!v) throw Error("assertion failed");
}
async function auth() {
  const p = new URLSearchParams({
    auth_date: String(now),
    user: JSON.stringify({ id: 9, first_name: "Test" }),
  });
  const key = await hmac(new TextEncoder().encode("WebAppData"), token);
  const hash = await hmac(
    key,
    [...p].sort().map(([k, v]) => `${k}=${v}`).join("\n"),
  );
  p.set("hash", [...hash].map((x) => x.toString(16).padStart(2, "0")).join(""));
  return `tma ${p}`;
}
function fixture(pending = false) {
  const calls: { name: string; body: any }[] = [];
  const config: Record<string, string> = {
    TELEGRAM_BOT_TOKEN: token,
    SUPABASE_URL: "https://test.local",
    SUPABASE_SERVICE_ROLE_KEY: "fake",
    APP_URL: "https://example.test",
  };
  const handler = createHandler({
    env: (k) => config[k],
    now: () => now,
    fetch: async (input, init) => {
      const name = String(input).split("/").at(-1)!;
      calls.push({ name, body: JSON.parse(String(init?.body)) });
      return Response.json(
        name === "paws_sync"
          ? {
            wallet: { balance: 100 },
            live: { walk: null },
            notificationsKey: "a".repeat(32),
            deliveryPending: pending,
            chat: {
              messages: [{
                pet: {
                  photo_key: "9/11111111-1111-4111-8111-111111111111.jpg",
                },
              }],
            },
          }
          : { messages: [] },
      );
    },
  });
  return {
    calls,
    async send(body: unknown, authorization?: string) {
      return handler(
        new Request("https://test.local/functions/v1/paws-api/api/sync", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authorization ? { Authorization: authorization } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    },
  };
}
Deno.test("sync requires signed identity and uses one RPC with actor from signature", async () => {
  const f = fixture();
  assert((await f.send({ timezone: "UTC" })).status === 401);
  assert(f.calls.length === 0);
  const r = await f.send({ timezone: "UTC" }, await auth());
  assert(r.ok);
  assert(f.calls.length === 1);
  assert(f.calls[0].name === "paws_sync" && f.calls[0].body.p_actor === 9);
  const data = await r.json();
  assert(!Object.hasOwn(data, "deliveryPending"));
  assert(
    data.chat.messages[0].pet.photo.startsWith("https://test.local/storage/"),
  );
});
Deno.test("sync rejects malformed cursors before database access", async () => {
  for (
    const body of [
      { after: {} },
      { after: -1 },
      { after: 5001 },
      { walk: "bad" },
      { channel: 5 },
      { channel: "secret" },
      { context: "x".repeat(129) },
      { notificationsKey: {} },
    ]
  ) {
    const f = fixture();
    assert(
      (await f.send({ timezone: "UTC", ...body }, await auth())).status === 422,
    );
    assert(f.calls.length === 0);
  }
});
Deno.test("sync preserves retry of Telegram notifications when the queue is due", async () => {
  const f = fixture(true);
  assert((await f.send({ timezone: "UTC" }, await auth())).ok);
  assert(
    f.calls.map((c) => c.name).join(",") === "paws_sync,paws_notify_claim",
  );
});
