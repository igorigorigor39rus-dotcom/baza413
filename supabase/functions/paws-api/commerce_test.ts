import { createCommerce } from "./commerce.ts";
import { createEngagement } from "./engagement.ts";
import { ApiError } from "./auth.ts";
const id = "00000000-0000-0000-0000-000000000100";
function assert(x: unknown): asserts x {
  if (!x) throw new Error("Assertion failed");
}
Deno.test("Stars: invoice uses XTR, empty provider, one server price and signed owner", async () => {
  const calls: any[] = [];
  const commerce = createCommerce({
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { id, stars: 250, bones: 30000 };
    },
    bot: async (name, args) => {
      calls.push({ name, args });
      return "https://t.me/$test";
    },
  });
  const result = await commerce.api("/api/shop/invoice", 42, {
    packageId: id,
    requestId: id,
    bones: 999999,
    stars: 1,
  });
  assert(result?.orderId === id);
  assert(calls[0].args.p_user === 42);
  const invoice = calls[1].args;
  assert(
    invoice.currency === "XTR" && invoice.provider_token === "" &&
      invoice.prices.length === 1 && invoice.prices[0].amount === 250,
  );
  assert(invoice.payload === `dw:${id}`);
});
Deno.test("Stars: pre-checkout validates order before approval and never credits", async () => {
  const calls: any[] = [];
  let reject = false;
  const commerce = createCommerce({
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (reject) throw new ApiError(422, "Счёт недоступен");
      return { ok: true };
    },
    bot: async (name, args) => {
      calls.push({ name, args });
    },
  });
  const update = {
    pre_checkout_query: {
      id: "q",
      from: { id: 42 },
      invoice_payload: `dw:${id}`,
      currency: "XTR",
      total_amount: 100,
    },
  };
  await commerce.webhook(update);
  assert(calls[0].name === "paws_star_checkout" && calls[0].args.p_user === 42);
  assert(calls[1].args.ok === true);
  calls.length = 0;
  reject = true;
  await commerce.webhook(update);
  assert(calls[1].args.ok === false);
  assert(!calls.some((x) => x.name === "paws_star_paid"));
});
Deno.test("Stars: only successful payment credits; replay and refund use authoritative DB result", async () => {
  const calls: any[] = [];
  let duplicate = false;
  const commerce = createCommerce({
    rpc: async (name, args) => {
      calls.push({ name, args });
      return name === "paws_star_paid"
        ? { credited: !duplicate, bones: 10000 }
        : { changed: true };
    },
    bot: async (name, args) => {
      calls.push({ name, args });
    },
  });
  const payment = {
    invoice_payload: `dw:${id}`,
    currency: "XTR",
    total_amount: 100,
    telegram_payment_charge_id: "charge",
  };
  const message = {
    chat: { id: 42, type: "private" },
    from: { id: 777000 },
    successful_payment: payment,
  };
  assert(await commerce.webhook({ message }));
  assert(calls[0].name === "paws_star_paid" && calls[0].args.p_user === 42);
  assert(calls.length === 2);
  calls.length = 0;
  duplicate = true;
  await commerce.webhook({ message });
  assert(calls.length === 1);
  calls.length = 0;
  await commerce.webhook({
    message: { chat: message.chat, refunded_payment: payment },
  });
  assert(calls[0].name === "paws_star_refunded");
});
Deno.test("Stars: unmatched successful payment records issue and requests refund", async () => {
  const calls: any[] = [];
  const commerce = createCommerce({
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "paws_star_paid") throw new ApiError(422, "Нет счёта");
      return { refunded: false };
    },
    bot: async (name, args) => {
      calls.push({ name, args });
    },
  });
  await commerce.webhook({
    message: {
      chat: { id: 42, type: "private" },
      successful_payment: {
        invoice_payload: `dw:${id}`,
        currency: "XTR",
        total_amount: 100,
        telegram_payment_charge_id: "unknown",
      },
    },
  });
  assert(
    calls.map((x) => x.name).join(",") ===
      "paws_star_paid,paws_payment_issue,refundStarPayment,paws_payment_issue,sendMessage",
  );
});
Deno.test("Reminders: delivery acknowledges success and retains failed message for retry", async () => {
  const acks: any[] = [];
  let claimed = false;
  const engagement = createEngagement({
    appUrl: "https://example.com/",
    rpc: async (name, args) => {
      if (name === "paws_reminders_claim") {
        if (claimed) return { messages: [] };
        claimed = true;
        return {
          messages: [{
            id: "a",
            recipientId: "42",
            leaseToken: "l",
            message: "walk",
          }, { id: "b", recipientId: "43", leaseToken: "m", message: "walk" }],
        };
      }
      acks.push(args);
      return {};
    },
    bot: async (_name, args) => {
      if (args.chat_id === 43) throw new Error("blocked");
    },
  });
  await engagement.deliver();
  assert(
    acks.length === 2 && acks.find((x) => x.p_id === "a").p_ok === true &&
      acks.find((x) => x.p_id === "b").p_ok === false,
  );
});
