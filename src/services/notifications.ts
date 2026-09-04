/**
 * Arrival alert service using an Android foreground service.
 *
 * Uses react-native-background-actions to start a persistent foreground
 * service with a notification. A silent audio loop (expo-av) keeps the
 * media session alive (foregroundServiceType=mediaPlayback). A polling
 * loop checks the OASA API and fires the arrival sound + vibration +
 * system notification when the threshold is met.
 *
 * The hard constraint everything here is shaped around: the background task
 * must never reject. react-native-background-actions attaches no `.catch` to
 * it, so a rejection means `self.stop()` is never called, `_stopTask` never
 * resolves, and the foreground service (plus its permanent notification) is
 * stranded with nothing polling behind it.
 */

import { Alert as RNAlert, Platform, Vibration } from 'react-native';
import { notifiedLine } from '../utils/lineLabels';
import { Audio } from 'expo-av';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as Notifications from 'expo-notifications';
import BackgroundService from 'react-native-background-actions';
import { getStopArrivals } from './api';
import type { OasaArrival } from '../types';

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

const ARRIVAL_CHANNEL = 'arrival';
const ARRIVAL_VIBRATION = [0, 80, 60, 120, 60, 160];

/** Give up after this long — otherwise an alert set at the end of service
 *  polls every 15 s until the phone dies. */
const MAX_WATCH_MS = 90 * 60_000;

/** Poll cadence, chosen from how close the soonest bus is to the threshold.
 *  A flat 15 s meant an alert could land 15 s late, and a bus that crossed the
 *  threshold and then dropped out of the feed between polls was missed. */
const POLL_FAR_MS = 30_000;
const POLL_NEAR_MS = 15_000;
const POLL_IMMINENT_MS = 5_000;

async function ensureNotificationPermission(): Promise<boolean> {
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    if (existing === 'granted') return true;
    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

async function ensureNotificationChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(ARRIVAL_CHANNEL, {
      name: 'Arrival alerts',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: ARRIVAL_VIBRATION,
      enableVibrate: true,
    });
  } catch (err) {
    console.warn('[alert] could not create the arrival channel:', err);
  }
}

/* ── Types ────────────────────────────────────────────────────── */

export interface AlertConfig {
  stopCode: string;
  stopName: string;
  thresholdMin: number;
  /** The number on the front of the bus, or null when the catalogue could
   *  not name it. See `lineLabels.ts` — never an internal code. */
  lineId: string | null;
  routeCodes: string[];
  /** Accent color for the notification (defaults to primary). */
  color?: string;
}

export type AlertStartResult =
  | {
      ok: true;
      /**
       * Only one alert can be armed at a time — this service keeps a single
       * global config. When set, arming this alert silently cancelled that
       * one, and the UI should say so.
       */
      replaced: AlertConfig | null;
    }
  | {
      ok: false;
      reason: 'permission' | 'service' | 'unsupported';
      /** Ready to show to the user. */
      message: string;
    };

/* ── State ────────────────────────────────────────────────────── */

let _alertConfig: AlertConfig | null = null;
let _onAlertFired: (() => void) | null = null;
let _hasNotifPermission = false;
let _silentSound: Audio.Sound | null = null;
let _alertSound: Audio.Sound | null = null;
let _audioModeChanged = false;

/**
 * Own run flag. `BackgroundService.isRunning()` cannot be trusted for loop
 * control: the library sets `_isRunning = true` only *after* `start()`
 * resolves, but the native service dispatches the JS task independently. A
 * task that reached the check first saw `false`, exited immediately, and left
 * a phantom alert armed with nothing polling it.
 */
let _watchActive = false;
/** Bumped on every arm/disarm so a lingering task from a previous run exits
 *  instead of tearing down the new one's audio. */
let _generation = 0;
let _watchDeadline = 0;
let _abort: AbortController | null = null;
/** Resolver for the current poll delay, so a disarm interrupts it. */
let _wake: (() => void) | null = null;

const _subscribers = new Set<(config: AlertConfig | null) => void>();

/** Subscribe to alert config changes. Returns unsubscribe function.
 *  Fires synchronously with the current config before returning. */
export function subscribeAlertConfig(cb: (config: AlertConfig | null) => void): () => void {
  _subscribers.add(cb);
  cb(_alertConfig);
  return () => { _subscribers.delete(cb); };
}

/** The alert currently armed, if any. Check before arming a second one. */
export function getAlertConfig(): AlertConfig | null {
  return _alertConfig;
}

