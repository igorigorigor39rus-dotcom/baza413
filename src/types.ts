import type { Feature, Polygon, MultiPolygon } from 'geojson';

export type Position = { latitude: number; longitude: number; accuracy: number; timestamp: number };
// Возраст сохраняем числом лет; серверная регистрация владельца появится отдельно.
export type Pet = { id: string; name: string; age: string; description: string; color: string; photo?: string };
export type Territory = { id: string; petId: string; createdAt: string; shape: Feature<Polygon | MultiPolygon> };
export type SavedData = { version: 1; pet: Pet | null; territories: Territory[] };
