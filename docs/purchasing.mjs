// Предварительная сферическая площадь. Окончательную площадь WGS84, стоимость,
// свободность участка и списание независимо проверяет сервер PostGIS.
import { formatBones, fullBones, setBonesText } from "./numbers.mjs?v=0.8.0";
export function estimateArea(points) {
  if (points.length < 3) return 0;
  const rad = Math.PI / 180;
  return Math.abs(points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length];
    return sum + (q.longitude - p.longitude) * rad *
        (2 + Math.sin(p.latitude * rad) + Math.sin(q.latitude * rad));
  }, 0)) * 6371008.8 ** 2 / 2;
}

export function createPurchasing(
  { map, api, context, onModeChange, onPurchased, message },
) {
  const $ = (id) => document.getElementById(id);
  const layer = L.layerGroup().addTo(map);
  let enabled = false,
    vertices = [],
    quote = null,
    revision = 0,
    timer,
    requestId = null;
  const format = (n) =>
    Number(n).toLocaleString(
      "ru-RU",
      Number(n) > 0 && Number(n) < .01
        ? { maximumSignificantDigits: 3 }
        : { maximumFractionDigits: 2 },
    );

  function refresh() {
    const s = context();
    const available = s.config?.features?.purchases;
    $("purchase-start").disabled = !s.connected || !available || s.busy ||
      Boolean(s.walk || s.live);
    $("purchase-start").hidden = enabled;
    $("purchase-panel").hidden = !enabled;
    $("purchase-note").textContent = available
      ? `Отметьте участок точками на карте. 1 м² новой площади = 10 🦴. Итог округляется вверх до целой 🦴. ${
        s.config.features.unlimitedPurchases &&
          s.config.features.mergeOwnPurchases
          ? `Ограничений по площади и радиусу покупки нет. Свои территории можно расширять и объединять. ${
            s.config.features.foreignBuyouts
              ? "Чужую землю можно выкупить: 10% её стоимости получат прежние владельцы."
              : "Для выкупа чужой земли обновите сервер до v.0.7.1."
          }`
          : "Для покупки без ограничения площади и объединения своих участков обновите сервер до v.0.7."
      }`
      : "Покупка участков станет доступна после обновления сервера.";
    $("purchase-confirm").disabled = s.busy || !quote?.affordable;
    if (quote) {
      setBonesText($("purchase-confirm"), quote.cost, "Купить за ", " 🦴");
    } else $("purchase-confirm").textContent = "Купить участок";
    $("purchase-undo").disabled = s.busy || !vertices.length;
    $("purchase-clear").disabled = s.busy || !vertices.length;
    $("purchase-cancel").disabled = s.busy;
    for (const marker of layer.getLayers()) {
      if (marker.dragging) {
        s.busy ? marker.dragging.disable() : marker.dragging.enable();
      }
    }
  }
  function mode(value) {
    enabled = value;
    map.getContainer().classList.toggle("purchasing", value);
    if (!value) {
      clearTimeout(timer);
      revision++;
      vertices = [];
      quote = null;
      requestId = null;
      layer.clearLayers();
    }
    onModeChange(value);
    refresh();
  }
  function draw() {
    layer.clearLayers();
    if (vertices.length > 1) {
      L.polygon(vertices.map((p) => [p.latitude, p.longitude]), {
        color: "#ccd7e8",
        fillOpacity: .2,
        dashArray: "6 4",
        interactive: false,
      }).addTo(layer);
    }
    vertices.forEach((p, i) => {
      const label = document.createElement("span");
      label.textContent = String(i + 1);
      const marker = L.marker([p.latitude, p.longitude], {
        draggable: true,
        icon: L.divIcon({
          html: label,
          className: "purchase-point",
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
      }).addTo(layer);
      marker.on("dragend", () => {
        const point = marker.getLatLng();
        vertices[i] = { latitude: point.lat, longitude: point.lng };
        changed();
      });
    });
  }
  function changed() {
    clearTimeout(timer);
    quote = null;
    requestId = crypto.randomUUID();
    const current = ++revision;
    draw();
    refresh();
    $("purchase-status").textContent = vertices.length < 3
      ? `Поставьте минимум 3 точки. Сейчас: ${vertices.length}. Точки можно перетаскивать.`
      : `Предварительно ≈${
        format(estimateArea(vertices))
      } м². Проверяем площадь, цену и владельцев…`;
    if (vertices.length < 3) return;
    timer = setTimeout(async () => {
      try {
        const result = await api("/api/purchases/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vertices }),
        });
        if (current !== revision || !enabled) return;
        quote = result;
        $("purchase-status").textContent = `Добавится ${
          format(result.area)
        } м² · ${formatBones(result.cost)} 🦴. ${
          result.affordable
            ? result.merged
              ? `Свой участок объединится с покупкой. Общая площадь: ${
                format(result.totalArea)
              } м².`
              : Number(result.foreignArea) > 0
              ? "Территория будет выкуплена."
              : "Участок свободен."
            : `Недостаточно 🦴. Ваш баланс: ${formatBones(result.balance)}.`
        }`;
        if (Number(result.foreignArea) > 0) {
          $("purchase-status").textContent += ` Выкупается чужая площадь: ${
            format(result.foreignArea)
          } м², владельцев: ${result.ownersCount}. Репарации включены в цену.`;
        }
        $("purchase-status").title = `Стоимость: ${
          fullBones(result.cost)
        } 🦴. Баланс: ${fullBones(result.balance)} 🦴.`;
        refresh();
      } catch (e) {
        if (current === revision && enabled) {
          $("purchase-status").textContent = e.message;
          refresh();
        }
      }
    }, 450);
  }
  map.on("click", (e) => {
    if (!enabled || context().busy) return;
    if (vertices.length >= 100) {
      message("Не больше 100 точек участка.");
      return;
    }
    vertices.push({ latitude: e.latlng.lat, longitude: e.latlng.lng });
    changed();
  });
  $("purchase-start").addEventListener("click", () => {
    if (!context().pet) {
      message("Сначала создайте досье питомца.");
      return;
    }
    mode(true);
    changed();
    map.getContainer().scrollIntoView({ block: "center", behavior: "smooth" });
  });
  $("purchase-undo").addEventListener("click", () => {
    vertices.pop();
    changed();
  });
  $("purchase-clear").addEventListener("click", () => {
    vertices = [];
    changed();
  });
  $("purchase-cancel").addEventListener("click", () => mode(false));
  $("purchase-confirm").addEventListener("click", async () => {
    if (
      context().busy || !quote?.affordable ||
      !confirm(
        `Добавить ${format(quote.area)} м² за ${fullBones(quote.cost)} 🦴?${
          Number(quote.foreignArea) > 0
            ? " Владельцы выкупаемой земли получат 10% стоимости своих частей, без доплаты с вашей стороны."
            : ""
        }${
          quote.merged
            ? " Свои территории будут объединены; уже принадлежащая вам площадь не оплачивается повторно."
            : ""
        }`,
      )
    ) return;
    const s = context();
    s.busy = true;
    document.body.classList.add("busy");
    refresh();
    try {
      const receipt = await api("/api/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vertices, requestId, maxCost: quote.cost }),
      });
      mode(false);
      message(
        `Добавлено ${format(receipt.area)} м² за ${
          formatBones(receipt.cost)
        } 🦴.${receipt.merged ? " Свои территории объединены." : ""}`,
      );
      try {
        await onPurchased();
      } catch {
        message("Участок куплен. Обновите карту, чтобы увидеть изменения.");
      }
    } catch (e) {
      // Номер покупки сохраняется при сетевой ошибке: повтор не спишет 🦴 ещё раз.
      $("purchase-status").textContent =
        `${e.message} Можно повторить ту же покупку.`;
    } finally {
      s.busy = false;
      document.body.classList.remove("busy");
      onModeChange(enabled);
      refresh();
    }
  });
  return { refresh };
}
