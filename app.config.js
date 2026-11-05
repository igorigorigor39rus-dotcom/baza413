export default {
  expo: {
    name: 'Лапы на карте',
    slug: 'baza413',
    version: '0.1.0',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    ios: {
      bundleIdentifier: 'com.baza413.paws',
      supportsTablet: true,
    },
    android: { package: 'com.baza413.paws' },
    plugins: [
      ['expo-location', { locationWhenInUsePermission: 'Местоположение нужно для записи прогулки и захвата территории.' }],
      ['expo-image-picker', { photosPermission: 'Выберите фотографию питомца для профиля.', cameraPermission: false, microphonePermission: false }],
      // Expo Go предоставляет карту. Для собственной Android-сборки нужен ключ
      // Google Maps SDK for Android, ограниченный package name и SHA-1 подписи.
      ['react-native-maps', {
        ...(process.env.GOOGLE_MAPS_ANDROID_API_KEY ? { androidGoogleMapsApiKey: process.env.GOOGLE_MAPS_ANDROID_API_KEY } : {}),
      }],
    ],
  },
};
