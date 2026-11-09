import { drain, makeHandler, secretMatches, type Services } from "./handler.ts";

function assert(
  condition: unknown,
  description = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(description);
}
const config = {
  token: "TEST_ONLY",
  secret: "s".repeat(48),
  adminIds: [7],
  groupId: -100123,
};
const privateMessage = (text: string, extra = {}) => ({
  update_id: 1,
  message: {
    message_id: 10,
    from: { id: 9, first_name: "Пользователь" },
    chat: { id: 9, type: "private" },
    text,
    ...extra,
  },
});
const groupMessage = (actor: number, extra = {}) => ({
  update_id: 2,
  message: {
    message_id: 11,
    from: { id: actor },
    chat: { id: -100123, type: "supergroup" },
    text: "Ответ",
    reply_to_message: { message_id: 99 },
    ...extra,
  },
});
function fixture(result: any = { kind: "noop" }) {
  const calls: { name: string; args: any }[] = [];
  const telegram: { method: string; payload: any }[] = [];
  const queue = new Map<string, any>();
  const services: Services = {
    rpc(name, args = {}) {
      calls.push({ name, args });
      if (name === "feedback_apply") return Promise.resolve(result);
      if (name === "feedback_enqueue") queue.set(args.p_key, args);
      return Promise.resolve(null);
    },
    telegram(method, payload) {
      telegram.push({ method, payload });
      return Promise.resolve(true);
    },
  };
  const handler = makeHandler(config, services);
  const send = (update: any, secret = config.secret, path = "") =>
    handler(
      new Request(`https://local.test/${path}`, {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
        body: JSON.stringify(update),
      }),
    );
  return { calls, telegram, queue, send, handler, services };
}

