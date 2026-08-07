/**
 * Root layout — React Query provider, the boot gate, and the three app-wide
 * overlays (connectivity, arrival alert, self-update).
 *
 * Everything here is an *overlay*: nothing above `<Stack/>` is allowed to take
 * part in layout, because anything that does resizes every screen underneath
 * it the moment it appears.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  Animated,
  Easing,
  Image,
  View,
  Text,
  ActivityIndicator,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font, spacing, radius, withAlpha, HIT_SIZE } from '../src/theme';
import { UndoHost } from '../src/ui/UndoBar';
import { initStorage, prefetchFavoriteSchedules } from '../src/services/storage';
import { initLocation, type LocationInit } from '../src/services/location';
import { setupNetworkListener, useNetworkStatus } from '../src/services/network';
import { setupAppState } from '../src/services/appState';
import { checkForUpdate, cancelUpdateDownload, type UpdateProgress } from '../src/services/updater';
import { subscribeAlertConfig, stopAlertWatch, type AlertConfig } from '../src/services/notifications';
import { SettingsProvider } from '../src/features/settings/SettingsProvider';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      /**
       * `networkMode` is deliberately left at React Query's default
       * ('online'). It used to be 'always', which meant queries fired
       * regardless of connectivity and turned the whole
       * onlineManager ↔ NetInfo bridge in services/network.ts into dead
       * config: no pausing offline, no automatic resume on reconnect, just
       * three retries into a dead socket every poll interval.
       */
      // Arrival times are the entire point of the app, so coming back to it
      // should show current data. This only became meaningful once
      // setupAppState() started driving React Query's focusManager — before
      // that, Android never reported focus at all and the flag was moot.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      // Long enough that a remount or a screen transition reuses the last
      // response instead of re-fetching, short enough that a focus refetch
      // still happens when the user actually comes back to the app.
      staleTime: 15_000,
      gcTime: 5 * 60_000,
    },
  },
});

/* ── Boot ─────────────────────────────────────────────────────── */

/**
 * Hold the native splash until the JS boot gate has settled.
 *
 * Without this the splash tears down the instant RN's root view attaches —
 * which is before any content exists — so every launch flashed a bare spinner
 * on black. Called at module scope so it takes effect before the first render.
 * It rejects harmlessly if the splash is already gone.
 */
SplashScreen.preventAutoHideAsync().catch(() => {});

/** After this, tell the user something is wrong rather than spinning mutely. */
const BOOT_SLOW_MS = 4_000;
/** Hard cap. `initStorage()` rejecting is handled; `initStorage()` *hanging*
 *  used to leave the app on a spinner forever with no way out. */
const BOOT_TIMEOUT_MS = 12_000;

function BootScreen({ slow }: { slow: boolean }) {
  return (
    <View style={ls.boot}>
      <Image source={require('../assets/splash-icon.png')} style={ls.bootLogo} resizeMode="contain" />
      <Text style={ls.bootTitle}>F*ck OASA</Text>
      <ActivityIndicator size="small" color={colors.primaryLight} style={ls.bootSpinner} />
      {slow && (
        <Text style={ls.bootSlow}>
          Still starting up — loading saved stops is taking longer than usual.
        </Text>
      )}
    </View>
  );
}

/* ── Top overlay banners ──────────────────────────────────────── */

/**
 * A banner that floats over the navigator instead of sitting above it.
 *
 * The offline notice used to be a sibling of `<Stack/>`, so every connectivity
 * blip — including the routine Wi-Fi↔cellular handoffs NetInfo reports —
 * shoved the entire app down ~26px with no animation, and on iOS the text
 * landed under the status bar.
 */
interface BannerSpec {
  text: string;
  background: string;
  onPress?: () => void;
}

