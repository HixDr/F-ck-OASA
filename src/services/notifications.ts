/**
 * Arrival alert service using an Android foreground service.
 *
 * Uses react-native-background-actions to start a persistent foreground
 * service with a notification. A silent audio loop (expo-av) keeps the
 * media session alive (foregroundServiceType=mediaPlayback). A polling
 * loop checks the OASA API every 15s and fires the arrival sound +
 * vibration + system notification when the threshold is met.
 */

import { Alert as RNAlert, Platform, Vibration } from 'react-native';
import { Audio } from 'expo-av';
import * as Notifications from 'expo-notifications';
import BackgroundService from 'react-native-background-actions';

const OASA_BASE = 'http://telematics.oasa.gr/api/';

/* ── Notification setup (expo-notifications for alert popup) ──── */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

async function ensureNotificationPermission(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

async function ensureNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('arrival', {
    name: 'Arrival alerts',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 80, 60, 120, 60, 160],
    enableVibrate: true,
  });
}

/* ── Types ────────────────────────────────────────────────────── */

export interface AlertConfig {
  stopCode: string;
  stopName: string;
  thresholdMin: number;
  lineId: string;
  routeCodes: string[];
  /** Accent color for the notification (defaults to primary). */
  color?: string;
}

/* ── State ────────────────────────────────────────────────────── */

let _alertConfig: AlertConfig | null = null;
let _onAlertFired: (() => void) | null = null;
let _hasNotifPermission = false;
let _silentSound: Audio.Sound | null = null;
let _alertSound: Audio.Sound | null = null;
const _subscribers = new Set<(config: AlertConfig | null) => void>();

/** Subscribe to alert config changes. Returns unsubscribe function. */
export function subscribeAlertConfig(cb: (config: AlertConfig | null) => void): () => void {
  _subscribers.add(cb);
  cb(_alertConfig);
  return () => { _subscribers.delete(cb); };
}

function notifyConfigChange(): void {
  _subscribers.forEach(cb => cb(_alertConfig));
}

/* ── Audio ────────────────────────────────────────────────────── */

async function startSilentLoop(): Promise<void> {
  await Audio.setAudioModeAsync({
    staysActiveInBackground: true,
    playsInSilentModeIOS: true,
    shouldDuckAndroid: true,
  });
  if (_silentSound) return;
  const { sound } = await Audio.Sound.createAsync(
    require('../../assets/silence.mp3'),
    { isLooping: true, volume: 0 },
  );
  _silentSound = sound;
  await sound.playAsync();
}

async function stopSilentLoop(): Promise<void> {
  if (!_silentSound) return;
  try { await _silentSound.stopAsync(); await _silentSound.unloadAsync(); } catch {}
  _silentSound = null;
}

async function playArrivalSound(): Promise<void> {
  try {
    if (_alertSound) { await _alertSound.unloadAsync(); _alertSound = null; }
    const { sound } = await Audio.Sound.createAsync(
      require('../../assets/arrival.mp3'),
      { volume: 1 },
    );
    _alertSound = sound;
    await sound.playAsync();
    Vibration.vibrate([
      0, 80, 60, 120, 60, 160,
      200, 80, 60, 120, 60, 160,
      200, 80, 60, 120, 60, 160,
      200, 80, 60, 120, 60, 160,
    ]);
  } catch {}
}

/* ── OASA API ─────────────────────────────────────────────────── */

async function fetchStopArrivals(stopCode: string): Promise<any[]> {
  const url = `${OASA_BASE}?act=getStopArrivals&p1=${stopCode}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'FckOASA/1.0' } });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/* ── Background task ──────────────────────────────────────────── */

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** The task that runs inside the foreground service. */
async function pollingTask(taskData: any): Promise<void> {
  // Start silent audio to satisfy mediaPlayback service type
  await startSilentLoop();

  while (BackgroundService.isRunning()) {
    if (!_alertConfig) { await sleep(1000); continue; }
    const { stopCode, stopName, thresholdMin, lineId, routeCodes } = _alertConfig;
    try {
      const arrivals = await fetchStopArrivals(stopCode);
      const routeSet = new Set(routeCodes);
      const filtered = arrivals.filter((a: any) => routeSet.has(a.route_code));
      const match = filtered.find((a: any) => Number(a.btime2) <= thresholdMin);
      if (match) {
        await playArrivalSound();
        if (_hasNotifPermission) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: `🚌 ${lineId} arriving!`,
              body: `${Number(match.btime2)} min away at ${stopName}`,
              sound: false,
              ...(Platform.OS === 'android' ? { channelId: 'arrival' } : {}),
            },
            trigger: null,
          });
        }
        RNAlert.alert(
          `🚌 ${lineId} arriving!`,
          `${Number(match.btime2)} min away at ${stopName}`,
        );
        const cb = _onAlertFired;
        await stopAlertWatch();
        cb?.();
        return;
      }
    } catch {}
    await sleep(15_000);
  }
}

/* ── Public API ───────────────────────────────────────────────── */

/** Start the foreground service and begin polling for arrivals. */
export async function startAlertWatch(
  config: AlertConfig,
  onFired?: () => void,
): Promise<void> {
  _alertConfig = config;
  _onAlertFired = onFired ?? null;
  notifyConfigChange();

  _hasNotifPermission = await ensureNotificationPermission();
  await ensureNotificationChannel();

  if (BackgroundService.isRunning()) {
    // Already running — just update config (polling loop reads _alertConfig)
    await BackgroundService.updateNotification({
      taskTitle: `🔔 Monitoring ${config.lineId}`,
      taskDesc: `Alert when ≤${config.thresholdMin}min at ${config.stopName}`,
    });
    return;
  }

  await BackgroundService.start(pollingTask, {
    taskName: 'ArrivalAlert',
    taskTitle: `🔔 Monitoring ${config.lineId}`,
    taskDesc: `Alert when ≤${config.thresholdMin}min at ${config.stopName}`,
    taskIcon: { name: 'notification_icon', type: 'drawable' },
    color: config.color ?? '#6366F1',
    linkingURI: 'fck-oasa://',
    parameters: {},
  });
}

/** Stop the foreground service and release all resources. */
export async function stopAlertWatch(): Promise<void> {
  _alertConfig = null;
  _onAlertFired = null;
  notifyConfigChange();
  await stopSilentLoop();
  if (BackgroundService.isRunning()) {
    await BackgroundService.stop();
  }
}
