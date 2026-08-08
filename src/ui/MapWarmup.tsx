/**
 * Google Maps warm-up — a hidden `<MapView>` mounted once per process so the
 * first *real* map screen does not pay for the SDK coming up.
 *
 * ── What opening a map for the first time actually costs ──
 *
 * Most of the wait on a cold first map open is process-wide, one-time work that
 * has nothing to do with which line the user picked:
 *
 *  1. Play Services side-loads the `maps_core` dynamite module — the
 *     `nativeloader: Load … split_maps_core_dynamite_ondemand.apk!/…/libgmm-jni.so`
 *     line in logcat. It is a classloader + `dlopen` on the UI thread.
 *  2. `MapsInitializer` runs and the renderer is chosen (once per process; it
 *     cannot change afterwards).
 *  3. The GL surface is created and the cloud style for the Map ID is fetched.
 *
 * (1) and (2) survive this view being torn down: a loaded native library is not
 * `dlclose`d and the renderer decision is static state inside the Maps SDK. (3)
 * is half-and-half — the cloud style and the basemap land in the SDK's own disk
 * cache and survive, the EGL surface does not and cannot be handed to another
 * MapView anyway.
 *
 * That asymmetry is the whole design: the expensive half is permanent, the half
 * that would need us to stay mounted is the cheap half. So this tears itself
 * down once it has rendered rather than holding a GL surface and its buffers for
 * the lifetime of the process — memory that on a low-end device mostly buys a
 * higher chance of being killed in the background, which throws away the warm
 * state we just paid for. Two live maps at once (this plus a real screen) is
 * also the configuration Google Maps on Android is least happy with, and the
 * native stack already keeps both map screens mounted at the same time.
 *
 * What this does NOT buy: tiles for a region the user has not opened yet. The
 * warm-up sits at the same initial region the map screens use, so a first open
 * that stays near the user is partly pre-fetched, but `LiveMapScreen` fits the
 * camera to the whole route seconds later and that is a fresh tile fetch.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { InteractionManager, Platform, StyleSheet, View } from 'react-native';
import { usePathname } from 'expo-router';
import MapView, { PROVIDER_GOOGLE } from 'react-native-maps';
import { useInitialRegion } from '../hooks/useInitialRegion';
import { GOOGLE_DARK_STYLE, GOOGLE_MAP_ID } from '../theme/googleMapStyle';

/**
 * Kill switch. Flip to `false` (or drop the one `<MapWarmup />` line from
 * app/_layout.tsx) and the app behaves exactly as it did before — nothing else
 * reads this module.
 *
 * Android only, and not merely because the dynamite module is an Android/Play
 * Services concept: iOS has no `googleMaps` API key in app.config.ts, so
 * `PROVIDER_GOOGLE` there is already a crash waiting at the first map screen.
 * Warming at boot would move that crash to launch, which is strictly worse.
 */
export const MAP_WARMUP_ENABLED = Platform.OS === 'android';

/**
 * How long after the first screen has settled before the warm-up mounts.
 *
 * The point is to not compete with the boot it exists to help: the dynamite load
 * blocks the UI thread for a few hundred ms, and doing that while the user is
 * reading (or scrolling) the favourites list would be a visible stutter in
 * exchange for a saving they cannot see yet. `runAfterInteractions` alone is not
 * enough — with no animation in flight it fires almost immediately — so the
 * delay does the real work. Long enough to clear the first paint and the boot's
 * own follow-up work (location init, schedule prefetch, update check), short
 * enough to still be ahead of a user who taps a line straight away.
 */
const WARMUP_DELAY_MS = 1_500;

/**
 * Hard cap on how long the hidden map may stay mounted. `onMapLoaded` needs
 * tiles, so offline it may never fire at all — without this the warm-up would
 * quietly become the permanent GL surface we decided not to keep.
 */
const WARMUP_MAX_MS = 8_000;

