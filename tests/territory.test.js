import test from 'node:test';
import assert from 'node:assert/strict';
import { area, intersect, featureCollection } from '@turf/turf';
import { acceptPosition, captureTerritory, metersBetween, routeLength, validateRoute } from '../src/domain/territory.js';

const p = (longitude, latitude) => ({ longitude, latitude, accuracy: 3, timestamp: Date.now() });
const rect = (x1 = 20, y1 = 54, x2 = 20.002, y2 = 54.002) => [p(x1,y1), p(x2,y1), p(x2,y2), p(x1,y2), p(x1,y1)];
const territory = (route, id = 'old') => ({ id, petId: 'neighbor', createdAt: '2026-01-01', shape: validateRoute(route).shape });
const capture = (lands, route) => captureTerritory(lands, route, 'my-pet', 'new', '2026-11-05');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.1, `${actual} != ${expected}`);

test('замкнутый контур имеет площадь и длину', () => {
  const route = rect(); const result = validateRoute(route);
  assert.equal(result.ok, true); assert.ok(result.squareMeters > 10000);
  assert.ok(routeLength(route) > 600); assert.equal(metersBetween(route[0], route.at(-1)), 0);
});
test('зазор меньше 5 м замыкается дополнительным отрезком', () => {
  const route = rect(); route[4] = p(20, 54.00003);
  const result = validateRoute(route); assert.equal(result.ok, true);
  assert.deepEqual(result.shape.geometry.coordinates[0][0], result.shape.geometry.coordinates[0].at(-1));
});
test('открытый маршрут не даёт территорию', () => {
  const route = rect().slice(0,4);
  assert.equal(validateRoute(route).ok, false);
  assert.throws(() => capture([], route), /До старта/);
});
test('точек недостаточно, линия и крошечный участок отклоняются', () => {
  assert.equal(validateRoute([p(20,54)]).ok, false);
  assert.equal(validateRoute([p(20,54),p(20.001,54),p(20.002,54),p(20,54)]).ok, false);
  assert.equal(validateRoute(rect(20,54,20.00001,54.00001)).ok, false);
});
test('самопересечение не даёт захватить площадь', () => {
  const bow = [p(20,54),p(20.002,54.002),p(20,54.002),p(20.002,54),p(20,54)];
  const result = validateRoute(bow); assert.equal(result.ok, false); assert.match(result.message, /пересекает/);
});
test('свободная территория получает владельца', () => {
  const result = capture([],rect()); assert.equal(result.length,1);
  assert.equal(result[0].petId, 'my-pet'); assert.equal(result[0].id, 'new');
});
test('перезахват вырезает только пересечение и сохраняет прежние данные неизменными', () => {
  const old = territory(rect()); const before = JSON.stringify(old);
  const route = rect(20.001,54.001,20.003,54.003);
  const overlap = intersect(featureCollection([old.shape, validateRoute(route).shape]));
  const result = capture([old],route);
  assert.equal(result.length,2); near(area(result[0].shape),area(old.shape)-area(overlap));
  assert.equal(intersect(featureCollection(result.map(t => t.shape))), null);
  assert.equal(JSON.stringify(old), before);
});
test('полностью перекрытый участок удаляется', () => {
  const result = capture([territory(rect())],rect(19.999,53.999,20.003,54.003));
  assert.equal(result.length,1); assert.equal(result[0].petId,'my-pet');
});
test('внутренний захват оставляет отверстие в прежней территории', () => {
  const result = capture([territory(rect())],rect(20.0005,54.0005,20.0015,54.0015));
  assert.equal(result[0].shape.geometry.type,'Polygon');
  assert.equal(result[0].shape.geometry.coordinates.length,2);
  near(result.reduce((sum,t) => sum + area(t.shape),0),area(validateRoute(rect()).shape));
});
test('сквозной захват разделяет участок на два островка', () => {
  const result = capture([territory(rect())],rect(20.0008,53.999,20.0012,54.003));
  assert.equal(result[0].shape.geometry.type,'MultiPolygon');
  assert.equal(result[0].shape.geometry.coordinates.length,2);
  // Последующий захват поддерживает и MultiPolygon, а не только простой контур.
  assert.doesNotThrow(() => capture(result,rect(19.999,53.999,20.004,54.004)));
});
test('далёкий участок сохраняется с той же площадью', () => {
  const old = territory(rect()); const result = capture([old],rect(21,55,21.002,55.002));
  near(area(result[0].shape),area(old.shape));
});
test('GPS отбрасывает плохую точность, неверные координаты и неподвижный шум', () => {
  assert.equal(acceptPosition(undefined,p(20,54)),true);
  for (const bad of [{ ...p(20,54), accuracy: 16 }, { ...p(20,54), accuracy: Infinity }, p(181,54), p(20,91), p(NaN,54)]) {
    assert.equal(acceptPosition(undefined,bad),false);
  }
  assert.equal(acceptPosition(p(20,54),p(20.000001,54)),false);
  assert.equal(acceptPosition(p(20,54),p(20.001,54)),true);
});
