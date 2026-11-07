// Доход хранится дробным: на баланс поступают только завершённые 24 часа.
// Расчёт используется в тестовых примерах; рабочие кошельки считает Supabase.
export const DAY_SECONDS = 86400;
export function dailyWallet(wallet, sqm, now) {
  const w = { ...wallet };
  now = Math.max(now, w.asOf);
  const rate = Number(sqm) / 10;
  let cycle = w.incomeCycleAt ?? null,
    pending = Number(w.pending ?? 0),
    earned = 0;
  if (cycle === null && sqm > 0) cycle = w.asOf;
  if (cycle !== null) {
    const boundary = cycle + DAY_SECONDS;
    if (now < boundary) pending += rate * (now - w.asOf) / DAY_SECONDS;
    else {
      const complete = Math.floor((now - boundary) / DAY_SECONDS);
      earned = pending + rate * Math.max(0, boundary - w.asOf) / DAY_SECONDS +
        rate * complete;
      cycle = boundary + complete * DAY_SECONDS;
      pending = rate * (now - cycle) / DAY_SECONDS;
    }
  }
  return {
    ...w,
    balance: Number(w.balance) + earned,
    rate,
    asOf: now,
    pending,
    incomeCycleAt: cycle,
    nextPayoutAt: cycle === null ? null : cycle + DAY_SECONDS,
    incomePeriodSeconds: DAY_SECONDS,
    sqmPerBone: 10,
  };
}
export function formatDailyRate(rate) {
  const value = Number(rate);
  return Number.isFinite(value)
    ? value > 0 && value < .01
      ? "<0,01"
      : value.toLocaleString("ru-RU", { maximumFractionDigits: 2 })
    : "—";
}
export function payoutText(wallet) {
  if (
    !Number.isFinite(Number(wallet.nextPayoutAt)) || wallet.nextPayoutAt == null
  ) return "Первая выплата — через 24 часа после начала владения территорией.";
  const when = new Date(Number(wallet.nextPayoutAt) * 1000);
  return `Следующая выплата: ${
    when.toLocaleString("ru-RU", {
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    })
  }. Доход внутри суток учитывает время владения.`;
}
