import { polygon } from '@turf/turf';
import type { Pet, Position, Territory } from './types';

export const DEMO_CENTER = { latitude: 54.7104, longitude: 20.4522, latitudeDelta: 0.005, longitudeDelta: 0.005 };
export const DEMO_PET: Pet = { id: 'demo-neighbor', name: 'Бублик', age: '3', description: 'Вымышленный сосед для проверки перезахвата.', color: '#E9A33B' };
export const DEMO_ROUTE: Position[] = [
  [20.4510, 54.7100], [20.4530, 54.7100], [20.4530, 54.7110], [20.4510, 54.7110], [20.4510, 54.7100],
].map(([longitude, latitude], i) => ({ longitude, latitude, accuracy: 3, timestamp: i * 60000 }));
export function demoTerritories(): Territory[] {
  return [{ id: 'demo-land', petId: DEMO_PET.id, createdAt: new Date(0).toISOString(), shape: polygon([[
    [20.4520, 54.7103], [20.4540, 54.7103], [20.4540, 54.7113], [20.4520, 54.7113], [20.4520, 54.7103],
  ]]) }];
}
