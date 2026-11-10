// Категорию и ограничения возвращает сервер. Клиент только показывает их.
export function createChat({ api, context, message, sync }) {
  const $ = (id) => document.getElementById(id);
  const drafts = { district: "", city: "", world: "" };
  let channel = "district",
    generation = 0,
    loading = false,
    sending = false,
    canPost = false;
  let history = [], cursor = "0", revision = null;
  let transportError = null;
  const labels = {
    district: "Район · 2 км",
    city: "Город · 20 км",
    world: "Мир",
  };
  function controls() {
    $("chat-world-note").hidden = channel !== "world";
    $("chat-text").setAttribute(
      "aria-describedby",
      channel === "world" ? "chat-world-note chat-access" : "chat-access",
    );
    for (const room of Object.keys(labels)) {
      const button = $(`chat-${room}`);
      button.setAttribute("aria-selected", String(channel === room));
      button.disabled = sending;
    }
    $("send-chat").disabled = sending || !canPost;
    $("chat-text").disabled = !canPost;
  }
  function request() {
    if (!$("chat-dialog").open) return null;
    return { channel, generation, after: cursor, context: revision };
  }
  function accept(data, sent) {
    if (
      !sent || sent.channel !== channel || sent.generation !== generation ||
      !$("chat-dialog").open
    ) return;
    if (transportError && $("chat-error").textContent === transportError) {
      $("chat-error").textContent = "";
    }
    transportError = null;
    const room = sent.channel;
    const managed = context().config?.features?.efficientSync;
    if (!managed || data.reset || !data.canRead || data.context !== revision) {
      history = [];
    }
    const known = new Map(history.map((item) => [item.id, item]));
    for (const item of data.messages) known.set(item.id, item);
    history = [...known.values()].sort((a, b) =>
      BigInt(a.id) < BigInt(b.id) ? -1 : 1
    ).slice(-100);
    cursor = history.at(-1)?.id ?? "0";
    revision = data.context ?? null;
    const same = managed && !data.reset && data.messages.length === 0 &&
      data.canRead && history.length > 0;
    canPost = data.canPost === true;
    $("chat-access").textContent = data.reason ||
      (room === "world"
        ? "Мировой чат. Писать могут владельцы от 1 000 000 м²."
        : `Участники в пределах ${
          room === "district" ? "2" : "20"
        } км между ориентирами крупнейших участков. При изменении территорий круг общения обновляется.`);
    if (same) {
      loading = false;
      controls();
      return;
    }
    const box = $("chat-messages"),
      bottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40,
      fragment = document.createDocumentFragment();
    for (const item of history) {
      const row = document.createElement("article"),
        head = document.createElement("strong"),
        text = document.createElement("p"),
        time = document.createElement("time");
      head.textContent = item.pet?.name ?? "Генерал";
      text.textContent = item.text;
      time.textContent = new Date(Number(item.createdAt) * 1000)
        .toLocaleString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
          day: "2-digit",
          month: "2-digit",
        });
      row.append(head, time, text);
      fragment.append(row);
    }
    if (!history.length) {
      const text = document.createElement("p");
      text.textContent = data.canRead
        ? "Пока тихо. Сообщений в этой категории нет."
        : "Здесь появятся сообщения после получения своей территории.";
      fragment.append(text);
    }
    if (!same) box.replaceChildren(fragment);
    if (bottom) box.scrollTop = box.scrollHeight;
    loading = false;
    controls();
  }
  async function refresh(force = false) {
    if (!$("chat-dialog").open || document.hidden || (loading && !force)) {
      return;
    }
    if (!context().config?.features?.geoChat) {
      canPost = false;
      $("chat-access").textContent =
        "Для категорий чата обновите сервер до v.0.9.";
      controls();
      return;
    }
    if (context().config?.features?.efficientSync) return sync();
    loading = true;
    const request = ++generation, room = channel;
    try {
      const data = await api(`/api/chat?channel=${room}`);
      if (request !== generation) return;
      accept(data, { channel: room, generation: request });
    } catch (e) {
      if (request === generation) {
        canPost = false;
        $("chat-error").textContent = e.message;
      }
    } finally {
      if (request === generation) {
        loading = false;
        controls();
      }
    }
  }
  for (const room of Object.keys(labels)) {
    $(`chat-${room}`).addEventListener("click", () => {
      if (sending || room === channel) {
        return;
      }
      drafts[channel] = $("chat-text").value;
      channel = room;
      generation++;
      history = [];
      cursor = "0";
      revision = null;
      $("chat-text").value = drafts[channel];
      canPost = false;
      $("chat-error").textContent = "";
      $("chat-access").textContent = "Проверяем доступ…";
      $("chat-messages").replaceChildren();
      controls();
      void refresh(true);
    });
  }
  $("open-chat").addEventListener("click", () => {
    if (!context().connected) {
      message("Откройте приложение через кнопку карты в Telegram-боте.");
      return;
    }
    if (!context().pet) channel = "world";
    generation++;
    history = [];
    cursor = "0";
    revision = null;
    canPost = false;
    $("chat-error").textContent = "";
    $("chat-access").textContent = "Загружаем чат…";
    $("chat-dialog").showModal();
    controls();
    void refresh(true);
  });
  $("close-chat").addEventListener("click", () => {
    $("chat-dialog").close();
    generation++;
    loading = false;
  });
  $("chat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending || !canPost) return;
    sending = true;
    controls();
    try {
      await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: $("chat-text").value, channel }),
      });
      $("chat-text").value = "";
      $("chat-error").textContent = "Сообщение передано.";
      await refresh(true);
    } catch (e) {
      $("chat-error").textContent = e.message;
      await refresh(true);
    } finally {
      sending = false;
      controls();
    }
  });
  setInterval(() => {
    if (!context().config?.features?.efficientSync) void refresh();
  }, 10000);
  return {
    request,
    accept,
    isOpen: () => $("chat-dialog").open,
    reportError(text) {
      if (!$("chat-dialog").open) return;
      transportError = text;
      $("chat-error").textContent = text;
      canPost = false;
      controls();
    },
  };
}