function notifyConfigChange(): void {
  _subscribers.forEach((cb) => {
    try { cb(_alertConfig); } catch { /* one bad consumer must not stop the rest */ }
  });
}

/* ── Audio ────────────────────────────────────────────────────── */

async function startSilentLoop(): Promise<void> {
  await Audio.setAudioModeAsync({
    staysActiveInBackground: true,
    playsInSilentModeIOS: true,
    shouldDuckAndroid: true,
  });
  _audioModeChanged = true;
  if (_silentSound) return;
  const { sound } = await Audio.Sound.createAsync(
    require('../../assets/silence.mp3'),
    { isLooping: true, volume: 0 },
  );
  _silentSound = sound;
  await sound.playAsync();
}

/** Undo the global audio mode. It is process-wide state — leaving
 *  `staysActiveInBackground` on kept an audio session alive for the rest of
 *  the app's life after a single alert. */
async function restoreAudioMode(): Promise<void> {
  if (!_audioModeChanged) return;
  _audioModeChanged = false;
  try {
    await Audio.setAudioModeAsync({
      staysActiveInBackground: false,
      playsInSilentModeIOS: false,
      shouldDuckAndroid: true,
    });
  } catch { /* best effort */ }
}

async function stopSilentLoop(): Promise<void> {
  if (!_silentSound) return;
  const sound = _silentSound;
  _silentSound = null;
  try { await sound.stopAsync(); } catch { /* may already be stopped */ }
  try { await sound.unloadAsync(); } catch { /* nothing left to release */ }
}

async function unloadArrivalSound(): Promise<void> {
  if (!_alertSound) return;
  const sound = _alertSound;
  _alertSound = null;
  try { await sound.unloadAsync(); } catch { /* nothing left to release */ }
}

async function playArrivalSound(): Promise<void> {
  try {
    await unloadArrivalSound();
    const { sound } = await Audio.Sound.createAsync(
      require('../../assets/arrival.mp3'),
      { volume: 1 },
    );
    _alertSound = sound;
    // Release as soon as it finishes. The service tears down moments later,
    // so waiting for the *next* alert to unload leaked one Sound per alert.
    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.isLoaded && status.didJustFinish) void unloadArrivalSound();
    });
    await sound.playAsync();
    Vibration.vibrate([
      0, 80, 60, 120, 60, 160,
      200, 80, 60, 120, 60, 160,
      200, 80, 60, 120, 60, 160,
      200, 80, 60, 120, 60, 160,
    ]);
  } catch (err) {
    // Audio focus denial or a codec failure must not take the alert with it —
    // the notification and vibration are the primary channel.
    console.warn('[alert] arrival sound failed:', err);
  }
}

/* ── Notification ─────────────────────────────────────────────── */

/** `#RGB`-ish guard: expo-notifications wants #RRGGBB / #AARRGGBB and throws
 *  on anything else. */
function safeColor(color?: string): string | undefined {
  return color && /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color) ? color : undefined;
}

async function postNotification(title: string, body: string, color?: string): Promise<void> {
  if (!_hasNotifPermission) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: false, // we play our own through the media session
        color: safeColor(color),
        priority: Notifications.AndroidNotificationPriority.MAX,
        vibrate: ARRIVAL_VIBRATION,
      },
      // channelId belongs on the *trigger* (ChannelAwareTriggerInput), which is
      // also the deliver-immediately trigger. NotificationContentInput has no
      // channelId field, so passing it there was silently dropped and the
      // HIGH-importance channel above was never used — no heads-up banner.
      trigger: Platform.OS === 'android' ? { channelId: ARRIVAL_CHANNEL } : null,
    });
  } catch (err) {
    console.warn('[alert] could not post notification:', err);
  }
}

/* ── Matching ─────────────────────────────────────────────────── */

interface ArrivalMatch {
  /** Minutes until arrival, at or under the threshold. */
  min: number;
  arrival: OasaArrival;
}

/**
 * Soonest arrival on a watched route, plus whether it is at/under threshold.
 *
 * `Number(btime2)` is unguarded upstream: a missing or non-numeric value
 * yields NaN, and NaN fails every comparison, so it used to slip through only
 * when the caller compared the wrong way round. Negative minutes are stale
 * feed data, never a bus. Zero is real — "arriving now" is exactly what the
 * user asked to be told about.
 */