function TopBanner({ banner }: { banner: BannerSpec | null }) {
  const insets = useSafeAreaInsets();
  const anim = useRef(new Animated.Value(0)).current;
  // Hold the last spec so the exit animation plays out the banner that is
  // leaving rather than an empty bar.
  const [shown, setShown] = useState<BannerSpec | null>(banner);

  useEffect(() => {
    if (banner) setShown(banner);
    const animation = Animated.timing(anim, {
      toValue: banner ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !banner) setShown(null);
    });
    return () => animation.stop();
  }, [banner, anim]);

  if (!shown) return null;

  return (
    <Animated.View
      pointerEvents={banner ? 'box-none' : 'none'}
      style={[
        ls.bannerWrap,
        {
          paddingTop: insets.top,
          backgroundColor: shown.background,
          opacity: anim,
          transform: [
            { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-64, 0] }) },
          ],
        },
      ]}
    >
      <TouchableOpacity
        onPress={shown.onPress}
        disabled={!shown.onPress}
        activeOpacity={0.8}
        hitSlop={{ top: 0, bottom: spacing.sm, left: 0, right: 0 }}
        style={ls.bannerInner}
        accessibilityRole={shown.onPress ? 'button' : 'alert'}
        accessibilityLiveRegion="polite"
      >
        <Text style={ls.bannerText} numberOfLines={2}>{shown.text}</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

/** Debounce so a handoff between networks doesn't flash the banner. NetInfo
 *  reports a brief disconnect on every Wi-Fi↔cellular switch. */
const OFFLINE_GRACE_MS = 1_500;

function useSettledOffline(): boolean {
  const isOnline = useNetworkStatus();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (isOnline) {
      // Coming back is good news; show it immediately.
      setOffline(false);
      return;
    }
    const t = setTimeout(() => setOffline(true), OFFLINE_GRACE_MS);
    return () => clearTimeout(t);
  }, [isOnline]);

  return offline;
}

/* ── Alert Pill (floating) ────────────────────────────────────── */

