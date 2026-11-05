// Геометрия не зависит от интерфейса или GPS: её можно проверять обычными тестами Node.
// Turf использует порядок [долгота, широта], карта — {latitude, longitude}.
import { area, difference, distance, featureCollection, kinks, point, polygon } from '@turf/turf';

export const CLOSURE_METERS = 5;
export const MAX_ACCURACY_METERS = 15;
export const MIN_AREA_METERS = 25;

export const toCoordinates = (p) => [p.longitude, p.latitude];
export function metersBetween(a, b) {
  return distance(point(toCoordinates(a)), point(toCoordinates(b)), { units: 'meters' });
}

export function routeLength(route) {
  return route.slice(1).reduce((sum, p, i) => sum + metersBetween(route[i], p), 0);
}

// Причина отказа возвращается данными, чтобы интерфейс мог объяснить её человеку.
export function validateRoute(route) {
  if (route.length < 4) return { ok: false, message: 'Пройдите маршрут: нужно хотя бы три разные точки и возврат к старту.' };
  const gap = metersBetween(route[0], route.at(-1));
  if (gap > CLOSURE_METERS) return { ok: false, message: `До старта ${Math.ceil(gap)} м. Подойдите на расстояние не больше 5 м.` };
  const ring = route.map(toCoordinates);
  // Замыкаем остаточный зазор прямым отрезком длиной не больше 5 м.
  if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push([...ring[0]]);
  const shape = polygon([ring]);
  if (kinks(shape).features.length) return { ok: false, message: 'Маршрут пересекает сам себя. Начните новую прогулку с простым контуром.' };
  const squareMeters = area(shape);
  if (squareMeters < MIN_AREA_METERS) return { ok: false, message: 'Площадь слишком мала. Обойдите участок площадью хотя бы 25 м².' };
  return { ok: true, shape, squareMeters };
}

// Каждый прежний участок обрезается новым контуром. Turf сохраняет отверстия и
// отдельные островки (MultiPolygon), поэтому перезахват не теряет сложную геометрию.
export function captureTerritory(territories, route, petId, id, createdAt) {
  const result = validateRoute(route);
  if (!result.ok) throw new Error(result.message);
  const remaining = territories.flatMap((territory) => {
    const rest = difference(featureCollection([territory.shape, result.shape]));
    return rest ? [{ ...territory, shape: rest }] : [];
  });
  return [...remaining, { id, petId, createdAt, shape: result.shape }];
}

// Один и тот же фильтр используется настоящим трекером и тестами.
export function acceptPosition(previous, candidate) {
  if (!Number.isFinite(candidate.latitude) || !Number.isFinite(candidate.longitude) ||
      Math.abs(candidate.latitude) > 90 || Math.abs(candidate.longitude) > 180 ||
      !Number.isFinite(candidate.accuracy) || candidate.accuracy < 0 ||
      candidate.accuracy > MAX_ACCURACY_METERS) return false;
  return !previous || metersBetween(previous, candidate) >= 1;
}
