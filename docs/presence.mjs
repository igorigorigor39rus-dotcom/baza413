// IANA-часовой пояс берём с устройства без запроса GPS. Сервер сам считает 48 ч.
export function createPresence({ api, context, sync }) {
  const $ = (id) => document.getElementById(id);
  let last = 0, pending = false;
  function accept(result) {
    if (!result) return;
    $("reminders-enabled").checked = result.enabled;
    $("reminders-zone").textContent =
      `08:00 и 18:00 по времени устройства (${result.timezone}). Если вас нет больше 48 часов.`;
    $("reminders-status").textContent = "";
  }
  async function ping(force = false) {
    const s = context();
    $("reminders-settings").hidden = !s.config?.features?.reminders;
    if (
      !s.connected || !s.pet || !s.config?.features?.reminders ||
      document.hidden || pending || (!force && Date.now() - last < 60000)
    ) return;
    if (s.config?.features?.efficientSync) return;
    pending = true;
    last = Date.now();
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const result = await api("/api/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone }),
      });
      accept(result);
    } catch (e) {
      $("reminders-status").textContent = e.message;
    } finally {
      pending = false;
    }
  }
  $("reminders-enabled").addEventListener("change", async () => {
    const input = $("reminders-enabled");
    input.disabled = true;
    try {
      await api("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: input.checked }),
      });
      $("reminders-status").textContent = input.checked
        ? "Напоминания включены."
        : "Напоминания отключены.";
      if (context().config?.features?.efficientSync) await sync();
    } catch (e) {
      input.checked = !input.checked;
      $("reminders-status").textContent = e.message;
    } finally {
      input.disabled = false;
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void ping(true);
  });
  setInterval(() => void ping(), 60000);
  return {
    accept,
    render() {
      $("reminders-settings").hidden = !context().config?.features?.reminders;
      if (!context().config?.features?.efficientSync) void ping();
    },
  };
}