function AlertPill() {
  const [alert, setAlert] = useState<AlertConfig | null>(null);
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const isMap = pathname.startsWith('/map');
  const [deferredIsMap, setDeferredIsMap] = useState(isMap);

  useEffect(() => subscribeAlertConfig(setAlert), []);

  // Delay position change to let screen transition finish
  useEffect(() => {
    const t = setTimeout(() => setDeferredIsMap(isMap), 350);
    return () => clearTimeout(t);
  }, [isMap]);

  if (!alert) return null;

  const posStyle = deferredIsMap
    ? { top: insets.top + spacing.xl + spacing.lg + spacing.xs, left: spacing.sm }
    : { top: insets.top + 19, right: spacing.xl + spacing.md };

  return (
    <View
      style={[ls.alertPill, posStyle]}
      // The visible text is deliberately terse — `040 ≤5'`. Left to itself a
      // screen reader reads the apostrophe as "feet", so the accessible name
      // spells the whole thing out instead.
      accessible
      accessibilityLabel={`Alert active: line ${alert.lineId} at ${alert.thresholdMin} minutes or less`}
    >
      <Text style={ls.alertPillIcon} importantForAccessibility="no">🔔</Text>
      <View style={ls.alertPillContent}>
        <Text style={ls.alertPillLine} numberOfLines={1}>{alert.lineId} ≤{alert.thresholdMin}'</Text>
      </View>
      <TouchableOpacity
        // `stopAlertWatch` is async; the bare call site produced an unhandled
        // rejection whenever teardown failed (killing a foreground service can).
        onPress={() => { stopAlertWatch().catch(() => {}); }}
        hitSlop={12}
        style={ls.alertPillClose}
        accessibilityRole="button"
        accessibilityLabel="Stop alert"
      >
        <Text style={ls.alertPillCloseText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

/* ── Update overlay ───────────────────────────────────────────── */

function updateLabel(p: UpdateProgress): string {
  switch (p.phase) {
    case 'verifying':
      return `Verifying download… ${Math.round(p.progress * 100)}%`;
    case 'installing':
      return 'Launching installer…';
    default:
      return `Downloading update… ${Math.round(p.progress * 100)}%`;
  }
}

const ls = StyleSheet.create({
  boot: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },
  bootLogo: { width: 96, height: 96 },
  bootTitle: {
    color: colors.text,
    fontSize: font.size.xl,
    fontWeight: '800',
    marginTop: spacing.md,
  },
  bootSpinner: { marginTop: spacing.lg },
  bootSlow: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  bannerWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 900,
    elevation: 900,
  },
  bannerInner: {
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  bannerText: {
    color: '#FFF',
    fontSize: font.size.xs,
    fontWeight: '700',
    textAlign: 'center',
  },
  alertPill: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.warning,
    borderRadius: radius.full,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.sm + 2,
    gap: spacing.xs,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 6,
  },
  alertPillIcon: { fontSize: 14 },
  alertPillContent: { },
  alertPillLine: {
    color: '#000',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  alertPillClose: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: withAlpha('#000000', 0.2),
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertPillCloseText: {
    color: '#000',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  updateOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: withAlpha('#000000', 0.6),
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 9999,
  },
  updateCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    width: 260,
  },
  updateText: {
    color: colors.text,
    fontSize: font.size.sm,
    fontWeight: '600',
  },
  updateHint: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    textAlign: 'center',
  },
  updateActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  updateLater: {
    marginTop: spacing.xs,
    minHeight: HIT_SIZE,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
  },
  updateLaterText: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  updatePill: {
    position: 'absolute',
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: HIT_SIZE,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    zIndex: 9998,
    elevation: 8,
  },
  updatePillText: {
    color: colors.text,
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  progressTrack: {
    width: '100%',
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    overflow: 'hidden' as const,
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primaryLight,
    borderRadius: 3,
  },
});

function UpdateOverlay({ progress }: { progress: UpdateProgress }) {
  const insets = useSafeAreaInsets();
  const [hidden, setHidden] = useState(false);
  const active =
    progress.phase === 'downloading' ||
    progress.phase === 'verifying' ||
    progress.phase === 'installing';

  // A new download re-opens the card; otherwise "hide" would stick for the
  // rest of the process and the user would never see the installer coming.
  useEffect(() => {
    if (!active) setHidden(false);
  }, [active]);

  if (!active) return null;

  const pct = Math.round(progress.progress * 100);

  if (hidden) {
    return (
      <TouchableOpacity
        style={[ls.updatePill, { bottom: insets.bottom + spacing.lg }]}
        onPress={() => setHidden(false)}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={
          progress.phase === 'installing'
            ? 'Update ready to install. Show details'
            : `Update downloading, ${pct} percent. Show details`
        }
      >
        <ActivityIndicator size="small" color={colors.primaryLight} />
        <Text style={ls.updatePillText}>
          {progress.phase === 'installing' ? 'Update ready' : `Update ${pct}%`}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={ls.updateOverlay}>
      <View style={ls.updateCard}>
        <ActivityIndicator size="small" color={colors.primaryLight} />
        <Text style={ls.updateText}>{updateLabel(progress)}</Text>
        <View style={ls.progressTrack}>
          <View style={[ls.progressFill, { width: `${pct}%` }]} />
        </View>
        {/* The old overlay was modal and uncancellable: opening the app to
            catch a bus meant staring at a 40MB download with no way out. */}
        {progress.phase === 'downloading' && (
          <>
            <Text style={ls.updateHint}>Keeps going in the background.</Text>
            <View style={ls.updateActions}>
              <TouchableOpacity
                style={ls.updateLater}
                onPress={() => setHidden(true)}
                accessibilityRole="button"
                accessibilityLabel="Later. Hide this and keep downloading in the background"
              >
                <Text style={ls.updateLaterText}>LATER</Text>
              </TouchableOpacity>
              {/* Hiding the overlay is not the same as declining the update.
                  Someone on mobile data needs to be able to actually stop a
                  ~40MB transfer, not just stop looking at it. */}
              <TouchableOpacity
                style={ls.updateLater}
                onPress={() => { cancelUpdateDownload().catch(() => {}); }}
                accessibilityRole="button"
                accessibilityLabel="Cancel this update download"
              >
                <Text style={ls.updateLaterText}>CANCEL</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
        {/* Verifying is short but not instant on a ~40MB APK, and cancelling
            mid-hash would just discard finished work. */}
        {progress.phase === 'verifying' && (
          <Text style={ls.updateHint}>Checking the download is intact…</Text>
        )}
      </View>
    </View>
  );
}

/* ── Root ─────────────────────────────────────────────────────── */

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [bootSlow, setBootSlow] = useState(false);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress>({ phase: 'idle', progress: 0 });

  useEffect(() => {
    setupNetworkListener();
    setupAppState();

    // Only storage gates the first frame. `initLocation()` used to sit here
    // too, which meant the app hung on a bare spinner behind the OS location
    // permission dialog — and if any of these rejected (GPS switched off makes
    // watchPositionAsync reject) `setReady(true)` never ran and the app was
    // bricked on a black screen. The API base is now resolved lazily, so no
    // network call blocks startup either.
    let cancelled = false;
    let settled = false;

    const release = () => {
      if (cancelled || settled) return;
      settled = true;
      setReady(true);
      // Hand off from the native splash only once there is real content to
      // show, so there is no blank frame between the two.
      SplashScreen.hideAsync().catch(() => {});

      // Everything below is best-effort and must never block or throw.
      initLocation()
        .then((init: LocationInit) => {
          if (cancelled || init.status === 'ok') return;
          // 'denied' and 'unavailable' (location services switched off at the
          // OS level) both used to produce a map that silently never centred
          // on the user, with nothing on screen to explain why.
          setLocationNotice(init.message ?? 'Location is unavailable — nearby stops are disabled.');
        })
        .catch(() => {});
      prefetchFavoriteSchedules().catch(() => {});
      checkForUpdate(setUpdateProgress).catch(() => {});
    };

    const slowTimer = setTimeout(() => { if (!cancelled) setBootSlow(true); }, BOOT_SLOW_MS);
    const bailTimer = setTimeout(() => {
      console.warn('[boot] storage init did not settle in time — starting anyway');
      release();
    }, BOOT_TIMEOUT_MS);

    initStorage()
      .catch((err) => {
        // A failed storage init must still let the user into the app; the
        // screens degrade to empty state rather than an infinite spinner.
        console.warn('[boot] storage init failed:', err);
      })
      .finally(() => {
        clearTimeout(bailTimer);
        release();
      });

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      clearTimeout(bailTimer);
    };
  }, []);

  const offline = useSettledOffline();
  const dismissLocationNotice = useCallback(() => setLocationNotice(null), []);

  // Offline is the more urgent of the two, and stacking banners would put us
  // right back to shoving content around.
  const banner = useMemo<BannerSpec | null>(() => {
    if (offline) {
      return { text: 'You are offline — showing cached data', background: '#B91C1C' };
    }
    if (locationNotice) {
      return { text: `${locationNotice} Tap to dismiss.`, background: '#B45309', onPress: dismissLocationNotice };
    }
    return null;
  }, [offline, locationNotice, dismissLocationNotice]);

  if (!ready) return <BootScreen slow={bootSlow} />;

  return (
    /* Gesture root. react-native-gesture-handler was already a (transitive)
       dependency but was never mounted, so any pan/long-press handler outside
       React Navigation's own gestures silently did nothing on Android — no
       error, just dead touches. Everything below can now use gestures. */
    <GestureHandlerRootView style={rootStyles.flex}>
    <SettingsProvider>
    <QueryClientProvider client={queryClient}>
      <StatusBar style="light" backgroundColor={colors.bg} />
      {/* Route modules are already required lazily in release builds:
          expo-router hands React Navigation a `getComponent` thunk and
          Metro's require.context exposes each route behind a getter, so
          `loadRoute()` only runs when a screen is first rendered.
          EXPO_ROUTER_IMPORT_MODE=lazy would only add a React.lazy + Suspense
          hop — no code-splitting win on native, one extra blank frame per
          navigation — so it is intentionally left off. (Dev builds do eager
          load every route; that is expo-router's missing-default-export
          check, and it does not ship.) */}
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: colors.bg },
          animation: 'slide_from_right',
        }}
      />
      <TopBanner banner={banner} />
      <AlertPill />
      <UpdateOverlay progress={updateProgress} />
      {/* Undo toasts. Last sibling so it draws above every other overlay, and
          an overlay itself — it must never take part in layout. */}
      <UndoHost />
    </QueryClientProvider>
    </SettingsProvider>
    </GestureHandlerRootView>
  );
}

const rootStyles = StyleSheet.create({ flex: { flex: 1 } });
