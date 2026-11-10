// Сообщение хранится вместе с выплатой и доступно даже при сбое Telegram.
export function createNotifications({ api, context, sync }) {
  const $ = (id) => document.getElementById(id);
  let current = [], loading = null;
  function render() {
    $("open-notifications").hidden = !context().connected ||
      !context().config?.features?.notifications;
  }
  function accept(result) {
    current = result.notifications;
    $("open-notifications").textContent = `Уведомления${
      result.unread ? ` · ${result.unread}` : ""
    }`;
    const fragment = document.createDocumentFragment();
    for (const note of current) {
      const item = document.createElement("article"),
        text = document.createElement("p"),
        time = document.createElement("time");
      item.className = note.read ? "" : "unread";
      text.textContent = note.message;
      time.textContent = new Date(note.createdAt * 1000).toLocaleString(
        "ru-RU",
      );
      item.append(time, text);
      fragment.append(item);
    }
    $("notifications-list").replaceChildren(fragment);
    $("notifications-status").textContent = current.length
      ? ""
      : "Уведомлений пока нет.";
    $("notifications-read").disabled = !current.some((n) => !n.read);
  }
  async function refresh() {
    render();
    if ($("open-notifications").hidden) return;
    if (context().config?.features?.efficientSync) return sync();
    if (loading) return loading;
    loading = (async () => {
      try {
        const result = await api("/api/notifications");
        accept(result);
      } catch (e) {
        $("notifications-status").textContent = e.message;
      }
    })();
    try {
      await loading;
    } finally {
      loading = null;
    }
  }
  $("open-notifications").addEventListener("click", () => {
    $("notifications-dialog").showModal();
    void refresh();
  });
  $("close-notifications").addEventListener(
    "click",
    () => $("notifications-dialog").close(),
  );
  $("notifications-read").addEventListener("click", async () => {
    $("notifications-read").disabled = true;
    try {
      await api("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: current.filter((n) => !n.read).map((n) => n.id),
        }),
      });
      await refresh();
    } catch (e) {
      $("notifications-status").textContent = e.message;
      $("notifications-read").disabled = false;
    }
  });
  setInterval(() => {
    if (!document.hidden && !context().config?.features?.efficientSync) {
      void refresh();
    }
  }, 30000);
  return { refresh, render, accept };
}
