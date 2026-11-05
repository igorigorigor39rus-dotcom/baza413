import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polygon, Polyline } from 'react-native-maps';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { area, pointOnFeature } from '@turf/turf';
import { PetEditor } from './src/components/PetEditor';
import { acceptPosition, captureTerritory, metersBetween, routeLength, validateRoute } from './src/domain/territory';
import { DEMO_CENTER, DEMO_PET, DEMO_ROUTE, demoTerritories } from './src/demo';
import { loadData, saveData } from './src/storage';
import type { Pet, Position, SavedData, Territory } from './src/types';

export default function App() {
  return <SafeAreaProvider><Main /></SafeAreaProvider>;
}

function Main() {
  const [data, setData] = useState<SavedData>({ version: 1, pet: null, territories: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false);
  const [walking, setWalking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [route, setRoute] = useState<Position[]>([]);
  const [gpsMessage, setGpsMessage] = useState('');
  const [demo, setDemo] = useState(false);
  const [demoLands, setDemoLands] = useState<Territory[]>([]);
  const [selected, setSelected] = useState<Pet | null>(null);
  const [now, setNow] = useState(Date.now());
  const map = useRef<MapView>(null);
  const subscription = useRef<Location.LocationSubscription | null>(null);
  const latestFix = useRef<Position | null>(null);
  // Номер сессии защищает от позднего ответа на запрос разрешения/запуска GPS.
  const session = useRef(0);
  const active = useRef(false);

  async function reload() {
    setLoading(true); setLoadError('');
    try { setData(await loadData()); }
    catch (e) { setLoadError(e instanceof Error ? e.message : 'Хранилище недоступно. Повторите попытку.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload(); }, []);
  function stopGps() {
    session.current += 1; active.current = false;
    subscription.current?.remove(); subscription.current = null;
    latestFix.current = null;
    void deactivateKeepAwake('walk');
    setWalking(false);
  }
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active' && active.current) {
        // Фоновая запись ещё не реализована. Нельзя соединять пропущенный путь
        // прямой линией и позволять захват территории после такой паузы.
        stopGps(); setRoute([]); setBusy(false);
        setGpsMessage('Прогулка прервана: приложение ушло в фон. Начните новую запись.');
      }
    });
    return () => { listener.remove(); session.current += 1; subscription.current?.remove(); void deactivateKeepAwake('walk'); };
  }, []);
  useEffect(() => {
    if (!walking || demo) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [walking, demo]);

  async function persist(next: SavedData) { await saveData(next); setData(next); }
  async function startWalk() {
    setBusy(true); setRoute([]); latestFix.current = null;
    setGpsMessage('Запрашиваем точное местоположение…');
    const token = ++session.current;
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (token !== session.current) return;
      if (!permission.granted) throw new Error('Разрешите геолокацию в настройках телефона. Для пробы доступна демопрогулка.');
      if (!await Location.hasServicesEnabledAsync()) throw new Error('Включите определение местоположения на телефоне.');
      if (token !== session.current) return;
      if (AppState.currentState === 'background') throw new Error('Вернитесь в приложение и начните прогулку снова.');
      active.current = true;
      const watcher = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 1, timeInterval: 1000 }, location => {
        if (token !== session.current) return;
        const p: Position = { latitude: location.coords.latitude, longitude: location.coords.longitude, accuracy: location.coords.accuracy ?? Infinity, timestamp: location.timestamp };
        if (!acceptPosition(undefined, p)) {
          latestFix.current = null;
          setGpsMessage('Слабый GPS: нужна точность до 15 м. Выйдите на открытое место.'); return;
        }
        latestFix.current = p; setNow(Date.now());
        setGpsMessage(`GPS ±${Math.round(p.accuracy)} м · замыкание до 5 м`);
        setRoute(previous => acceptPosition(previous.at(-1), p) ? [...previous, p] : previous);
        map.current?.animateToRegion({ ...p, latitudeDelta: 0.003, longitudeDelta: 0.003 }, 400);
      });
      if (token !== session.current) { watcher.remove(); return; }
      subscription.current = watcher;
      setWalking(true);
      void activateKeepAwakeAsync('walk').catch(() => {});
    } catch (e) {
      if (token === session.current) { stopGps(); setGpsMessage(e instanceof Error ? e.message : 'Не удалось запустить GPS.'); }
    } finally { if (token === session.current || !active.current) setBusy(false); }
  }

  function startDemo() {
    stopGps(); setRoute([]); setDemo(true); setDemoLands(demoTerritories());
    setGpsMessage('Демо: оранжевая территория принадлежит Бублику. Данные демо не сохраняются.');
    map.current?.animateToRegion(DEMO_CENTER);
  }
  function advanceDemo() {
    if (!walking) { setRoute([DEMO_ROUTE[0]]); setWalking(true); }
    else setRoute(previous => previous.length < DEMO_ROUTE.length ? [...previous, DEMO_ROUTE[previous.length]] : previous);
  }
  async function capture() {
    if (!data.pet) return;
    let finalRoute = route;
    if (!demo) {
      const fix = latestFix.current;
      if (!fix || Date.now() - fix.timestamp > 15000) { Alert.alert('Нет свежего GPS', 'Дождитесь точного местоположения перед захватом.'); return; }
      if (route.length && metersBetween(route.at(-1)!, fix) > 0.05) finalRoute = [...route, fix];
    }
    const validation = validateRoute(finalRoute);
    if (!validation.ok) { Alert.alert('Контур пока не готов', validation.message); return; }
    setBusy(true);
    try {
      const next = captureTerritory(demo ? demoLands : data.territories, finalRoute, data.pet.id, `land-${Date.now()}`, new Date().toISOString());
      if (demo) setDemoLands(next);
      else await persist({ ...data, territories: next });
      stopGps(); setRoute([]); setGpsMessage(demo ? 'Демозахват выполнен. Нажмите на фото владельца на карте.' : 'Территория сохранена на этом телефоне. Отличная прогулка!');
      Alert.alert('Территория ваша!', `${Math.round(validation.squareMeters)} м² ${demo ? 'в демонстрации' : 'сохранено'}. Пересечённая часть прежних участков перешла вашему питомцу.`);
    } catch { Alert.alert('Захват не сохранён', 'Не удалось обработать или записать территорию. Маршрут оставлен для повторной попытки.'); }
    finally { setBusy(false); }
  }

  const pet = data.pet;
  const lands = demo ? demoLands : data.territories;
  const ownArea = pet ? lands.filter(t => t.petId === pet.id).reduce((sum, t) => sum + area(t.shape), 0) : 0;
  const gap = route.length ? metersBetween(route[0], route.at(-1)!) : 0;
  const stale = walking && !demo && (!latestFix.current || now - latestFix.current.timestamp > 15000);
  const owner = (id: string) => id === pet?.id ? pet : demo && id === DEMO_PET.id ? DEMO_PET : null;

  if (loading || loadError) return <SafeAreaView style={s.center}>{loading ? <ActivityIndicator size="large" color="#397C63" /> : <><Text style={s.h2}>Хранилище недоступно</Text><Text style={s.description}>{loadError}</Text><Pressable style={s.primary} onPress={reload}><Text style={s.white}>Повторить</Text></Pressable></>}</SafeAreaView>;
  if (!pet || editing) return <SafeAreaView style={s.screen}><PetEditor pet={pet} onSave={async next => { await persist({ ...data, pet: next }); setEditing(false); }} onCancel={pet ? () => setEditing(false) : undefined} /></SafeAreaView>;

  return <SafeAreaView style={s.screen}>
    <View style={s.header}><View><Text style={s.eyebrow}>ЛАПЫ НА КАРТЕ</Text><Text style={s.h2}>Мир начинается с прогулки</Text></View><Pressable disabled={walking || busy} onPress={() => setEditing(true)} accessibilityLabel="Открыть свой профиль"><Avatar pet={pet} size={44} /></Pressable></View>
    <View style={s.mapWrap}>
      <MapView ref={map} style={StyleSheet.absoluteFill} initialRegion={DEMO_CENTER} showsUserLocation={!demo && walking} showsMyLocationButton={!demo && walking}>
        {lands.flatMap(t => {
          const p = owner(t.petId); if (!p) return [];
          const pieces = t.shape.geometry.type === 'Polygon' ? [t.shape.geometry.coordinates] : t.shape.geometry.coordinates;
          const marker = pointOnFeature(t.shape).geometry.coordinates;
          const latLng = (ring: number[][]) => ring.map(([longitude, latitude]) => ({ latitude, longitude }));
          return [...pieces.map((rings, i) => <Polygon key={`${t.id}-${i}`} coordinates={latLng(rings[0])} holes={rings.slice(1).map(latLng)} fillColor={`${p.color}66`} strokeColor={p.color} strokeWidth={2} tappable onPress={() => setSelected(p)} />),
            <Marker key={`${t.id}-owner`} coordinate={{ latitude: marker[1], longitude: marker[0] }} onPress={() => setSelected(p)} accessibilityLabel={`Территория: ${p.name}`}><Avatar pet={p} size={44} /></Marker>];
        })}
        {route.length > 0 && <><Polyline coordinates={route} strokeColor={pet.color} strokeWidth={4} /><Marker coordinate={route[0]} title="Точка старта" pinColor="#397C63" /></>}
        {demo && route.length > 0 && <Marker coordinate={route.at(-1)!} title="Вы здесь" pinColor="#527DE0" />}
      </MapView>
      <View style={s.mapBadge}><Text style={s.badgeText}>{demo ? 'ДЕМОНСТРАЦИЯ' : 'ЛОКАЛЬНАЯ ВЕРСИЯ'} · {Math.round(ownArea)} м² ваших</Text></View>
    </View>
    <ScrollView style={s.panel} contentContainerStyle={{ padding: 20, gap: 12 }}>
      <View style={s.row}><Text style={s.h2}>{walking ? 'Идём за новыми открытиями' : `На прогулку, ${pet.name}?`}</Text><Text style={{ fontSize: 25 }}>🐾</Text></View>
      <Text style={s.description}>{gpsMessage || 'Обойдите участок и вернитесь к старту в пределах 5 м. Замкнутый контур станет вашей территорией.'}</Text>
      {walking && <View style={s.stats}><Text style={s.stat}>Путь  {Math.round(routeLength(route))} м</Text><Text style={s.stat}>До старта  {Math.round(gap)} м</Text></View>}
      {stale && <Text style={s.warning}>Ждём свежий точный GPS. Захват пока недоступен.</Text>}
      {demo && (!walking || route.length < DEMO_ROUTE.length) && <Pressable style={s.primary} onPress={advanceDemo} disabled={busy}><Text style={s.white}>{walking ? `Следующая точка · ${route.length}/${DEMO_ROUTE.length}` : 'Начать демопрогулку'}</Text></Pressable>}
      {!demo && !walking && <Pressable style={[s.primary, busy && s.disabled]} onPress={startWalk} disabled={busy}><Text style={s.white}>{busy ? 'Подключаем GPS…' : 'Начать захват'}</Text></Pressable>}
      {walking && <Pressable style={[s.primary, (busy || stale) && s.disabled]} onPress={capture} disabled={busy || stale}><Text style={s.white}>{busy ? 'Сохраняем…' : 'Захватить'}</Text></Pressable>}
      {walking && <Pressable disabled={busy} onPress={() => Alert.alert('Отменить прогулку?', 'Незаписанный маршрут будет удалён.', [{ text: 'Продолжить', style: 'cancel' }, { text: 'Отменить прогулку', style: 'destructive', onPress: () => { stopGps(); setRoute([]); setGpsMessage('Прогулка отменена.'); } }])}><Text style={s.link}>Отменить прогулку</Text></Pressable>}
      {!walking && !busy && <Pressable onPress={demo ? () => { setDemo(false); setRoute([]); setGpsMessage(''); } : startDemo}><Text style={s.link}>{demo ? 'Выйти из демо' : 'Попробовать без GPS'}</Text></Pressable>}
      <Text style={s.footnote}>Гуляйте только там, где это разрешено. Цвет на карте не даёт прав на участок. GPS работает при открытом приложении.</Text>
    </ScrollView>
    <Modal visible={selected !== null} transparent animationType="slide" onRequestClose={() => setSelected(null)}>
      <View style={s.overlay}><View style={s.sheet}>{selected && <><Avatar pet={selected} size={84} /><Text style={s.h2}>{selected.name} · {selected.age} лет</Text><Text style={s.description}>{selected.description || 'Любит гулять и открывать новые места.'}</Text><Text style={s.footnote}>{selected.id === DEMO_PET.id ? 'Вымышленный профиль демо' : 'Профиль на этом устройстве'}</Text></>}<Pressable style={s.primary} onPress={() => setSelected(null)}><Text style={s.white}>Вернуться на карту</Text></Pressable></View></View>
    </Modal>
  </SafeAreaView>;
}
function Avatar({ pet, size }: { pet: Pet; size: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 3, borderColor: pet.color, backgroundColor: 'white', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>{pet.photo ? <Image source={{ uri: pet.photo }} style={{ width: size, height: size }} /> : <Text style={{ fontSize: size * 0.45 }}>🐶</Text>}</View>;
}
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F8F8F2' }, center: { flex: 1, justifyContent: 'center', padding: 28, gap: 20, backgroundColor: '#F8F8F2' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 18, gap: 10 },
  eyebrow: { fontSize: 10, fontWeight: '800', letterSpacing: 2.5, color: '#397C63', marginBottom: 6 },
  h2: { fontSize: 18, fontWeight: '800', color: '#203E33', flexShrink: 1 },
  mapWrap: { flex: 1.3, minHeight: 180, overflow: 'hidden', marginHorizontal: 12, borderRadius: 24, backgroundColor: '#DDE6DB' },
  mapBadge: { position: 'absolute', top: 12, alignSelf: 'center', padding: 10, backgroundColor: '#FFFFFFEE', borderRadius: 20 }, badgeText: { color: '#203E33', fontWeight: '700', fontSize: 11 },
  panel: { flex: 1 }, row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  description: { color: '#68766F', fontSize: 14, lineHeight: 21 }, primary: { backgroundColor: '#397C63', borderRadius: 16, padding: 17 },
  white: { color: 'white', fontSize: 16, fontWeight: '800', textAlign: 'center' }, disabled: { opacity: 0.5 }, link: { color: '#397C63', textAlign: 'center', padding: 10, fontWeight: '700' },
  stats: { flexDirection: 'row', justifyContent: 'space-between', padding: 13, backgroundColor: '#EAF0E6', borderRadius: 12 }, stat: { color: '#203E33', fontWeight: '700' },
  warning: { color: '#92641E', fontSize: 13 }, footnote: { color: '#7F8B82', fontSize: 11, lineHeight: 16 },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#10251C77' }, sheet: { backgroundColor: '#F8F8F2', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 28, paddingBottom: 44, gap: 20 },
});
