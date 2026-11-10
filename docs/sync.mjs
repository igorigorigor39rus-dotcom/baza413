// Один последовательный цикл вместо независимых таймеров. Данные пользователя
// хранятся только в памяти вкладки, не в localStorage или общем кеше браузера.
export function mergeLive(previous, incoming) {
  if (!incoming?.walk) return { ...incoming, walk: null };
  const walk = incoming.walk, start = walk.offset, count = walk.pointCount;
  if (
    !Number.isInteger(start) || !Number.isInteger(count) || start < 0 ||
    count > 5000 || count < start || !Array.isArray(walk.points) ||
    start + walk.points.length !== count
  ) throw new Error("GPS_CURSOR");
  const reset = walk.reset || previous?.id !== walk.id;
  if ((reset && start !== 0) || (!reset && previous.points.length !== start)) {
    throw new Error("GPS_CURSOR");
  }
  const points = reset
    ? walk.points
    : (walk.points.length
      ? previous.points.concat(walk.points)
      : previous.points);
  return { ...incoming, walk: { ...walk, points } };
}

export function createSync(
  {
    api,
    enabled,
    active,
    chatRequest = () => null,
    apply,
    error = () => {},
    document: page = globalThis.document,
    timers = globalThis,
    idleMs = 60000,
    activeMs = 10000,
  },
) {
  let started = false, timer = null, flight = null, abort = null, epoch = 0;
  let again = false, failures = 0, live = null, notificationsKey = null;
  let mutations = 0, sentEpoch = -1, sentRoom = null;
  const clear = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  function schedule() {
    clear();
    if (!started || !enabled() || page.hidden) return;
    const delay = Math.min(
      120000,
      (active() ? activeMs : idleMs) * 2 ** failures,
    );
    timer = timers.setTimeout(() => {
      void refresh(false);
    }, delay);
  }
  function refresh(force = true) {
    if (!started || !enabled() || page.hidden || mutations) {
      return Promise.resolve(null);
    }
    clear();
    if (flight) {
      const room = chatRequest();
      if (
        force && (sentEpoch !== epoch || room?.channel !== sentRoom?.channel ||
          room?.generation !== sentRoom?.generation)
      ) again = true;
      return flight;
    }
    flight = (async () => {
      let last = null, repairs = 0;
      do {
        again = false;
        const generation = epoch, room = chatRequest();
        sentEpoch = generation;
        sentRoom = room;
        const body = {
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          walk: live?.id ?? null,
          after: live?.points.length ?? 0,
          notificationsKey,
          channel: room?.channel ?? null,
          chatAfter: room?.after ?? "0",
          context: room?.context ?? null,
        };
        abort = new AbortController();
        const watchdog = timers.setTimeout(() => abort?.abort(), 15000);
        try {
          const data = await api("/api/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: abort.signal,
          });
          // Ответ, начатый до списания денег или перехода в фон, не применяется.
          if (generation !== epoch || mutations) {
            again = true;
            continue;
          }
          const merged = mergeLive(live, data.live);
          live = merged.walk;
          await apply({ ...data, live: merged }, room);
          notificationsKey = data.notificationsKey;
          failures = 0;
          last = data;
        } catch (e) {
          if (generation !== epoch) {
            again = true;
            continue;
          }
          const currentRoom = chatRequest();
          if (
            again && (room?.channel !== currentRoom?.channel ||
              room?.generation !== currentRoom?.generation)
          ) continue;
          if (e.message === "GPS_CURSOR" && repairs++ === 0) {
            live = null;
            again = true;
          } else {
            failures = Math.min(failures + 1, 4);
            error(e);
            again = false;
          }
        } finally {
          timers.clearTimeout(watchdog);
          abort = null;
        }
      } while (again && started && enabled() && !page.hidden && !mutations);
      return last;
    })().finally(() => {
      flight = null;
      schedule();
    });
    return flight;
  }
  function visibility() {
    if (page.hidden) {
      clear();
      epoch++;
      abort?.abort();
    } else void refresh();
  }
  const online = () => {
    void refresh();
  };
  return {
    start() {
      if (!started) {
        started = true;
        page.addEventListener("visibilitychange", visibility);
        page.defaultView?.addEventListener("online", online);
      }
      return refresh();
    },
    refresh,
    invalidate() {
      epoch++;
      if (flight) again = true;
    },
    beginMutation() {
      mutations++;
      epoch++;
      if (flight) again = true;
    },
    endMutation() {
      mutations = Math.max(0, mutations - 1);
      epoch++;
      if (!mutations) void refresh();
    },
    stop() {
      started = false;
      epoch++;
      again = false;
      clear();
      abort?.abort();
      page.removeEventListener("visibilitychange", visibility);
      page.defaultView?.removeEventListener("online", online);
    },
  };
}
