// Обработчик не знает игровой токен и не обращается к балансу косточек.
// Зависимости передаются отдельно: тесты запускаются без Telegram и Supabase.
type Obj = Record<string, any>;
export interface Config {
  token: string;
  secret: string;
  adminIds: number[];
  groupId: number;
}
export interface Services {
  rpc(name: string, args?: Obj): Promise<any>;
  telegram(method: string, payload: Obj): Promise<any>;
}

const labels: Obj = {
  idea: "💡 Идея",
  bug: "🐞 Ошибка",
  question: "❓ Вопрос",
};
const statuses: Obj = {
  open: "получено",
  working: "в работе",
  closed: "закрыто",
};
const menu = {
  inline_keyboard: [
    [{ text: "💡 Предложить идею", callback_data: "idea" }],
    [{ text: "🐞 Сообщить об ошибке", callback_data: "bug" }],
    [{ text: "❓ Задать вопрос", callback_data: "question" }],
    [{ text: "❤️ Поддержать разработчика", callback_data: "donation" }],
  ],
};
const ticketButtons = {
  inline_keyboard: [[
    { text: "🛠 В работу", callback_data: "working" },
    { text: "✅ Закрыть", callback_data: "closed" },
  ]],
};
const donationTerms =
  "Добровольная поддержка разработки DogWars через Telegram Stars. " +
  "Она не даёт косточек, территорий или других игровых преимуществ. " +
  "Сумма — от 1 до 10 000 ⭐. Вопросы об оплате и возврате: /paysupport.";

export function secretMatches(actual: string, expected: string): boolean {
  // Сравниваем все символы, не завершаясь на первом несовпадении.
  let difference = actual.length ^ expected.length;
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    difference |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return expected.length >= 32 && difference === 0;
}

export async function drain(services: Services, maximum = 12): Promise<void> {
  const started = Date.now();
  for (let i = 0; i < maximum; i++) {
    // Остаток очереди обработают следующие события; не держим Edge Function бесконечно.
    if (Date.now() - started > 30000) return;
    const row = await services.rpc("feedback_claim");
    if (!row) return;
    let ok = false;
    let message: number | null = null;
    let error: string | null = null;
    try {
      const response = await services.telegram(row.method, row.payload);
      message = response?.message_id ?? null;
      ok = true;
    } catch {
      // Нельзя писать полный Telegram URL/ответ в логи: там могут быть токен и личные данные.
      error = "Telegram delivery failed; queued for retry";
    }
    await services.rpc("feedback_finish", {
      p_id: row.id,
      p_lease: row.lease,
      p_ok: ok,
      p_message: message,
      p_error: error,
    });
  }
}

