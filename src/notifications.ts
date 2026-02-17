/**
 * Local notification service for arrival alerts.
 *
 * expo-notifications is not available in Expo Go (SDK 53+).
 * The module is loaded lazily via require() so the app gracefully
 * degrades to an in-app Alert fallback when running in Expo Go.
 *
 * Custom sound: place arrival.mp3 at android/app/src/main/res/raw/arrival.mp3
 * and configure the expo-notifications plugin in app.json with
 * `"sounds": ["./assets/arrival.mp3"]`.
 */

import { Alert as RNAlert } from 'react-native';

let _Notifications: typeof import('expo-notifications') | null = null;

/** Try to load expo-notifications; returns null in Expo Go. */
function getNotifications() {
  if (_Notifications !== null) return _Notifications;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _Notifications = require('expo-notifications') as typeof import('expo-notifications');
  } catch {
    _Notifications = null;
  }
  return _Notifications;
}

let _initialized = false;

/** Request permissions and configure the notification channel. Call once at app start. */
export async function initNotifications(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  const N = getNotifications();
  if (!N) return; // Expo Go — skip

  const { status } = await N.requestPermissionsAsync();
  if (status !== 'granted') return;

  // Android notification channel — high importance for sound + vibration
  // Channel ID is versioned; Android caches channel settings so a new ID forces fresh config.
  await N.setNotificationChannelAsync('arrival-alerts-v2', {
    name: 'Arrival Alerts',
    importance: N.AndroidImportance.HIGH,
    vibrationPattern: [
      0, 80, 60, 120, 60, 160,   // 1-2-3
      200, 80, 60, 120, 60, 160, // 1-2-3
      200, 80, 60, 120, 60, 160, // 1-2-3
      200, 80, 60, 120, 60, 160, // 1-2-3
    ],
    sound: 'arrival.mp3',
  });

  // Show notification banner even when app is foregrounded
  N.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/** Fire an immediate local notification for a bus arrival. */
export async function fireArrivalAlert(
  lineId: string,
  stopName: string,
  minutes: number,
): Promise<void> {
  const N = getNotifications();
  if (N) {
    await N.scheduleNotificationAsync({
      content: {
        title: `🚌 ${lineId} arriving!`,
        body: `${minutes} min away at ${stopName}`,
        sound: 'arrival.mp3',
        vibrate: [
          0, 80, 60, 120, 60, 160,
          200, 80, 60, 120, 60, 160,
          200, 80, 60, 120, 60, 160,
          200, 80, 60, 120, 60, 160,
        ],
      },
      trigger: { channelId: 'arrival-alerts-v2' },
    });
  } else {
    // Expo Go fallback — show an in-app alert
    RNAlert.alert(`🚌 ${lineId} arriving!`, `${minutes} min away at ${stopName}`);
  }
}
