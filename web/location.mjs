// На новых клиентах используем родной LocationManager Telegram. Если его нет
// (обычный браузер / старый Telegram), остаётся браузерный Geolocation API.
export function createLocationSource({ telegram, navigator, secureContext }) {
  const manager = telegram?.isVersionAtLeast?.("8.0")
    ? telegram.LocationManager
    : null;
  let initialization;
  const failure = () =>
    new Error(
      "Нет доступа к GPS. Разрешите геолокацию для Telegram/браузера в настройках телефона.",
    );
  function withTimeout(register) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(failure()), 20000);
      register(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
  async function nativeAvailable() {
    if (!manager) return false;
    if (!manager.isInited) {
      initialization ??= withTimeout((resolve) => manager.init(resolve)).catch(
        (error) => {
          initialization = null;
          throw error;
        },
      );
      await initialization;
    }
    return manager.isLocationAvailable;
  }
  async function getPosition() {
    if (await nativeAvailable()) {
      const location = await withTimeout((resolve, reject) =>
        manager.getLocation((value) =>
          value ? resolve(value) : reject(failure()),
        ),
      );
      return {
        coords: {
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.horizontal_accuracy ?? Infinity,
        },
        timestamp: Date.now(),
      };
    }
    if (!secureContext || !navigator.geolocation)
      throw new Error(
        "Для GPS нужен HTTPS и разрешение на геолокацию. На компьютере демо работает через localhost.",
      );
    return new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(
        resolve,
        () => reject(failure()),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
      ),
    );
  }
  // Возвращаем функцию отключения, чтобы экран не зависел от типа GPS-источника.
  async function watchPosition(success, error) {
    if (await nativeAvailable()) {
      let stopped = false,
        pending = false;
      async function poll() {
        if (stopped || pending) return;
        pending = true;
        try {
          const p = await getPosition();
          if (!stopped) success(p);
        } catch (e) {
          if (!stopped) error(e);
        } finally {
          pending = false;
        }
      }
      const timer = setInterval(poll, 2000);
      void poll();
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    }
    const identifier = navigator.geolocation.watchPosition(success, error, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    });
    return () => navigator.geolocation.clearWatch(identifier);
  }
  return { getPosition, watchPosition };
}
