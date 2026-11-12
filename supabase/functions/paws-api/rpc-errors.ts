// Сообщение SQL может содержать координаты, значения строк или служебные данные.
// Пользователю и журналу передаём только проверенный код и имя нашего RPC.
export type RpcFailure = { rpc: string; status: number; code: string };

export function rpcFailure(
  rpc: string,
  status: number,
  code: unknown,
): RpcFailure {
  return {
    rpc,
    status,
    code: typeof code === "string" && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(code)
      ? code
      : "UNKNOWN",
  };
}

export function rpcFailureMessage(failure: RpcFailure): string {
  const suffix = ` Код: ${failure.code}.`;
  if (["57014", "55P03", "40P01", "53300", "PGRST003"].includes(failure.code)) {
    return "База занята или обработка не уложилась в отведённое время. Проверьте «Статус» и повторите действие." +
      suffix;
  }
  if (["PGRST000", "PGRST001", "PGRST002"].includes(failure.code)) {
    return "Не удалось установить соединение с базой. Проверьте «Статус» и повторите действие." +
      suffix;
  }
  if (
    ["PGRST202", "PGRST203", "42883", "42P01", "42703"].includes(failure.code)
  ) {
    return "Ошибка серверной функции или структуры базы. Передайте разработчику код ошибки." +
      suffix;
  }
  if (failure.code === "42501") {
    return "У серверной функции недостаточно прав. Передайте разработчику код ошибки." +
      suffix;
  }
  return "Не удалось выполнить операцию с базой. Передайте разработчику код ошибки." +
    suffix;
}