export function makeHandler(config: Config, services: Services) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path.endsWith("/health")) {
      return Response.json({
        service: "dogwars-feedback",
        configured: !!config.token && !!config.secret,
        group_configured: config.groupId < 0,
        admins_configured: config.adminIds.length > 0,
      });
    }
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    if (
      !secretMatches(
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "",
        config.secret,
      )
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      if (path.endsWith("/retry")) {
        await drain(services, 30);
        return Response.json({ ok: true });
      }
      const raw = await request.text();
      if (raw.length > 131072) {
        return new Response("Too large", { status: 413 });
      }
      const update: Obj = JSON.parse(raw);
      if (!Number.isSafeInteger(update.update_id)) {
        return new Response("Invalid update", { status: 400 });
      }
      const callback = update.callback_query;
      const checkout = update.pre_checkout_query;
      const message = update.message ?? callback?.message;
      const sender = checkout?.from ?? callback?.from ?? message?.from;
      if (
        !sender || sender.is_bot || !Number.isSafeInteger(sender.id) ||
        sender.id <= 0
      ) {
        return Response.json({ ok: true });
      }
      const actor: number = sender.id;
      const chatId: number = message?.chat?.id ?? actor;
      const privateChat = message?.chat?.type === "private" && chatId === actor;
      const admin = config.adminIds.includes(actor) &&
        chatId === config.groupId && config.groupId < 0;
      const text = String(message?.text ?? message?.caption ?? "");
      const command = text.split(/\s/, 1)[0].split("@")[0].toLowerCase();
      const prefix = `update:${update.update_id}`;
      const enqueue = async (
        key: string,
        method: string,
        payload: Obj,
        ticket: number | null = null,
        role = "notice",
      ) => {
        await services.rpc("feedback_enqueue", {
          p_key: key,
          p_method: method,
          p_payload: payload,
          p_ticket: ticket,
          p_role: role,
        });
      };
      const say = (
        key: string,
        target: number,
        body: string,
        extra: Obj = {},
        ticket: number | null = null,
        role = "notice",
      ) =>
        enqueue(
          key,
          "sendMessage",
          { chat_id: target, text: body, ...extra },
          ticket,
          role,
        );
      const apply = (action: string, data: Obj = {}) =>
        services.rpc("feedback_apply", {
          p_update_id: update.update_id,
          p_actor: actor,
          p_action: action,
          p_data: data,
        });
      let result: Obj | null = null;

      // /id работает до заполнения ADMIN_IDS: владелец узнаёт свой ID и ID группы.
      if (!callback && !checkout && command === "/id") {
        await say(
          prefix,
          chatId,
          `Ваш Telegram ID: ${actor}\nID этого чата: ${chatId}`,
        );
      } else if (config.groupId >= 0 || config.adminIds.length === 0) {
        return new Response(
          "Configure feedback group and administrators first",
          { status: 503 },
        );
      } else if (checkout) {
        const payload = String(checkout.invoice_payload ?? "");
        result = await apply("checkout", {
          order: payload.startsWith("support:") ? payload.slice(8) : "",
          amount: checkout.total_amount,
          currency: checkout.currency,
        });
        // Telegram требует ответа на pre_checkout_query в течение 10 секунд.
        await services.telegram("answerPreCheckoutQuery", {
          pre_checkout_query_id: checkout.id,
          ok: result!.ok === true,
          ...(result!.ok === true ? {} : {
            error_message:
              "Счёт устарел или не совпадает. Откройте «Поддержать разработчика» заново.",
          }),
        });
        return Response.json({ ok: true });
      } else if (privateChat && !callback && message.successful_payment) {
        const payment = message.successful_payment;
        result = await apply("paid", {
          order: String(payment.invoice_payload).replace(/^support:/, ""),
          amount: payment.total_amount,
          currency: payment.currency,
          charge: payment.telegram_payment_charge_id,
        });
      } else if (privateChat && !callback && message.refunded_payment) {
        const payment = message.refunded_payment;
        result = await apply("refunded", {
          amount: payment.total_amount,
          currency: payment.currency,
          charge: payment.telegram_payment_charge_id,
        });
      } else if (callback) {
        const action = String(callback.data ?? "");
        if (
          privateChat &&
          ["idea", "bug", "question", "donation"].includes(action)
        ) {
          result = await apply("session", { mode: action });
        } else if (admin && ["working", "closed"].includes(action)) {
          result = await apply("status", {
            status: action,
            chat_id: chatId,
            reply_to: message.message_id,
          });
        } else {
          await services.telegram("answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "Недостаточно прав или кнопка недоступна.",
          });
          return Response.json({ ok: true });
        }
        await services.telegram("answerCallbackQuery", {
          callback_query_id: callback.id,
        });
      } else if (privateChat) {
        if (["/start", "/cancel", "/menu"].includes(command)) {
          result = await apply("start");
        } else if (command === "/my") result = await apply("mine");
        else if (command === "/support") {
          result = await apply("session", { mode: "donation" });
        } else if (command === "/paysupport") {
          result = await apply("session", { mode: "question" });
          await say(
            `${prefix}:payment-help`,
            actor,
            "Опишите вопрос об оплате или возврате. Если есть номер обращения или счёта, добавьте его. Не присылайте данные банковской карты.",
          );
        } else if (command === "/terms") {
          await say(prefix, actor, donationTerms);
        } else if (command === "/privacy") {
          await say(
            prefix,
            actor,
            "Бот сохраняет Telegram ID, имя, имя пользователя, обращения и сведения о поддержке в Stars. " +
              "Текст и вложения обращений передаются администраторам группы обратной связи. " +
              "Не отправляйте пароли и платёжные данные. Запросить удаление данных можно сообщением через «Задать вопрос».",
          );
        } else if (command.startsWith("/")) {
          await say(
            prefix,
            actor,
            "Откройте меню: /start. Ваши обращения: /my. Отмена ввода: /cancel.",
          );
        } else if (text || message.photo?.length) {
          result = await apply("input", {
            text,
            name: [sender.first_name, sender.last_name].filter(Boolean).join(
              " ",
            ),
            username: sender.username ?? null,
            message_id: message.message_id,
            attachment: !!message.photo?.length,
          });
        } else {await say(
            prefix,
            actor,
            "Отправьте текст или фотографию с описанием. Отменить: /cancel.",
          );}
      } else if (admin && !callback) {
        if (command === "/inbox") result = await apply("inbox");
        else if (command === "/refund") {
          result = await apply("refund", {
            order: text.trim().split(/\s+/)[1] ?? "",
          });
        } else if (message.reply_to_message && text) {
          result = await apply("reply", {
            chat_id: chatId,
            reply_to: message.reply_to_message.message_id,
            text,
          });
        }
      }

      if (result) {
        const t = result.ticket;
        switch (result.kind) {
          case "menu":
            await say(
              prefix,
              actor,
              "Связь со штабом DogWars 🐾\nОставьте идею, сообщите об ошибке или задайте вопрос. Ответ придёт сюда.\nВаши обращения: /my",
              { reply_markup: menu },
            );
            break;
          case "prompt":
            await say(
              prefix,
              actor,
              result.mode === "donation"
                ? `${donationTerms}\n\nВведите целое количество ⭐. Отменить: /cancel.`
                : "Отправьте обращение одним сообщением: текст до 3000 символов или фотография с описанием. Отменить: /cancel.",
            );
            break;
          case "ticket": {
            const key = `ticket:${t.id}`;
            await say(
              `${key}:group`,
              config.groupId,
              `Обращение #${t.id} · ${labels[t.category]}\n${t.display_name}${
                t.username ? ` (@${t.username})` : ""
              }\n\n${
                t.body || "(фотография без подписи)"
              }\n\nОтветьте на это сообщение текстом, чтобы связаться с автором.`,
              { reply_markup: ticketButtons },
              t.id,
              "ticket",
            );
            if (t.attachment) {
              await enqueue(
                `${key}:photo`,
                "copyMessage",
                {
                  chat_id: config.groupId,
                  from_chat_id: t.user_id,
                  message_id: t.source_message_id,
                  caption: `Вложение к обращению #${t.id}`,
                  reply_markup: ticketButtons,
                },
                t.id,
                "ticket",
              );
            }
            await say(
              `${key}:ack`,
              actor,
              `Обращение #${t.id} принято. Ответ придёт в этот чат. Спасибо!`,
              { reply_markup: menu },
            );
            break;
          }
          case "list":
            await say(
              prefix,
              chatId,
              result.tickets.length
                ? result.tickets.map((x: Obj) =>
                  `#${x.id} · ${labels[x.category]} · ${statuses[x.status]}`
                ).join("\n")
                : "Обращений пока нет.",
            );
            break;
          case "reply":
            await say(
              `${prefix}:answer`,
              t.user_id,
              `Ответ на обращение #${t.id}:\n\n${result.text}`,
            );
            await say(
              `${prefix}:ack`,
              config.groupId,
              `Ответ на #${t.id} сохранён для доставки автору.`,
            );
            break;
          case "status":
            await say(
              `${prefix}:user`,
              t.user_id,
              `Обращение #${t.id}: ${statuses[t.status]}.`,
            );
            await say(
              `${prefix}:group`,
              config.groupId,
              `#${t.id}: ${statuses[t.status]}.`,
            );
            break;
          case "invoice": {
            const d = result.order;
            await enqueue(`invoice:${d.id}`, "sendInvoice", {
              chat_id: actor,
              title: "Поддержать разработчика",
              description:
                "Добровольная поддержка DogWars. Без игровых преимуществ. Вопросы и возвраты: /paysupport.",
              payload: `support:${d.id}`,
              provider_token: "",
              currency: "XTR",
              prices: [{ label: "Поддержка разработки", amount: d.stars }],
            });
            break;
          }
          case "paid":
            await say(
              `paid:${result.order_id}:thanks`,
              actor,
              `Спасибо за поддержку: ${result.stars} ⭐ ❤️\nСчёт: ${result.order_id}\nВопросы об оплате: /paysupport`,
              { reply_markup: menu },
            );
            await say(
              `paid:${result.order_id}:admin`,
              config.groupId,
              `❤️ Получена поддержка: ${result.stars} ⭐\nСчёт: ${result.order_id}\nДля возврата: /refund ${result.order_id}`,
            );
            break;
          case "refund":
            await enqueue(`refund:${result.order.id}`, "refundStarPayment", {
              user_id: result.order.user_id,
              telegram_payment_charge_id: result.order.charge_id,
            });
            await say(
              prefix,
              chatId,
              "Запрос возврата сохранён. Итоговое состояние смотрите в таблице donations; при ошибке запрос останется в очереди.",
            );
            break;
          case "refund_unavailable":
            await say(
              prefix,
              chatId,
              "Оплаченный невозвращённый счёт с таким номером не найден.",
            );
            break;
          case "unmapped":
            await say(
              prefix,
              chatId,
              "Ответьте на исходное сообщение бота с обращением или его фотографию.",
            );
            break;
          case "text_error":
            await say(
              prefix,
              chatId,
              "Нужен текст до 3000 символов либо фотография с описанием.",
            );
            break;
          case "amount_error":
            await say(
              prefix,
              actor,
              "Введите целое число от 1 до 10 000 — количество ⭐. Отменить: /cancel.",
            );
            break;
          case "rate_limit":
            await say(
              prefix,
              actor,
              "Подождите 10 секунд перед следующим обращением, затем отправьте его снова.",
            );
            break;
        }
      }
      await drain(services);
      return Response.json({ ok: true });
    } catch {
      console.error(
        "Feedback operation failed; Telegram can retry the update.",
      );
      return new Response("Temporary failure", { status: 500 });
    }
  };
}