function scanArrivals(
  arrivals: OasaArrival[],
  routeCodes: string[],
  thresholdMin: number,
): { soonestMin: number | null; match: ArrivalMatch | null } {
  const routeSet = new Set(routeCodes);
  let soonestMin: number | null = null;
  let match: ArrivalMatch | null = null;

  for (const a of arrivals) {
    if (!routeSet.has(a.route_code)) continue;
    const min = Number(a.btime2);
    if (!Number.isFinite(min) || min < 0) continue;
    if (soonestMin === null || min < soonestMin) soonestMin = min;
    if (min <= thresholdMin && (match === null || min < match.min)) {
      match = { min, arrival: a };
    }
  }
  return { soonestMin, match };
}

/** Tighten the cadence as the bus closes on the threshold. */
function pollDelayMs(soonestMin: number | null, thresholdMin: number): number {
  if (soonestMin === null) return POLL_NEAR_MS;
  const slack = soonestMin - thresholdMin;
  if (slack <= 1.5) return POLL_IMMINENT_MS;
  if (slack <= 5) return POLL_NEAR_MS;
  return POLL_FAR_MS;
}

/* ── Background task ──────────────────────────────────────────── */

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => { _wake = null; resolve(); }, ms);
    _wake = () => { clearTimeout(timer); _wake = null; resolve(); };
  });
}

/** The task that runs inside the foreground service. Must never reject. */
async function pollingTask(): Promise<void> {
  const generation = _generation;

  try {
    // Satisfies foregroundServiceType=mediaPlayback. Both calls inside throw
    // on audio-focus denial or a codec failure; polling has to survive that,
    // and so does the service teardown.
    await startSilentLoop();
  } catch (err) {
    console.warn('[alert] silent loop failed, polling without it:', err);
  }

  try {
    while (_watchActive && generation === _generation) {
      const config = _alertConfig;
      if (!config) break;

      if (Date.now() >= _watchDeadline) {
        await postNotification(
          `Alert for ${notifiedLine(config.lineId)} expired`,
          `No bus within ${config.thresholdMin} min at ${config.stopName} for `
          + `${Math.round(MAX_WATCH_MS / 60_000)} minutes.`,
          config.color,
        );
        _clearConfig();
        return;
      }

      let delay = POLL_NEAR_MS;
      try {
        _abort = new AbortController();
        const arrivals = await getStopArrivals(config.stopCode, { signal: _abort.signal });
        const { soonestMin, match } = scanArrivals(arrivals, config.routeCodes, config.thresholdMin);

        if (match) {
          await fireAlert(config, match);
          return;
        }
        delay = pollDelayMs(soonestMin, config.thresholdMin);
      } catch {
        // Transient network/API failure — keep watching, do not lose the alert.
      } finally {
        _abort = null;
      }

      // Never sleep past the deadline; the expiry notice should be punctual.
      await sleep(Math.max(1_000, Math.min(delay, _watchDeadline - Date.now())));
    }
  } catch (err) {
    // Belt and braces for the invariant at the top of this file: whatever
    // happens, this function resolves so the library can stop the service.
    console.error('[alert] polling loop crashed:', err);
  } finally {
    // A newer generation owns the audio session now; do not pull it out
    // from under it.
    if (generation === _generation) {
      await stopSilentLoop();
      await unloadArrivalSound();
      await restoreAudioMode();
    }
  }
}

async function fireAlert(config: AlertConfig, match: ArrivalMatch): Promise<void> {
  await playArrivalSound();
  await postNotification(
    `🚌 ${notifiedLine(config.lineId)} arriving!`,
    `${match.min} min away at ${config.stopName}`,
    config.color,
  );
  // In-app alert — only visible if the app happens to be in the foreground.
  try {
    RNAlert.alert(`🚌 ${notifiedLine(config.lineId)} arriving!`, `${match.min} min away at ${config.stopName}`);
  } catch { /* no window attached */ }

  const cb = _onAlertFired;
  _clearConfig();
  // Let the 2.1 s arrival sound and the heads-up banner land before returning:
  // the task's return tears the service (and the media session) down.
  await sleep(2_500);
  try { cb?.(); } catch (err) { console.warn('[alert] onFired callback threw:', err); }
}

/** Disarm without touching the service — the task's own return stops it. */
function _clearConfig(): void {
  _alertConfig = null;
  _onAlertFired = null;
  _watchActive = false;
  notifyConfigChange();
}

