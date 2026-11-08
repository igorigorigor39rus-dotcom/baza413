import { createAccounts, telegramUsername } from "./accounts.ts";
import { ApiError } from "./auth.ts";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("Assertion failed");
}
Deno.test("v11 accounts: only public t.me usernames, never arbitrary URLs or invites", () => {
  for (
    const value of [
      "@Second_General",
      "https://t.me/Second_General",
      "t.me/second_general/",
    ]
  ) assert(telegramUsername(value) === "second_general");
  for (
    const value of [
      "https://evil.example/second_general",
      "https://t.me/+private",
      "https://t.me/valid_user?start=evil",
      "https://t.me/valid_user/other",
      "tiny",
      "123456",
      "https://t.me.evil/valid_user",
    ]
  ) {
    let failed = false;
    try {
      telegramUsername(value);
    } catch (e) {
      failed = e instanceof ApiError && e.status === 422;
    }
    assert(failed);
  }
});
Deno.test("v11 accounts: invitation stores hash and signed actor, URL contains random token", async () => {
  const calls: any[] = [];
  const accounts = createAccounts({
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { role: "primary" };
    },
    bot: async () => ({ username: "DogWars_test_bot" }),
  });
  const result = await accounts.api(
    "/api/accounts/invite",
    "POST",
    42,
    "main_general",
    { username: "https://t.me/second_general" },
  );
  const token = new URL(result.url).searchParams.get("start")!.slice(5);
  assert(/^[a-f0-9]{32}$/.test(token));
  assert(
    calls[0].args.p_user === 42 &&
      calls[0].args.p_username === "second_general",
  );
  assert(
    /^[a-f0-9]{64}$/.test(calls[0].args.p_hash) &&
      !calls[0].args.p_hash.includes(token),
  );
});
Deno.test("v11 accounts: Telegram preview requires explicit confirmation; forged private sender ignored", async () => {
  const calls: any[] = [], messages: any[] = [];
  const accounts = createAccounts({
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { name: "Рекс" };
    },
    bot: async (name, args) => {
      messages.push({ name, args });
      return true;
    },
  });
  const token = "a".repeat(32),
    message = {
      from: { id: 88, username: "second_general" },
      chat: { id: 88, type: "private" },
      text: `/start link_${token}`,
    };
  assert(await accounts.webhook({ message }));
  assert(calls[0].name === "paws_account_preview");
  assert(
    messages[0].args.reply_markup.inline_keyboard[0][0].callback_data ===
      `link_accept:${token}`,
  );
  assert(
    await accounts.webhook({
      callback_query: {
        id: "callback",
        from: message.from,
        message: { chat: message.chat },
        data: `link_accept:${token}`,
      },
    }),
  );
  assert(
    calls[1].name === "paws_account_accept" && calls[1].args.p_user === 88,
  );
  const before = calls.length;
  assert(
    !await accounts.webhook({ message: { ...message, from: { id: 99 } } }),
  );
  assert(calls.length === before);
});
Deno.test("v11 accounts: resolve fails closed on malformed membership, removal uses actor", async () => {
  const calls: any[] = [];
  const accounts = createAccounts({
    rpc: async (name, args) => {
      calls.push({ name, args });
      return name === "paws_account_resolve" ? { ownerId: "not-id" } : {};
    },
    bot: async () => ({}),
  });
  let failed = false;
  try {
    await accounts.resolve(88);
  } catch (e) {
    failed = e instanceof ApiError && e.status === 503;
  }
  assert(failed);
  await accounts.api("/api/accounts/secondary", "DELETE", 88, null, {});
  assert(
    calls[1].name === "paws_account_remove" && calls[1].args.p_user === 88 &&
      calls[1].args.p_invite_only === false,
  );
});
