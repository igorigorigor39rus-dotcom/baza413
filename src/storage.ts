import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SavedData } from './types';

const KEY = 'baza413:v1';
export async function loadData(): Promise<SavedData> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return { version: 1, pet: null, territories: [] };
  const value = JSON.parse(raw);
  // Не перезаписываем неизвестную версию или повреждённые данные пустым профилем.
  if (value.version !== 1 || !Array.isArray(value.territories) ||
    (value.pet !== null && (!value.pet || typeof value.pet.id !== 'string' || typeof value.pet.name !== 'string' ||
      typeof value.pet.age !== 'string' || typeof value.pet.description !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.pet.color)))) {
    throw new Error('Не удалось прочитать сохранённый профиль. Данные оставлены без изменений.');
  }
  for (const t of value.territories) {
    if (typeof t.id !== 'string' || typeof t.petId !== 'string' || !t.shape || t.shape.type !== 'Feature' ||
      !['Polygon', 'MultiPolygon'].includes(t.shape.geometry?.type)) throw new Error('Не удалось прочитать территории. Данные оставлены без изменений.');
    const polygons = t.shape.geometry.type === 'Polygon' ? [t.shape.geometry.coordinates] : t.shape.geometry.coordinates;
    if (!Array.isArray(polygons) || !polygons.length || !polygons.every((p: unknown) => Array.isArray(p) && p.length && p.every((r: unknown) =>
      Array.isArray(r) && r.length >= 4 && r.every((c: unknown) => Array.isArray(c) && c.length >= 2 &&
        Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90) &&
      r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1]))) throw new Error('Повреждена геометрия территорий. Данные оставлены без изменений.');
  }
  return value;
}

export async function saveData(data: SavedData) {
  // Сначала запись, затем обновление экрана: ошибка диска не выглядит успешным сохранением.
  await AsyncStorage.setItem(KEY, JSON.stringify(data));
}