Deno.test("webhook rejects missing/wrong secret before touching database", async () => {
  const f = fixture();
  assert((await f.send(privateMessage("test"), "")).status === 401);
  assert((await f.send(privateMessage("test"), "x".repeat(48))).status === 401);
  assert(f.calls.length === 0);
  assert(!secretMatches("", ""));
});
Deno.test("/id works before group configuration and does not expose secrets", async () => {
  const f = fixture();
  const handler = makeHandler(
    { ...config, groupId: 0, adminIds: [] },
    f.services,
  );
  const response = await handler(
    new Request("https://local.test/", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": config.secret },
      body: JSON.stringify(privateMessage("/id")),
    }),
  );
  assert(response.ok);
  const row = [...f.queue.values()][0];
  assert(row.p_payload.text.includes("9"));
  assert(!JSON.stringify(row).includes(config.secret));
});
Deno.test("ordinary group members cannot reply to users or alter statuses", async () => {
  const f = fixture();
  await f.send(groupMessage(99));
  await f.send({
    update_id: 3,
    callback_query: {
      id: "q",
      from: { id: 99 },
      data: "closed",
      message: groupMessage(99).message,
    },
  });
  assert(!f.calls.some((x) => x.name === "feedback_apply"));
  assert(f.queue.size === 0);
  assert(f.telegram[0].method === "answerCallbackQuery");
});
Deno.test("admin actions only accepted inside configured group", async () => {
  const f = fixture();
  await f.send(groupMessage(7, { chat: { id: -100999, type: "supergroup" } }));
  assert(!f.calls.some((x) => x.name === "feedback_apply"));
});
Deno.test("admin reply sends only to stored ticket owner, never reply metadata user", async () => {
  const f = fixture({
    kind: "reply",
    ticket: { id: 123, user_id: 9 },
    text: "Спасибо",
  });
  await f.send(groupMessage(7));
  const operation = f.calls.find((x) => x.name === "feedback_apply")!;
  assert(
    operation.args.p_action === "reply" &&
      operation.args.p_data.reply_to === 99,
  );
  assert(
    [...f.queue.values()].some((x) =>
      x.p_payload.chat_id === 9 && x.p_payload.text.includes("#123")
    ),
  );
});
Deno.test("photo is copied with ticket mapping; text is never interpreted as HTML", async () => {
  const f = fixture({
    kind: "ticket",
    ticket: {
      id: 55,
      user_id: 9,
      source_message_id: 10,
      category: "bug",
      display_name: "<b>Name</b>",
      body: "<script>test</script>",
      attachment: true,
    },
  });
  const update = privateMessage("<script>test</script>", {
    photo: [{ file_id: "fake-file" }],
  });
  await f.send(update);
  await f.send(update);
  assert(
    f.queue.size === 3,
    "duplicate update must use deterministic outbox keys",
  );
  const photo = [...f.queue.values()].find((x) => x.p_method === "copyMessage");
  assert(
    photo.p_payload.from_chat_id === 9 && photo.p_ticket === 55 &&
      photo.p_role === "ticket",
  );
  assert(
    [...f.queue.values()].every((x) => x.p_payload.parse_mode === undefined),
  );
});
Deno.test("edited messages and channel posts do not become feedback", async () => {
  const f = fixture();
  await f.send({
    update_id: 3,
    edited_message: privateMessage("edited").message,
  });
  await f.send({
    update_id: 4,
    channel_post: privateMessage("channel").message,
  });
  assert(f.calls.length === 0);
});
Deno.test("Stars invoice is XTR, has no provider token and does not touch game wallet", async () => {
  const f = fixture({
    kind: "invoice",
    order: { id: "test-order", stars: 120 },
  });
  await f.send(privateMessage("120"));
  const invoice = [...f.queue.values()][0];
  assert(invoice.p_method === "sendInvoice");
  assert(
    invoice.p_payload.currency === "XTR" &&
      invoice.p_payload.provider_token === "",
  );
  assert(
    invoice.p_payload.prices[0].amount === 120 &&
      invoice.p_payload.payload === "support:test-order",
  );
  assert(f.calls.every((x) => x.name.startsWith("feedback_")));
});
Deno.test("checkout is rejected directly if amount/currency/payer does not match", async () => {
  const f = fixture({ kind: "checkout", ok: false });
  await f.send({
    update_id: 10,
    pre_checkout_query: {
      id: "checkout",
      from: { id: 9 },
      invoice_payload: "support:test-order",
      currency: "RUB",
      total_amount: 999,
    },
  });
  assert(
    f.telegram[0].method === "answerPreCheckoutQuery" &&
      f.telegram[0].payload.ok === false,
  );
  assert(f.calls[0].args.p_data.order === "test-order");
});
Deno.test("successful payment confirms support and only sends one set of notices", async () => {
  const f = fixture({ kind: "paid", stars: 50, order_id: "order-id" });
  const update = privateMessage("", {
    successful_payment: {
      invoice_payload: "support:order-id",
      currency: "XTR",
      total_amount: 50,
      telegram_payment_charge_id: "charge-id",
    },
  });
  await f.send(update);
  await f.send(update);
  assert(f.queue.size === 2);
  assert(
    f.calls.filter((x) => x.name === "feedback_apply").every((x) =>
      x.args.p_action === "paid"
    ),
  );
});
Deno.test("refund operation restricted to admin and uses stored charge and user", async () => {
  const f = fixture({
    kind: "refund",
    order: { id: "order-id", user_id: 9, charge_id: "charge" },
  });
  await f.send(groupMessage(99, { text: "/refund order-id" }));
  assert(f.queue.size === 0);
  await f.send(groupMessage(7, { text: "/refund order-id" }));
  const refund = [...f.queue.values()].find((x) =>
    x.p_method === "refundStarPayment"
  );
  assert(
    refund.p_payload.user_id === 9 &&
      refund.p_payload.telegram_payment_charge_id === "charge",
  );
});
Deno.test("malformed DB response fails webhook so Telegram can retry", async () => {
  const f = fixture();
  f.services.rpc = () =>
    Promise.reject(new Error("private details must not be logged"));
  assert((await f.send(privateMessage("hello"))).status === 500);
});
Deno.test("failed deliveries persist retry status without exposing error contents", async () => {
  const finishes: any[] = [];
  let once = true;
  await drain({
    rpc(name, args) {
      if (name === "feedback_claim" && once) {
        once = false;
        return Promise.resolve({
          id: 1,
          lease: "uuid",
          method: "sendMessage",
          payload: {},
        });
      }
      if (name === "feedback_finish") finishes.push(args);
      return Promise.resolve(null);
    },
    telegram() {
      return Promise.reject(new Error("secret-token"));
    },
  });
  assert(
    finishes[0].p_ok === false &&
      !JSON.stringify(finishes).includes("secret-token"),
  );
});
Deno.test("health reports flags only and retry endpoint needs webhook secret", async () => {
  const f = fixture();
  const response = await f.handler(new Request("https://local.test/health"));
  const data = await response.json();
  assert(data.service === "dogwars-feedback" && data.group_configured);
  assert(!JSON.stringify(data).includes(config.secret));
  assert((await f.send({}, "", "retry")).status === 401);
});
