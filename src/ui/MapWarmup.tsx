/**
 * When map surfaces get created — the two levers on a first map open.
 *
 *  1. `MapWarmup`, below: a hidden `<MapView>` mounted once per process so the
 *     first *real* map screen does not pay for the SDK coming up.
 *  2. `useDeferredMapMount`, further down: holds a screen's own `<MapView>` back
 *     until that screen's push animation has finished, so whatever native setup
 *     is left does not land on the UI thread while the animation is running.
 *
 * They attack different halves of the same complaint — "the transition freezes
 * for half a second on the first line I open" — and they are independent bets:
 * (1) makes the work happen earlier, (2) makes it happen somewhere it cannot be
 * seen. `MAP_WARMUP_ENABLED` kills the first, `MAP_MOUNT_AFTER_TRANSITION` the
 * second, and either can be reverted without touching the other.
 *
 * The marks have since been read off a device, and they are unkind to (1):
 * warming the process does not make the *next* MapView cheaper. The warm-up's
 * own construction took 261ms and the first real screen's took 259ms with the
 * SDK already up — the same number twice. See `src/utils/mapPerf.ts` for the log.
 * What the marks do settle is the mechanism below: this map is parked wholly
 * offscreen at zero opacity and it still reached `onMapLoaded`, which was the one
 * thing about it in genuine doubt.
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
import { usePathname, useNavigation } from 'expo-router';
import MapView, { PROVIDER_GOOGLE } from 'react-native-maps';
import { mapPerf } from '../utils/mapPerf';
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
 * This was 1,500ms, and that is the most likely reason the warm-up was reported
 * as doing nothing at all. The case it exists for is a user who opens a saved
 * line seconds after launch — and at 1.5s the warm-up had not even armed by the
 * time they tapped. A warm-up that arms after the event it is warming for is
 * dead code that owns a GL surface.
 *
 * It cannot be zero either. The dynamite load blocks the UI thread for a few
 * hundred ms, and mounting in the same commit as Home's first frame would spend
 * that block between `SplashScreen.hideAsync()` and Home actually appearing — a
 * stall the user certainly *would* see, traded for one they might not.
 *
 * So: long enough for the first paint to have landed, short enough to be ahead
 * of any realistic tap. The old comment here defended 1.5s as "do not stutter a
 * screen the user is scrolling", and that concern is real — but it is not this
 * window. A quarter-second after first paint the favourites list is static and
 * nobody has reached it yet, and a UI-thread block on a screen with nothing
 * moving on it has nothing to stutter. What is left is a tap landing *inside*
 * the load (roughly 250-650ms in), and that is an argument for arming early
 * rather than merely earlier: the sooner it starts, the sooner it is over.
 */
const WARMUP_DELAY_MS = 250;

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

/** Live phase, mirrored out of React state for `warmupPhase()`. */
let livePhase: Phase = 'idle';

/**
 * Where the warm-up has got to, for the timing marks.
 *
 * The one thing the marks could not answer before: when a map screen opened, was
 * the warm-up finished, still mid dynamite-load, or never armed? A tap that
 * lands while the warm-up is blocking the UI thread has the same symptom as no
 * warm-up at all, and lowering `WARMUP_DELAY_MS` makes that collision more
 * likely, not less — so it has to be visible in the log.
 */
