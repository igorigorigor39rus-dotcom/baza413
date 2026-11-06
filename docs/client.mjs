import { API_URL } from "./config.mjs?v=0.8.0";
import { createDemoApi } from "./demo.mjs?v=0.8.0";

// ?backend=python оставлен для локальных регрессионных тестов предыдущего
// сервера. GitHub Pages и Supabase не запускают Python.
export function createClient({ location, storage, clipping, fetch: send }) {
  const params = new URLSearchParams(location.search);
  const isDemo = params.get("demo") === "1";
  const isPython = params.get("backend") === "python";
  if (isDemo) {
    return { isDemo, isPython, api: createDemoApi(storage, clipping) };
  }
  return {
    isDemo,
    isPython,
    async api(path, options = {}) {
      let response;
      try {
        response = await send(isPython ? path : `${API_URL}${path}`, options);
      } catch {
        throw new Error(
          "Не удалось подключиться к Supabase. Проверьте интернет и установку функции paws-api.",
        );
      }
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error("Сервис ещё не настроен или вернул неожиданный ответ.");
      }
      if (!response.ok) {
        const error = new Error(
          typeof data.detail === "string"
            ? data.detail
            : "Не удалось выполнить запрос. Проверьте настройки Supabase.",
        );
        error.code = data.code;
        error.annulled = data.annulled === true;
        throw error;
      }
      return data;
    },
  };
}
