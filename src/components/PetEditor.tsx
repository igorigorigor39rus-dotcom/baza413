import React, { useState } from 'react';
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Directory, File, Paths } from 'expo-file-system';
import type { Pet } from '../types';

const COLORS = ['#397C63', '#527DE0', '#B66ACC', '#E9A33B', '#D85B67', '#4CA5AB'];
export function PetEditor({ pet, onSave, onCancel }: { pet: Pet | null; onSave: (pet: Pet) => Promise<void>; onCancel?: () => void }) {
  const [name, setName] = useState(pet?.name ?? '');
  const [age, setAge] = useState(pet?.age ?? '');
  const [description, setDescription] = useState(pet?.description ?? '');
  const [color, setColor] = useState(pet?.color ?? COLORS[0]);
  const [photo, setPhoto] = useState(pet?.photo);
  const [busy, setBusy] = useState(false);

  async function choosePhoto() {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) { Alert.alert('Нужен доступ к фото', 'Разрешите доступ в настройках телефона или продолжите без фотографии.'); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.7 });
      if (!result.canceled) setPhoto(result.assets[0].uri);
    } catch { Alert.alert('Не получилось выбрать фото', 'Попробуйте другое изображение.'); }
  }
  async function submit() {
    const normalizedAge = age.trim().replace(',', '.');
    if (!name.trim() || !normalizedAge || !Number.isFinite(Number(normalizedAge)) || Number(normalizedAge) < 0 || Number(normalizedAge) > 35) {
      Alert.alert('Проверьте профиль', 'Укажите кличку и возраст от 0 до 35 лет.'); return;
    }
    setBusy(true);
    try {
      let durablePhoto = photo;
      if (photo && photo !== pet?.photo) {
        // Галерея возвращает временный файл. Копия в documents переживает очистку кэша.
        const dir = new Directory(Paths.document, 'pets');
        dir.create({ idempotent: true, intermediates: true });
        const source = new File(photo);
        const target = new File(dir, `pet-${Date.now()}${source.extension || '.jpg'}`);
        source.copy(target);
        durablePhoto = target.uri;
      }
      await onSave({ id: pet?.id ?? `pet-${Date.now()}`, name: name.trim(), age: normalizedAge, description: description.trim(), color, photo: durablePhoto });
    } catch { Alert.alert('Профиль не сохранён', 'Не удалось записать данные на устройство. Попробуйте ещё раз.'); }
    finally { setBusy(false); }
  }
  return <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
    <Text style={s.eyebrow}>ЛАПЫ НА КАРТЕ</Text>
    <Text style={s.title}>{pet ? 'Профиль питомца' : 'У каждой прогулки\nсвоя территория'}</Text>
    <Text style={s.subtitle}>Познакомимся с вашим напарником. Это локальный профиль на этом телефоне.</Text>
    <Pressable style={s.photo} onPress={choosePhoto} disabled={busy} accessibilityLabel="Выбрать фото питомца">
      {photo ? <Image source={{ uri: photo }} style={s.image} /> : <Text style={{ fontSize: 38 }}>🐾</Text>}
      <Text style={s.link}>{photo ? 'Заменить фото' : 'Добавить фото'}</Text>
    </Pressable>
    <Text style={s.label}>Кличка</Text><TextInput style={s.input} value={name} onChangeText={setName} maxLength={40} placeholder="Например, Ричи" editable={!busy} />
    <Text style={s.label}>Возраст, лет</Text><TextInput style={s.input} value={age} onChangeText={setAge} maxLength={4} keyboardType="decimal-pad" placeholder="3" editable={!busy} />
    <Text style={s.label}>О питомце</Text><TextInput style={[s.input, { minHeight: 86, textAlignVertical: 'top' }]} value={description} onChangeText={setDescription} maxLength={400} multiline placeholder="Характер, любимые игры, особенности" editable={!busy} />
    <Text style={s.label}>Цвет вашей территории</Text><View style={s.colors}>{COLORS.map(c => <Pressable key={c} onPress={() => setColor(c)} disabled={busy} accessibilityLabel={`Цвет ${c}`} accessibilityState={{ selected: color === c }} style={[s.swatch, { backgroundColor: c, borderWidth: color === c ? 4 : 0 }]}><Text style={{ color: 'white', fontSize: 18 }}>{color === c ? '✓' : ''}</Text></Pressable>)}</View>
    <Pressable style={s.button} onPress={submit} disabled={busy}><Text style={s.buttonText}>{busy ? 'Сохраняем…' : 'Сохранить и открыть карту'}</Text></Pressable>
    {onCancel && <Pressable onPress={onCancel} disabled={busy} style={{ padding: 18 }}><Text style={s.link}>Отмена</Text></Pressable>}
  </ScrollView>;
}
const s = StyleSheet.create({
  page: { padding: 24, paddingBottom: 40, backgroundColor: '#F8F8F2', flexGrow: 1 },
  eyebrow: { color: '#397C63', letterSpacing: 3, fontWeight: '800', fontSize: 12, marginBottom: 18 },
  title: { fontSize: 31, fontWeight: '800', color: '#203E33' }, subtitle: { color: '#68766F', fontSize: 15, lineHeight: 22, marginTop: 12 },
  photo: { alignItems: 'center', alignSelf: 'center', marginVertical: 24, gap: 10 }, image: { width: 100, height: 100, borderRadius: 50 },
  link: { textAlign: 'center', color: '#397C63', fontWeight: '700' }, label: { fontWeight: '700', color: '#203E33', marginBottom: 8, marginTop: 14 },
  input: { backgroundColor: 'white', padding: 14, borderRadius: 14, borderWidth: 1, borderColor: '#DCE3D9', fontSize: 16, color: '#203E33' },
  colors: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 12 }, swatch: { width: 40, height: 40, borderRadius: 20, borderColor: '#203E33', justifyContent: 'center', alignItems: 'center' },
  button: { backgroundColor: '#397C63', padding: 18, borderRadius: 16, marginTop: 20 }, buttonText: { textAlign: 'center', color: 'white', fontSize: 16, fontWeight: '800' },
});
