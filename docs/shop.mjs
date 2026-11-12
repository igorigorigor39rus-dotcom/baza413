import { formatBones, fullBones } from "./numbers.mjs?v=1.1.4";
export function createShop({ api, context, telegram, onPaid, message }) {
  const $ = (id) => document.getElementById(id);
  let buying = false, requestId = null, selected = null;
  function render() {
    $("open-shop").hidden = !context().connected ||
      !context().config?.features?.starShop;
    $("open-shop").disabled = context().busy || Boolean(context().walk);
  }
  async function open() {
    $("shop-dialog").showModal();
    $("shop-status").textContent = "Загружаем пакеты…";
    $("shop-packages").replaceChildren();
    try {
      const catalog = await api("/api/shop");
      $("shop-status").textContent = Number(catalog.debt) > 0
        ? `Остаток по возвратам: ${
          fullBones(catalog.debt)
        } 🦴. Новые начисления сначала погашают этот остаток.`
        : "Оплата через Telegram Stars. Косточки поступят после подтверждения Telegram.";
      for (const p of catalog.packages) {
        const button = document.createElement("button");
        button.className = "secondary";
        button.type = "button";
        button.textContent = `${p.stars.toLocaleString("ru-RU")} ⭐ → ${
          formatBones(p.bones)
        } 🦴`;
        button.title = `${
          fullBones(p.bones)
        } косточек за ${p.stars} Telegram Stars`;
        button.disabled = Boolean(context().config.localDemo);
        button.addEventListener("click", async () => {
          if (buying) return;
          if (!context().pet) {
            $("shop-status").textContent = "Сначала создайте досье питомца.";
            return;
          }
          if (!telegram?.openInvoice) {
            $("shop-status").textContent =
              "Откройте приложение в актуальном Telegram или купите через /shop в чате бота.";
            return;
          }
          buying = true;
          button.disabled = true;
          if (selected !== p.id) {
            selected = p.id;
            requestId = crypto.randomUUID();
          }
          try {
            const result = await api("/api/shop/invoice", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ packageId: p.id, requestId }),
            });
            telegram.openInvoice(result.url, async (status) => {
              buying = false;
              button.disabled = false;
              requestId = null;
              selected = null;
              if (status === "paid") {
                $("shop-status").textContent =
                  "Проверяем подтверждение оплаты на сервере…";
                try {
                  for (let i = 0; i < 10; i++) {
                    const state = await api(
                      `/api/shop/orders/${result.orderId}`,
                    );
                    if (state.refunded) {
                      $("shop-status").textContent = "Платёж возвращён.";
                      return;
                    }
                    if (state.paid) {
                      await onPaid();
                      $("shop-status").textContent =
                        "Оплата подтверждена. Баланс обновлён.";
                      message("Оплата подтверждена. Баланс обновлён.");
                      return;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                  }
                  $("shop-status").textContent =
                    "Подтверждение ещё обрабатывается. Баланс обновится после получения платежа. Помощь: /paysupport";
                } catch (e) {
                  $("shop-status").textContent = e.message;
                }
              } else {$("shop-status").textContent = status === "cancelled"
                  ? "Оплата отменена. Косточки не списывались."
                  : "Проверьте статус платежа в Telegram. Помощь: /paysupport";}
            });
          } catch (e) {
            buying = false;
            button.disabled = false;
            requestId = null;
            selected = null;
            $("shop-status").textContent = e.message;
          }
        });
        $("shop-packages").append(button);
      }
    } catch (e) {
      $("shop-status").textContent = e.message;
    }
  }
  $("open-shop").addEventListener("click", () => void open());
  $("close-shop").addEventListener("click", () => $("shop-dialog").close());
  return { render };
}