export function warmupPhase(): Phase | 'off' {
  return MAP_WARMUP_ENABLED ? livePhase : 'off';
}

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

  // Mirror the phase out for `warmupPhase()`. In an effect rather than beside
  // each `setPhase` so it cannot drift from what actually rendered.
  useEffect(() => { livePhase = phase; }, [phase]);

  useEffect(() => {
    if (!MAP_WARMUP_ENABLED || phase !== 'idle') return;
    let timer: ReturnType<typeof setTimeout>;
    const interaction = InteractionManager.runAfterInteractions(() => {
      timer = setTimeout(() => {
        warmed = true;
        // A deep link (`fck-oasa://map/...`) can put a real map on screen before
        // this fires. Mounting a second one alongside it is the one case where
        // the warm-up is pure cost: the real map is already doing all of it.
        const onMapRoute = pathnameRef.current.startsWith('/map');
        mapPerf(onMapRoute ? 'warmup skipped (already on a map)' : 'warmup armed');
        setPhase(onMapRoute ? 'done' : 'warming');
      }, WARMUP_DELAY_MS);
    });
    return () => {
      interaction.cancel();
      clearTimeout(timer);
    };
  }, [phase]);

  /* Teardown stays on a timer and is deliberately NOT triggered by navigating to
     a map route, tempting as that is now that arming at 250ms makes an overlap
     with a real map screen likely. `pathname` changes when the route is *pushed*,
     which is the start of the transition — so a navigation-driven teardown would
     destroy a GL surface on the UI thread during exactly the animation
     `useDeferredMapMount` exists to keep clear. Two live maps for a second is the
     cheaper of the two evils, and the native stack already keeps both real map
     screens mounted at once. */
  useEffect(() => {
    if (phase !== 'warming' && phase !== 'loaded') return;
    const t = setTimeout(
      () => {
        /* Which branch this is, is the whole question: 'loaded' means the
           hidden map really drew and the warm-up did its job; 'cap' means
           onMapLoaded never fired and only SDK init was warmed. */
        mapPerf(phase === 'loaded' ? 'warmup torn down (loaded)' : 'warmup torn down (CAP — never loaded)');
        setPhase('done');
      },
      phase === 'loaded' ? WARMUP_LINGER_MS : WARMUP_MAX_MS,
    );
    return () => clearTimeout(t);
  }, [phase]);

  const onMapLoaded = useCallback(() => {
    mapPerf('warmup onMapLoaded');
    setPhase('loaded');
  }, []);
  const onMapReady = useCallback(() => mapPerf('warmup onMapReady'), []);

  if (phase !== 'warming' && phase !== 'loaded') return null;

  return (
    /* Laid out but not visible — a map that is never laid out is a map that
       never initialises anything. Absolute, so it takes no part in layout and
       cannot resize the screen underneath it. Hidden from screen readers too:
       a Google map is full of focusable native content and TalkBack would
       otherwise be able to land on a map nobody can see.

       This used to claim it did this "exactly as BusMarkerRenderer and
       StopMarkerCaptureHost do it" and then omitted the one prop that matters:
       `collapsable={false}`. The wrapper has no visual of its own, so RN's view
       flattening is entitled to remove it — and with it the pointer-event and
       accessibility props above. The SVG hosts both set it; this did not. */
    <View
      style={ws.hidden}
      pointerEvents="none"
      collapsable={false}
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
        onMapReady={onMapReady}
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

/* ── Lever 2: keeping a screen's MapView off the transition ──── */

/**
 * Kill switch for the deferred mount. Separate from `MAP_WARMUP_ENABLED` because
 * these are two independent bets and at most one of them is the actual fix.
 *
 * Not restricted to Android, unlike the warm-up: the mechanism here is not a
 * Play Services one. Creating a native map view costs UI-thread time on any
 * platform, and a native-stack transition is animated on that same thread.
 */
export const MAP_MOUNT_AFTER_TRANSITION = true;

/**
 * Fallback for a `transitionEnd` that never arrives.
 *
 * It has to exist — a screen that never emits the event would otherwise be a
 * screen whose map is never created, a permanently blank map rather than a slow
 * one — but it should never actually fire, and the marks say so if it does.
 * react-native-screens dispatches `onAppear` (which `NativeStackView` turns into
 * `transitionEnd`) from the fragment's `Animation.AnimationListener`, and it goes
 * out of its way to always have an animation to listen to: `StackAnimation.NONE`
 * is implemented as a real 20ms `rns_no_animation_20`, and the *first* screen
 * pushed onto a stack is given exactly that. So a deep link straight to a map
 * gets the event too.
 *
 * Size: `slide_from_right` is `rns_slide_in_from_right`, i.e.
 * `config_mediumAnimTime` — 400ms on stock Android, and 800ms for anyone running
 * a 2× animator scale. Short is the dangerous direction: a cap that beats the
 * transition silently puts the MapView back on the animation's critical path,
 * which is the one thing this exists to avoid, and nothing in the log would say
 * so. A cap that fires late only costs first-paint time on a path we do not
 * expect to reach at all. Hence generous.
 */
const MAP_MOUNT_CAP_MS = 900;

/**
 * The slice of the route-scoped navigation object this needs.
 *
 * `transitionEnd` is a native-stack event and is not in the event map of
 * expo-router's default `useNavigation` type, so it is named here rather than
 * reached for through `any`. `NativeStackView` emits it from
 * react-native-screens' `onAppear`/`onDisappear`, targeted at this route's key.
 */
interface TransitionAwareNavigation {
  addListener(
    type: 'transitionEnd',
    listener: (e: { data?: { closing?: boolean } }) => void,
  ): () => void;
}

/**
 * `false` until this screen's push animation has finished, then `true` for the
 * rest of the screen's life. Gate the screen's `<MapView>` on it.
 *
 * Why: expo-router's stack is `react-native-screens`, so the push animation runs
 * natively on the UI thread. JS work cannot freeze it — but native view creation
 * can, and building a Google MapView is precisely that: a classloader load, a
 * `dlopen`, `MapsInitializer`, an EGL surface. Doing it while the animation is in
 * flight is two pieces of UI-thread work competing, and the animation is the one
 * the user is looking at. Waiting turns a frozen transition into a smooth
 * transition with the map arriving a beat later, which is what "seamless" asks
 * for even though it is strictly *later*.
 *
 * What it costs, honestly: the map is now definitively created later. If the
 * stall turns out not to have been on the UI thread, this buys nothing and
 * pushes first tiles out by the length of one transition — so it is a hypothesis
 * with a price, and `MAP_MOUNT_AFTER_TRANSITION` is how you take it back.
 *
 * Nothing else is deferred. The route, stop, shape and bus requests are JS and
 * network, they never touched the UI thread, and they still start at mount — so
 * by the time the map exists its data is usually already in hand. That is also
 * why the screens must keep rendering their dark background and `MapStatus`
 * while this is false: during the transition a mounted map would have shown
 * `loadingBackgroundColor` (the same colour) and a spinner anyway, so there is
 * nothing new to look at, only something missing that was never visible.
 *
 * Deliberately NOT `InteractionManager.runAfterInteractions`: it resolves when
 * no JS interaction handle is pending and knows nothing about a native
 * transition, so with no JS-driven animation in flight it fires almost at once
 * and would defer nothing at all. The timer above is the fallback instead.
 */
export function useDeferredMapMount(label: string): boolean {
  const [mounted, setMounted] = useState(!MAP_MOUNT_AFTER_TRANSITION);
  const navigation = useNavigation<TransitionAwareNavigation>();
  /* Through a ref: React Navigation rebuilds the per-route navigation object
     whenever the stack's state changes, and an effect keyed on it would
     resubscribe — and restart the cap timer — on every navigation. */
  const navRef = useRef(navigation);
  navRef.current = navigation;

  useEffect(() => {
    if (mounted) return;
    let released = false;
    const release = (why: string) => {
      if (released) return;
      released = true;
      /* `warmup=` is the other half of the diagnosis: a tap that lands while the
         warm-up is still blocking the UI thread looks identical to no warm-up. */
      mapPerf(`${label} mount released (${why}, warmup=${warmupPhase()})`);
      setMounted(true);
    };

    const unsubscribe = navRef.current.addListener('transitionEnd', (e) => {
      // `closing: true` is this screen going *away* — popped, or covered by a
      // push on top of it. Neither is our cue.
      if (e?.data?.closing) return;
      release('transitionEnd');
    });
    const cap = setTimeout(() => release('CAP — no transitionEnd'), MAP_MOUNT_CAP_MS);

    return () => {
      unsubscribe();
      clearTimeout(cap);
    };
  }, [mounted, label]);

  return mounted;
}

const ws = StyleSheet.create({
  /* Fully offscreen and fully transparent, exactly as the SVG capture hosts do
     it. This briefly grew a one-dp sliver on screen and `opacity: 0.01`, on the
     theory that a SurfaceView lying entirely outside the display bounds is never
     composited, so its buffers are never latched and `onMapLoaded` can never
     fire. Plausible, and wrong: the marks off a 1.2.5 release build read

         +2071ms warmup onMapReady
         +2309ms warmup onMapLoaded
         +2821ms warmup torn down (loaded)

     from precisely this arrangement. `onMapLoaded` fires from a map nobody can
     see, so there is nothing to hedge against and no reason to put a row of live
     basemap under the status bar. The sliver is gone and so is the hypothesis. */
  hidden: {
    position: 'absolute',
    top: -9999,
    left: -9999,
    opacity: 0,
  },
  map: { width: WARMUP_SIZE, height: WARMUP_SIZE },
});