/* ── Public API ───────────────────────────────────────────────── */

/**
 * Start the foreground service and begin polling for arrivals.
 *
 * Resolves with a result rather than throwing: both call sites invoke this
 * without a `.catch`, so anything that escapes here becomes an unhandled
 * rejection.
 */
export async function startAlertWatch(
  config: AlertConfig,
  onFired?: () => void,
): Promise<AlertStartResult> {
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    // Expo Go has no custom foreground service. (The old guard tested
    // `!BackgroundService`, which is the module's default-exported instance
    // and therefore always truthy — it never fired.)
    const message = 'Background alerts require a development build. They are not supported in Expo Go.';
    RNAlert.alert('Alert unavailable', message);
    return { ok: false, reason: 'unsupported', message };
  }

  // Hoisted out of the polling loop: asking mid-poll could pop a system
  // dialog from a background context, once per fire.
  _hasNotifPermission = await ensureNotificationPermission();
  if (!_hasNotifPermission) {
    // On Android 13+ a POST_NOTIFICATIONS denial suppresses the foreground
    // service notification *and* silently no-ops scheduleNotificationAsync,
    // so the service would run invisibly and never be able to tell anyone.
    const message = 'Enable notifications for this app so the arrival alert can reach you.';
    RNAlert.alert('Notifications are off', message);
    return { ok: false, reason: 'permission', message };
  }
  await ensureNotificationChannel();

  const replaced = _alertConfig && _alertConfig.stopCode !== config.stopCode ? _alertConfig : null;

  if (_watchActive && BackgroundService.isRunning()) {
    // Already polling — swap the config and restart the clock. The loop reads
    // _alertConfig every iteration.
    _alertConfig = config;
    _onAlertFired = onFired ?? null;
    _watchDeadline = Date.now() + MAX_WATCH_MS;
    notifyConfigChange();
    _wake?.(); // pick the new stop up now, not after the current delay
    try {
      await BackgroundService.updateNotification({
        taskTitle: `🔔 Monitoring ${notifiedLine(config.lineId)}`,
        taskDesc: `Alert when ≤${config.thresholdMin}min at ${config.stopName}`,
      });
    } catch (err) {
      console.warn('[alert] could not update the service notification:', err);
    }
    return { ok: true, replaced };
  }

  // The task can be dispatched before `start()` resolves, so the state it
  // reads has to be in place first — and rolled back if the start fails.
  const previousConfig = _alertConfig;
  _generation++;
  _alertConfig = config;
  _onAlertFired = onFired ?? null;
  _watchActive = true;
  _watchDeadline = Date.now() + MAX_WATCH_MS;
  notifyConfigChange();

  try {
    await BackgroundService.start(pollingTask, {
      taskName: 'ArrivalAlert',
      taskTitle: `🔔 Monitoring ${notifiedLine(config.lineId)}`,
      taskDesc: `Alert when ≤${config.thresholdMin}min at ${config.stopName}`,
      taskIcon: { name: 'notification_icon', type: 'drawable' },
      color: config.color ?? '#6366F1',
      linkingURI: 'fck-oasa://',
      parameters: {},
    });
  } catch (err) {
    // Android 14+ throws ForegroundServiceStartNotAllowedException when the
    // app is not visible. Leaving the config set would show a pill for an
    // alert that is not running.
    console.warn('[alert] foreground service refused to start:', err);
    _watchActive = false;
    _alertConfig = previousConfig;
    _onAlertFired = null;
    notifyConfigChange();
    const message = 'Android would not start the alert service. Open the app and try again.';
    RNAlert.alert('Alert unavailable', message);
    return { ok: false, reason: 'service', message };
  }

  return { ok: true, replaced };
}

/** Stop the foreground service and release all resources. Never rejects. */
export async function stopAlertWatch(): Promise<void> {
  _generation++;
  _alertConfig = null;
  _onAlertFired = null;
  _watchActive = false;
  notifyConfigChange();

  _abort?.abort();
  _abort = null;
  _wake?.(); // cut the current poll delay short so the loop exits now

  await stopSilentLoop();
  await unloadArrivalSound();
  await restoreAudioMode();

  try {
    if (BackgroundService.isRunning()) await BackgroundService.stop();
  } catch (err) {
    // Both callers fire-and-forget this; an unhandled rejection here would
    // be a red box in dev and a silent crash report in release.
    console.warn('[alert] could not stop the foreground service:', err);
  }
}
