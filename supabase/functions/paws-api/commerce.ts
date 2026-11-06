import { ApiError } from "./auth.ts";
type RPC = (name: string, args: Record<string, unknown>) => Promise<any>;
type Bot = (
  method: string,
  payload: Record<string, unknown>,
  timeout?: number,
) => Promise<any>;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function owner(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ApiError(422, "Некорректный пользователь.");
  }
  return value;
}
function orderId(payload: unknown) {
  if (
    typeof payload !== "string" || !payload.startsWith("dw:") ||
    !UUID.test(payload.slice(3))
  ) throw new ApiError(422, "Некорректный счёт.");
  return payload.slice(3);
}
function amount(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ApiError(422, "Некорректная сумма.");
  }
  return value;
}
function invoice(order: any) {
  return {
    title: "Косточки DogWars",
    description: `Пополнение игрового баланса: ${order.bones} 🦴.`,
    payload: `dw:${order.id}`,
    provider_token: "",
    currency: "XTR",
    prices: [{ label: `${order.bones} 🦴`, amount: order.stars }],
    start_parameter: `bones_${order.id}`,
  };
}

export function createCommerce({ rpc, bot }: { rpc: RPC; bot: Bot }) {
  async function shop(user: number) {
    const catalog = await rpc("paws_star_catalog", { p_user: user });
    await bot("sendMessage", {
      chat_id: user,
      text:
        "Выберите пакет косточек. Оплата — Telegram Stars ⭐. Помощь по платежам: /paysupport",
      reply_markup: {
        inline_keyboard: catalog.packages.map((
          p: any,
        ) => [{
          text: `${p.stars} ⭐ → ${p.bones} 🦴`,
          callback_data: `shop:${p.id}`,
        }]),
      },
    });
  }
  async function webhook(update: any): Promise<boolean> {
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      try {
        await rpc("paws_star_checkout", {
          p_user: owner(q.from?.id),
          p_order: orderId(q.invoice_payload),
          p_currency: q.currency,
          p_amount: amount(q.total_amount),
          p_query: q.id,
        });
        await bot("answerPreCheckoutQuery", {
          pre_checkout_query_id: q.id,
          ok: true,
        });
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 422) throw e;
        await bot("answerPreCheckoutQuery", {
          pre_checkout_query_id: q.id,
          ok: false,
          error_message: e.message,
        });
      }
      return true;
    }
    const m = update.message;
    if (
      m?.chat?.type === "private" &&
      (m.successful_payment || m.refunded_payment)
    ) {
      const user = owner(m.chat.id),
        payment = m.successful_payment ?? m.refunded_payment;
      const charge = payment.telegram_payment_charge_id;
      if (typeof charge !== "string" || !charge || charge.length > 512) {
        throw new ApiError(422, "Некорректный платёж.");
      }
      try {
        const args = {
          p_user: user,
          p_order: orderId(payment.invoice_payload),
          p_currency: payment.currency,
          p_amount: amount(payment.total_amount),
          p_charge: charge,
        };
        const result = await rpc(
          m.successful_payment ? "paws_star_paid" : "paws_star_refunded",
          args,
        );
        if (result.credited) {
          await bot("sendMessage", {
            chat_id: user,
            text:
              `Оплата получена! На игровой баланс начислено ${result.bones} 🦴.`,
          });
        }
        if (m.refunded_payment && result.changed) {
          await bot("sendMessage", {
            chat_id: user,
            text:
              "Возврат Stars учтён. Купленные косточки отозваны; если они уже потрачены, недостающая часть погасится будущими начислениями. /paysupport — помощь.",
          });
        }
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 422) throw e;
        const issueArgs = {
          p_user: user,
          p_charge: charge,
          p_payload: String(payment.invoice_payload ?? ""),
          p_reason: e.message,
        };
        const issue = await rpc("paws_payment_issue", issueArgs);
        if (m.successful_payment && !issue.refunded) {
          try {
            await bot("refundStarPayment", {
              user_id: user,
              telegram_payment_charge_id: charge,
            });
            await rpc("paws_payment_issue", { ...issueArgs, p_refunded: true });
          } catch {
            /* Оператор видит неразрешённый платёж в payment_issues. */
          }
        }
        await bot("sendMessage", {
          chat_id: user,
          text:
            "Платёж не удалось сопоставить со счётом. Запрос на возврат сохранён. Для проверки отправьте /paysupport и описание вопроса.",
        });
      }
      return true;
    }
    const q = update.callback_query;
    if (
      q?.message?.chat?.type === "private" &&
      q.from?.id === q.message.chat.id && typeof q.data === "string" &&
      q.data.startsWith("shop:")
    ) {
      const user = owner(q.from.id), id = q.data.slice(5);
      if (!UUID.test(id)) return true;
      await bot("answerCallbackQuery", { callback_query_id: q.id });
      try {
        await rpc("paws_activity", { p_user: user });
        const order = await rpc("paws_star_order", {
          p_user: user,
          p_package: id,
          p_request: `callback:${q.id}`,
        });
        await bot("sendInvoice", { chat_id: user, ...invoice(order) });
      } catch (e) {
        if (e instanceof ApiError && e.status === 422) {
          await bot("sendMessage", { chat_id: user, text: e.message });
        } else throw e;
      }
      return true;
    }
    if (
      m?.chat?.type === "private" && m.from?.id === m.chat.id &&
      typeof m.text === "string"
    ) {
      const command = m.text.trim().split(/\s/)[0].split("@")[0],
        user = owner(m.chat.id);
      if (command === "/shop") {
        await rpc("paws_activity", { p_user: user });
        await shop(user);
        return true;
      }
      if (command === "/paysupport") {
        const text = m.text.trim().split(/\s+/).slice(1).join(" ");
        if (!text) {
          await bot("sendMessage", {
            chat_id: user,
            text:
              "Опишите вопрос о платеже после команды /paysupport. Обращение сохраняется для владельца DogWars; токены и пароли присылать не нужно.",
          });
        } else {
          const result = await rpc("paws_payment_support", {
            p_user: user,
            p_message: text,
          });
          await bot("sendMessage", {
            chat_id: user,
            text: `Обращение сохранено. Номер: ${result.id}.`,
          });
        }
        return true;
      }
    }
    return false;
  }
  async function api(path: string, user: number, body: any) {
    if (path.startsWith("/api/shop/orders/")) {
      const id = path.split("/").at(-1);
      if (!id || !UUID.test(id)) throw new ApiError(422, "Некорректный заказ.");
      return await rpc("paws_star_status", { p_user: user, p_order: id });
    }
    if (path === "/api/shop") {
      return await rpc("paws_star_catalog", { p_user: user });
    }
    if (path === "/api/shop/invoice") {
      if (
        !UUID.test(String(body.packageId)) || !UUID.test(String(body.requestId))
      ) throw new ApiError(422, "Некорректный пакет или номер заказа.");
      const order = await rpc("paws_star_order", {
        p_user: user,
        p_package: body.packageId,
        p_request: `app:${body.requestId}`,
      });
      const { start_parameter: _start, ...linkInvoice } = invoice(order);
      const link = await bot("createInvoiceLink", linkInvoice);
      if (typeof link !== "string" || !link.startsWith("https://t.me/")) {
        throw new ApiError(503, "Telegram не вернул ссылку счёта.");
      }
      return { url: link, orderId: order.id };
    }
    return undefined;
  }
  return { webhook, api };
}
