// Клиент не назначает права сам: сервер проверяет основной Telegram ID,
// одноразовое приглашение и подтверждение из второго аккаунта в боте.
export function createAccounts({ api, context }) {
  const $ = (id) => document.getElementById(id);
  let busy = false;
  function render(value) {
    const primary = value.role === "primary", linked = value.secondary;
    $("account-primary").hidden = !primary;
    $("account-state").textContent = primary
      ? linked
        ? `Привязан @${linked.username}. Общий питомец и баланс.`
        : value.pending
        ? `Ожидается подтверждение @${value.pending.username}. Приглашение действует 24 часа.`
        : "Второй аккаунт пока не привязан."
      : "Вы вошли через второй аккаунт. У вас общий питомец и баланс; привязкой управляет основной аккаунт.";
    $("account-invite").disabled = busy || Boolean(linked) || !context().pet;
    $("account-username").disabled = busy || Boolean(linked);
    $("account-remove").hidden = !primary || !linked;
    $("account-cancel").hidden = !primary || !value.pending || Boolean(linked);
  }
  async function refresh() {
    const enabled = context().config?.features?.sharedPet;
    $("account-settings").hidden = !enabled;
    if (!enabled) return;
    try {
      render(await api("/api/accounts"));
    } catch (e) {
      $("account-status").textContent = e.message;
    }
  }
  async function change(path, method, body) {
    if (busy) return;
    busy = true;
    for (const id of ["account-invite", "account-remove", "account-cancel"]) {
      $(id).disabled = true;
    }
    $("account-status").textContent = "Проверяем…";
    try {
      const result = await api(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      $("account-share").hidden = !result.url;
      $("account-invite-url").value = result.url ?? "";
      $("account-status").textContent = result.url
        ? "Отправьте ссылку второму аккаунту и подтвердите привязку в боте."
        : "Готово.";
      render(result);
    } catch (e) {
      $("account-status").textContent = e.message;
    } finally {
      busy = false;
      for (const id of ["account-invite", "account-remove", "account-cancel"]) {
        $(id).disabled = false;
      }
      await refresh();
    }
  }
  $("account-invite").addEventListener(
    "click",
    () =>
      change("/api/accounts/invite", "POST", {
        username: $("account-username").value,
      }),
  );
  $("account-cancel").addEventListener(
    "click",
    () => change("/api/accounts/invite", "DELETE"),
  );
  $("account-remove").addEventListener("click", () => {
    if (
      window.confirm(
        "Отключить второй аккаунт? Его незавершённая прогулка будет отменена.",
      )
    ) void change("/api/accounts/secondary", "DELETE");
  });
  $("account-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("account-invite-url").value);
      $("account-status").textContent = "Ссылка скопирована.";
    } catch {
      $("account-invite-url").select();
      $("account-status").textContent = "Скопируйте выделенную ссылку.";
    }
  });
  return { refresh };
}