/** Grace period after `onMapLoaded` so the SDK's style/tile cache writes are not
 *  racing our teardown. Cheap insurance; nothing depends on it being exact. */
const WARMUP_LINGER_MS = 500;

/**
 * Square, in dp. Not 1×1: a degenerate viewport risks the surface being
 * optimised away, fetches nothing worth caching, and would likely never reach
 * `onMapLoaded` — leaving the teardown to the timeout every launch. 256 is
 * Google's tile size, so this covers one to four tiles at any zoom, which is
 * enough to exercise the whole fetch → decode → GL upload → composite path,
 * while its framebuffer is a fraction of a full-screen surface's.
 */
const WARMUP_SIZE = 256;

/** Once per process, not once per mount — Fast Refresh and any remount of the
 *  root layout must not warm a second time. */
let warmed = false;

type Phase = 'idle' | 'warming' | 'loaded' | 'done';

export function MapWarmup() {
  const [phase, setPhase] = useState<Phase>(() => (warmed ? 'done' : 'idle'));
  // Read through a ref: the delay must not re-arm on every navigation, but the
  // check below has to see where the user is when it fires, not where they were
  // when the app booted.
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  // Same region the map screens open at (user's position, else Athens centre),
  // so whatever basemap data this does pull is data they can reuse.
  const region = useInitialRegion(0.05);

  useEffect(() => {
    if (!MAP_WARMUP_ENABLED || phase !== 'idle') return;
    let timer: ReturnType<typeof setTimeout>;
    const interaction = InteractionManager.runAfterInteractions(() => {
      timer = setTimeout(() => {
        warmed = true;
        // A deep link (`fck-oasa://map/...`) can put a real map on screen before
        // this fires. Mounting a second one alongside it is the one case where
        // the warm-up is pure cost: the real map is already doing all of it.
        setPhase(pathnameRef.current.startsWith('/map') ? 'done' : 'warming');
      }, WARMUP_DELAY_MS);
    });
    return () => {
      interaction.cancel();
      clearTimeout(timer);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== 'warming' && phase !== 'loaded') return;
    const t = setTimeout(
      () => setPhase('done'),
      phase === 'loaded' ? WARMUP_LINGER_MS : WARMUP_MAX_MS,
    );
    return () => clearTimeout(t);
  }, [phase]);

  const onMapLoaded = useCallback(() => setPhase('loaded'), []);

  if (phase !== 'warming' && phase !== 'loaded') return null;

  return (
    /* Offscreen but still laid out, exactly as BusMarkerRenderer and
       StopMarkerCaptureHost do it — a map that is never laid out is a map that
       never initialises anything. Absolute, so it takes no part in layout and
       cannot resize the screen underneath it. Hidden from screen readers too:
       a Google map is full of focusable native content and TalkBack would
       otherwise be able to land on a map nobody can see. */
    <View
      style={ws.hidden}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <MapView
        // provider / googleMapId / customMapStyle must match the real screens.
        // The cloud style is fetched per Map ID, and the renderer is picked once
        // per process — warming a differently configured map warms the wrong
        // things. `liteMode` would be tempting and useless for the same reason:
        // it is a static bitmap on a different code path, not the GL renderer.
        provider={PROVIDER_GOOGLE}
        style={ws.map}
        initialRegion={region}
        customMapStyle={GOOGLE_DARK_STYLE}
        googleMapId={GOOGLE_MAP_ID}
        onMapLoaded={onMapLoaded}
        // Nothing here is interactive or observable, so everything optional is
        // off. `showsUserLocation` in particular stays false: it would ask for
        // the location permission from a view the user cannot see.
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
      />
    </View>
  );
}

const ws = StyleSheet.create({
  hidden: {
    position: 'absolute',
    top: -9999,
    left: -9999,
    opacity: 0,
  },
  map: { width: WARMUP_SIZE, height: WARMUP_SIZE },
});
