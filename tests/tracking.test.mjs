// Необязательные тесты браузерного фильтра: node tests/tracking.test.mjs.
import test from "node:test";
import { createLocationSource } from "../web/location.mjs";
import assert from "node:assert/strict";
import { goodFix, shouldAppend, meters, photoSize } from "../web/tracking.mjs";
const point = { longitude: 20, latitude: 54, accuracy: 3, timestamp: 100 };
test("точность GPS, координаты и неподвижный шум", () => {
  assert.equal(goodFix(point), true);
  assert.equal(goodFix({ ...point, accuracy: 20.001 }), false);
  assert.equal(goodFix({ ...point, accuracy: 16 }, 15), false); // старый сервер
  assert.equal(goodFix({ ...point, latitude: NaN }), false);
  assert.equal(shouldAppend(point, { ...point, timestamp: 101 }), false);
  assert.equal(shouldAppend(point, { ...point, timestamp: 105 }), true); // heartbeat сохраняет непрерывность времени
  assert.equal(
    shouldAppend(point, { ...point, longitude: 20.001, timestamp: 101 }),
    true,
  );
  assert.equal(meters(point, point), 0);
});

test("Telegram LocationManager: координаты и заявленная точность", async () => {
  const manager = {
    isInited: false,
    isLocationAvailable: true,
    init(callback) {
      this.isInited = true;
      callback();
    },
    getLocation(callback) {
      callback({ latitude: 54, longitude: 20, horizontal_accuracy: 4 });
    },
  };
  const source = createLocationSource({
    telegram: { isVersionAtLeast: () => true, LocationManager: manager },
    navigator: {},
    secureContext: true,
  });
  const p = await source.getPosition();
  assert.equal(p.coords.latitude, 54);
  assert.equal(p.coords.accuracy, 4);
  assert.ok(p.timestamp > 0);
  manager.getLocation = (callback) => callback(null);
  await assert.rejects(source.getPosition(), /Нет доступа/);
});
test("без Telegram остаётся браузерный Geolocation и отключение подписки", async () => {
  let cleared = false;
  const source = createLocationSource({
    secureContext: true,
    navigator: {
      geolocation: {
        getCurrentPosition(callback) {
          callback({ coords: { latitude: 54 } });
        },
        watchPosition() {
          return 7;
        },
        clearWatch(id) {
          cleared = id === 7;
        },
      },
    },
  });
  assert.equal((await source.getPosition()).coords.latitude, 54);
  const cleanup = await source.watchPosition(
    () => {},
    () => {},
  );
  cleanup();
  assert.equal(cleared, true);
});

test('фото карты увеличиваются с зумом, GPS принимает ровно 20 м',()=>{
 let previous=0;for(let z=3;z<=19;z++){const size=photoSize(z);assert.ok(size>previous&&size>=16&&size<=64);previous=size;}
 assert.equal(goodFix({...point,accuracy:20}),true);assert.equal(goodFix({...point,accuracy:20.001}),false);
});
