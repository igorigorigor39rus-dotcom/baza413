// Эти небольшие функции одинаково работают в Telegram WebView и в тестах Node.
export function meters(a, b) {
  const radians = (x) => (x * Math.PI) / 180;
  const dLat = radians(b.latitude - a.latitude),
    dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function goodFix(p) {
  return (
    [p.latitude, p.longitude, p.accuracy, p.timestamp].every(Number.isFinite) &&
    Math.abs(p.latitude) <= 85 &&
    Math.abs(p.longitude) <= 180 &&
    p.accuracy >= 0 &&
    p.accuracy <= 15
  );
}
export function shouldAppend(previous, p) {
  if (!goodFix(p)) return false;
  if (!previous) return true;
  return (
    p.timestamp > previous.timestamp &&
    (meters(previous, p) >= 1 || p.timestamp - previous.timestamp >= 5)
  );
}
export function length(points) {
  return points.slice(1).reduce((sum, p, i) => sum + meters(points[i], p), 0);
}
