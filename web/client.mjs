import { API_URL } from "./config.mjs";
// Вход доступен только через подписанные данные Telegram. Параметры demo/backend
// больше не переключают приложение на фиктивные кошельки или локальный сервер.
export function createClient({ fetch: send }) {
  return {
    isDemo: false,
    isPython: false,
    async api(path, options = {}) {
      let response;
      try {
        response = await send(`${API_URL}${path}`, options);
      } catch {
        throw new Error(
          "Не удалось подключиться к Supabase. Проверьте интернет.",
        );
      }
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error("Сервис вернул неожиданный ответ.");
      }
      if (!response.ok) {
        const error = new Error(
          typeof data.detail === "string"
            ? data.detail
            : "Не удалось выполнить запрос.",
        );
        error.code = data.code;
        error.annulled = data.annulled === true;
        throw error;
      }
      return data;
    },
  };
}
