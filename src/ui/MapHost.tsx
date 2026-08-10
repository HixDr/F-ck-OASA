/**
 * One MapView for the whole process, hosted behind the navigator.
 *
 * ── Why ──
 *
 * Constructing a Google MapView on Android costs ~259ms of UI-thread time, and
 * the marks say that number is paid in full even with the SDK already warm: the
 * boot warm-up's own map took 261ms and the first real screen's took 259ms after
 * it (see `src/utils/mapPerf.ts` for the log). Nothing about warming helps,
 * because the expensive half — the EGL surface — cannot be handed from one
 * MapView to another. The only way to stop paying it per screen is to stop
 * creating one per screen.
 *
 * So there is exactly one. It is created once, a quarter-second after the app's
 * first paint, and it lives until the process dies. Screens borrow it.
 *
 * ── Where it lives, and why *behind* the navigator ──
 *
 * `<MapHost/>` is a root-level, absolutely-positioned sibling rendered BEFORE
 * `<Stack/>`, which on Android means it draws underneath every screen. A map
 * screen then makes its own background transparent and the shared map shows
 * through the hole.
 *
 * That direction is not arbitrary. The alternative — hosting above the navigator
 * and having each screen portal its controls, sheets and status pills up into the
 * host so they still draw over the map — was written out and rejected, for three
 * reasons:
 *
 *  1. Concealment. A borrowed map has to be hidden whenever no screen wants it,
 *     and hiding a live SurfaceView is the one thing Android is bad at:
 *     `display: none` destroys the surface (which is the asset we are protecting),
 *     translating it offscreen does not reliably move the layer, and its alpha
 *     goes straight to the compositor. Behind the navigator, concealment is not a
 *     mechanism at all — the screen on top is simply opaque. The surface is
 *     created once, laid out once, and never moved, resized, faded or hidden for
 *     the rest of the process. That is the safest possible life for it.
 *  2. Every overlay stays where it is. Controls, the stop sheet, the timetable
 *     card, `MapStatus`, the planner's bottom sheet — all already absolutely
 *     positioned inside the screen, all still inside the screen, all still
 *     animating in and out with the push transition that owns them. Only the
 *     map's *children* (markers, polylines, layers) have to travel.
 *  3. The header stays the header. A host above the navigator has to be inset
 *     out of the native header's way and would otherwise eat taps on it.
 *
 * What hosting behind the navigator relies on is that react-native-screens
 * detaches every screen below the top one, so a transparent top screen reveals
 * the host rather than the screen underneath. It does: `ScreenStack.onUpdate()`
 * computes `visibleBottom` as the first non-translucent screen from the top,
 * which for a plain push stack is the top screen itself, and then removes the
 * fragment of everything beneath it. Only during a transition are two screens
 * attached at once — which is exactly why a screen stays opaque until its
 * animation has finished (see the reveal effect in `useMapSurface`).
 *
 * Touches reach the map by ordinary Android dispatch. `ReactRootView`
 * only observes touches (`onInterceptTouchEvent` returns false), `ScreenContainer`
 * and `Screen` do not consume them, and a ViewGroup whose subtree declines an
 * event lets its parent try the next sibling — which is this. RN's own
 * `pointerEvents` is a JS-dispatch concept and does not stop that, so an
 * unrevealed map is kept out of the way by turning its gestures off instead.
 *
 * ── What this replaced ──
 *
 * `MapWarmup`. A hidden 256dp map at boot existed to make the *next* MapView
 * cheaper, which the marks say it cannot. This host does the same arming at the
 * same moment for the same reason — get the dynamite load and MapsInitializer off
 * the first tap — except the map it builds is the one the screens actually use,
 * and it is never torn down. Two live maps at boot would be pure cost.
 *
 * ── Teardown ──
 *
 * There isn't one, and that is the decision rather than an omission.
 *
 * When the last map screen closes, the claim is released: the markers come off,
 * gestures go off, and the surface stays. Rebuilding it would cost the 259ms this
 * whole file exists to delete, and it would cost it again on the next open.
 *
 * On backgrounding it also stays. The warm-up used to argue that holding a GL
 * surface in the background mostly buys a higher chance of being killed, and that
 * was the right call for a map nobody was going to use; it is the wrong call for
 * the map every screen uses, and the premise is weaker than it looks —
 * react-native-maps forwards the host activity's lifecycle to `MapView.onPause()`,
 * so the SDK releases its own GL and tile caches while we are away and picks them
 * back up on resume. What we hold onto in the background is the view, not the
 * renderer's working set. If the process is killed anyway, the next launch is a
 * cold boot and pays for the map once, at boot, off the critical path.
 */

import React, {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  useSyncExternalStore,
} from 'react';
import {
  InteractionManager, Platform, StyleSheet, View, useWindowDimensions,
  type StyleProp, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from 'expo-router';
import MapView, { PROVIDER_GOOGLE, type EdgePadding, type Region } from 'react-native-maps';
import { colors } from '../theme';
import { GOOGLE_DARK_STYLE, GOOGLE_MAP_ID } from '../theme/googleMapStyle';
import { useInitialRegion } from '../hooks/useInitialRegion';
import { mapNow, mapPerf } from '../utils/mapPerf';

/* ── Levers ──────────────────────────────────────────────────── */

/**
 * Hold a screen's reveal back until its push animation has finished.
 *
 * This is the surviving half of the 1.2.6 pair, and the persistent map did NOT
 * make it dead code — it changed what it defers. There is no MapView to build
 * any more, but taking the surface still costs UI-thread work: the camera handover
 * and, much more expensively, the claiming screen's markers. A fitted line map is
 * a 300-point polyline plus a native marker view per visible stop, each of which
 * is a snapshotted bitmap on Android. Attaching that while a native-stack
 * transition is animating on the same thread is the original complaint with a
 * different cause, so it waits, and the screen shows the same dark panel it shows
 * today. Flip to `false` and every claim reveals at mount instead.
 *
 * Not restricted to Android: the mechanism is a transition on the UI thread, not
 * a Play Services one.
 */
export const MAP_MOUNT_AFTER_TRANSITION = true;

/**
 * How long after the first screen has settled before the map is created.
 *
 * Inherited wholesale from the warm-up, including its reasoning. It cannot be
 * zero — the maps_core dynamite load blocks the UI thread for a few hundred ms,
 * and paying that in the same commit as Home's first frame puts a stall between
 * `SplashScreen.hideAsync()` and Home appearing. It must not be long either: the
 * case this exists for is someone opening a saved line seconds after launch, and
 * a warm-up that arms after the tap it is warming for is dead code holding a GL
 * surface. A quarter-second after first paint, Home is static and nobody has
 * reached it yet.
 */
const ARM_DELAY_MS = 250;

/**
 * Whether to arm at boot at all.
 *
 * Android only, and not because dynamite is an Android concept: iOS has no
 * `googleMaps` API key in app.config.ts, so `PROVIDER_GOOGLE` there is already a
 * crash waiting at the first map screen. Building the map at launch would move
 * that crash to launch, which is strictly worse. Elsewhere the host arms the
 * moment a map route appears — later, but no earlier than today.
 */
const ARM_AT_BOOT = Platform.OS === 'android';

/**
 * Fallback for a `transitionEnd` that never arrives.
 *
 * It has to exist — a screen that never emits the event would otherwise never
 * reveal its map, which is a permanently black screen rather than a slow one —
 * but it should never fire, and the marks say so if it does.
 * react-native-screens goes out of its way to always have an animation to listen
 * to: `StackAnimation.NONE` is a real 20ms `rns_no_animation_20`, and the first
 * screen pushed onto a stack is given exactly that, so a deep link straight to a
 * map gets the event too.
 *
 * Short is the dangerous direction: a cap that beats the transition puts the
 * marker work back on the animation, which is the one thing this avoids, and
 * nothing in the log would say so. `slide_from_right` is `config_mediumAnimTime`
 * — 400ms stock, 800ms at a 2× animator scale. Hence generous.
 */
const REVEAL_CAP_MS = 900;

/**
 * Header height in dp, used only to guess where the map will end up before any
 * screen has told us.
 *
 * react-native-screens draws the Android header in a Toolbar sized to
 * `?attr/actionBarSize`, which is 56dp, offset by the status-bar inset. Being
 * wrong here costs one surface resize on the first open, behind an opaque screen,
 * once per process — the guess only decides where the map sits while nobody can
 * see it. The instant a screen measures its own hole, the measurement wins.
 */
const HEADER_DP = 56;

/* ── Types ───────────────────────────────────────────────────── */

/** Window-space rectangle the map should occupy. */
export interface MapFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

type PressEvent = { nativeEvent: { coordinate: { latitude: number; longitude: number } } };

/** Everything a screen tells the host about how it wants the map to behave. */
export interface MapSurfaceSpec {
  /** Name used in the timing marks: 'line map', 'nearby map', 'planner map'. */
  label: string;
  /** True while this screen owns the map — normally the screen's focus state. */
  focused: boolean;
  /** Camera for a first visit. Ignored on a return, which restores instead. */
  initialRegion: Region;
  /** Markers, polylines and layers. Attached only once the screen is revealed. */
  children: React.ReactNode;
  /** Live's camera is 2D only. */
  pitchEnabled?: boolean;
  /** The planner's sheet covers the bottom of the map; the camera must know. */
  mapPadding?: EdgePadding;
  onPress?: (e: PressEvent) => void;
  onLongPress?: (e: PressEvent) => void;
  onRegionChangeStart?: () => void;
  onRegionChangeComplete?: (region: Region) => void;
}

/** What a claiming screen gets back. */
export interface MapSurface {
  /**
   * True once the shared map is drawing through this screen. The screen's own
   * background must be transparent exactly when this is true and opaque
   * otherwise; anything else shows either the screen underneath through the hole,
   * or a black rectangle where the map should be.
   *
   * Not the same as "interactive": a screen being popped stays revealed through
   * its exit animation, and the host stops taking gestures for it the moment it
   * loses focus.
   */
  revealed: boolean;
  /** True once the host's map exists and has reported ready. */
  ready: boolean;
  /**
   * The shared MapView, or null while another screen holds it. For imperative
   * camera work only — `fitToCoordinates`, `animateToRegion`. Deliberately a
   * getter rather than a ref, so that every call site is re-checked at call time:
   * a line map two deep in the stack whose stops finally arrive must not reframe
   * the camera under the screen on top of it.
   */
  getMap: () => MapView | null;
  /** Hand to `<MapSurfaceSlot onFrame=…/>` where the map used to be. */
  onFrame: (frame: MapFrame) => void;
}

type Phase = 'idle' | 'creating' | 'ready' | 'loaded';

/** A spec plus the two things the hook adds: where the hole is, and whether the
 *  screen's transition has finished. */
interface Claim extends MapSurfaceSpec {
  frame: MapFrame | null;
  reveal: boolean;
}

/* ── The store ───────────────────────────────────────────────── */

/* A module singleton rather than a context. There is one map, one host and one
   claimant in a process, and a provider would only add a layer that cannot ever
   have two instances. The screens' own state stays in the screens; this holds
   nothing but the handover. */

const listeners = new Set<() => void>();

/**
 * Two counters, not one, and the difference is the difference between this
 * working and not working at all.
 *
 * The mutable state below is read during render, so a version is what tells React
 * it changed. But a claiming screen re-states its claim on *every* render — that
 * is how fresh markers reach the map — and if that woke the screens up as well as
 * the host, the screen would re-render, re-claim, wake itself again and spin until
 * React gave up with a maximum-update-depth error.
 *
 * So: `specVersion` is what the host watches, and it moves whenever the claim's
 * contents move. `stateVersion` is what the screens watch, and it moves only when
 * something they can act on changes — who holds the surface, and whether the map
 * is ready. `useSyncExternalStore` re-renders only when its own snapshot differs,
 * so a routine claim reaches the host and stops there.
 */
let specVersion = 0;
let stateVersion = 0;
let phase: Phase = 'idle';
let claimId: string | null = null;
let claimSpec: Claim | null = null;
let hostMap: MapView | null = null;

/**
 * The viewport each claimant last had.
 *
 * Without this, popping back from Nearby to a line map you had panned across
 * Athens would drop you wherever Nearby left the camera — and the line map's
 * once-per-visit fit has already latched, so nothing would put it back. Keyed by
 * claim id and dropped when the screen unmounts, so a second visit to the same
 * line is a first visit again.
 */
const cameras = new Map<string, Region>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** What the host watches: anything about the claim it has to render. */
function hostSnapshot(): number {
  return specVersion;
}

/** What a screen watches: whether it still holds the surface, and whether the
 *  map is ready for it. Deliberately blind to the claim's contents. */
function screenSnapshot(): number {
  return stateVersion;
}

/** Where the one map has got to, for the reveal marks. */
function hostPhase(): Phase {
  return phase;
}

function setPhase(next: Phase): void {
  phase = next;
  stateVersion += 1;
  specVersion += 1;
  notify();
}

function claim(id: string, spec: Claim): void {
  claimSpec = spec;
  specVersion += 1;
  if (claimId !== id) {
    claimId = id;
    stateVersion += 1;
    mapPerf(`${spec.label} claimed the surface`);
  }
  notify();
}

/** Ignored unless `id` is the current claimant: on a push, the incoming screen
 *  claims before the outgoing one has finished going away, and the outgoing
 *  release must not then take the map away from it. */
function release(id: string): void {
  if (claimId !== id) return;
  mapPerf(`${claimSpec?.label ?? id} released the surface`);
  claimId = null;
  claimSpec = null;
  specVersion += 1;
  stateVersion += 1;
  notify();
}

function forget(id: string): void {
  cameras.delete(id);
}

/* ── The host ────────────────────────────────────────────────── */

export function MapHost() {
  useSyncExternalStore(subscribe, hostSnapshot);
  const spec = claimSpec;

  /** A screen has claimed the map and its transition is over: it is waiting. */
  const wanted = spec != null && spec.reveal;
  /** The surface exists and has reported for duty. */
  const ready = phase === 'ready' || phase === 'loaded';
  /**
   * Drawing.
   *
   * `ready` is in here so that a screen can never turn transparent over a map
   * that does not exist yet. Without it, the one case where the user beats the
   * boot arming would show them the bare window background — which is the
   * Activity's `windowBackground`, not our black — for as long as construction
   * takes. That is the white flash `loadingBackgroundColor` exists to prevent,
   * reintroduced one level higher up.
   */
  const revealed = wanted && ready;
  /**
   * Drawing *and* on top.
   *
   * These come apart for exactly one moment, and it is the moment that makes a
   * back-press look right: a screen being popped keeps the surface and stays
   * transparent so the map slides away with it, but it is no longer the focused
   * screen, so it must not be interactive and must not be reachable by TalkBack
   * while the screen coming up behind it takes over.
   */
  const active = revealed && spec.focused;

  const [armed, setArmed] = useState(false);

  /* Same region the map screens open at (the user's position, else Athens
     centre), so whatever basemap this pulls before anyone claims it is data they
     can reuse. Only ever the *first* camera — every claim sets its own. */
  const bootRegion = useInitialRegion(0.05);

  /**
   * Arming, half one: a screen is waiting for the map.
   *
   * Keyed on `wanted` and not on "a map route is on screen", which is the
   * tempting version and the wrong one. `wanted` is only true once the claiming
   * screen's push animation has finished, so in the one case where the boot
   * arming has not happened yet — a user who taps a saved line inside a quarter
   * of a second — construction still lands *after* the transition rather than in
   * the middle of it. The screen shows the same "Opening the map…" it always did
   * while that happens, and it is the only case left where anybody waits.
   *
   * This is also the only path that arms anywhere but Android.
   */
  useEffect(() => {
    if (armed || !wanted) return;
    mapPerf('map host armed (a screen is waiting for it)');
    setArmed(true);
  }, [armed, wanted]);

  /* Arming, half two: the boot warm-up, inherited. */
  useEffect(() => {
    if (armed || !ARM_AT_BOOT) return;
    let timer: ReturnType<typeof setTimeout>;
    const interaction = InteractionManager.runAfterInteractions(() => {
      timer = setTimeout(() => {
        mapPerf('map host armed');
        setArmed(true);
      }, ARM_DELAY_MS);
    });
    return () => {
      interaction.cancel();
      clearTimeout(timer);
    };
  }, [armed]);

  /* ── Geometry ─────────────────────────────────────────────── */

  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();

  /** Where the map goes until a screen has measured its own hole. See HEADER_DP. */
  const guessed = useMemo<MapFrame>(() => ({
    left: 0,
    top: insets.top + HEADER_DP,
    width: winW,
    height: Math.max(1, winH - insets.top - HEADER_DP),
  }), [insets.top, winW, winH]);

  /* Held in state rather than read straight off the claim so that releasing a
     screen does not snap the map back to the guess and resize the surface. The
     three map screens all put their map in the same place, so in practice this is
     set once and never changes again. */
  const [measured, setMeasured] = useState<MapFrame | null>(null);
  const specFrame = spec?.frame ?? null;
  useEffect(() => {
    if (!specFrame) return;
    setMeasured((prev) => (prev && sameFrame(prev, specFrame) ? prev : specFrame));
  }, [specFrame]);
  const frame = measured ?? guessed;

  /* ── Camera handover ──────────────────────────────────────── */

  /**
   * Which claim the camera has already been pointed at.
   *
   * The handover has to happen once per claim and no more: repeating it would
   * fight the user's own panning, and skipping it would show them the previous
   * screen's part of the city. It runs while the claiming screen is still opaque
   * — the transition it waits out is long enough for a `moveCamera` several times
   * over — so the jump is never visible.
   */
  const positioned = useRef<string | null>(null);
  useEffect(() => {
    const id = claimId;
    if (id == null) {
      // Cleared on release so a pop back to this screen positions again.
      positioned.current = null;
      return;
    }
    if (positioned.current === id || phase === 'idle' || phase === 'creating') return;
    const saved = cameras.get(id);
    const region = saved ?? claimSpec?.initialRegion;
    /* Latched only once the move has actually been issued. Latching first is the
       bug the line map's own fit effect used to have: a camera move that was
       skipped because the map was not there yet, recorded as done, and never
       attempted again — leaving the screen looking at the wrong city. */
    if (!region || !hostMap) return;
    positioned.current = id;
    // Duration 0 is `moveCamera`, not a zero-length animation — see
    // MapView.animateToRegion on the Android side.
    hostMap.animateToRegion(region, 0);
    mapPerf(`${claimSpec?.label ?? id} camera ${saved ? 'restored' : 'set'}`);
  });

  /* ── Native callbacks ─────────────────────────────────────── */

  const onMapRef = useCallback((instance: MapView | null) => {
    hostMap = instance;
  }, []);

  const onMapReady = useCallback(() => {
    mapPerf('map host onMapReady');
    setPhase('ready');
  }, []);

  const onMapLoaded = useCallback(() => {
    mapPerf('map host onMapLoaded');
    setPhase('loaded');
  }, []);

  const onRegionChangeStart = useCallback(() => {
    claimSpec?.onRegionChangeStart?.();
  }, []);

  const onRegionChangeComplete = useCallback((region: Region) => {
    /* Recorded from the idle event rather than `getCamera()` so the remembered
       viewport needs no promise and cannot land after the screen has gone. Our
       own handover produces one of these too, which is what seeds the record. */
    if (claimId != null) cameras.set(claimId, region);
    claimSpec?.onRegionChangeComplete?.(region);
  }, []);

  useEffect(() => {
    if (armed && phase === 'idle') setPhase('creating');
  }, [armed]);

  if (!armed) return null;

  return (
    /* `collapsable={false}`: the wrapper has no visual of its own, so RN's view
       flattening is entitled to remove it and take the accessibility props with
       it. `pointerEvents="none"` keeps it out of RN's JS touch dispatch — the
       native map's own gestures come from the Maps SDK and are governed by the
       gesture props below, not by this.

       Hidden from screen readers whenever it is not `active`: a Google map is
       full of focusable native content, and TalkBack must not be able to land on
       a map that is behind an opaque Home screen — nor on one that is still
       drawing under a screen already sliding away. */
    <View
      style={[hs.host, { left: frame.left, top: frame.top, width: frame.width, height: frame.height }]}
      collapsable={false}
      pointerEvents="none"
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      <MapView
        ref={onMapRef}
        provider={PROVIDER_GOOGLE}
        style={hs.map}
        initialRegion={bootRegion}
        customMapStyle={GOOGLE_DARK_STYLE}
        // Without the Map ID the new Google renderer ignores `customMapStyle`
        // outright and honours only the cloud style attached to the ID; the pair
        // covers both renderers. See theme/googleMapStyle.
        googleMapId={GOOGLE_MAP_ID}
        // The native map surface is a child view covering the full bounds, so it
        // paints over the black RN background with its own loading colour — white
        // by default, a flashbang in a pure-black UI. `loadingEnabled` is not
        // redundant: on Android the loading layout that carries
        // `loadingBackgroundColor` only exists once loading is enabled, so
        // dropping this prop silently restores the white flash.
        loadingEnabled
        loadingBackgroundColor={colors.bg}
        loadingIndicatorColor={colors.primaryLight}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        moveOnMarkerPress={false}
        /* Gestures follow the reveal, and they are the *only* thing that keeps an
           unrevealed map out of the way. RN's `pointerEvents` governs JS touch
           dispatch; Android's own dispatch still walks down to a native view, so
           without this a drag on Home that no card consumed would quietly pan a
           map nobody can see. */
        scrollEnabled={active}
        zoomEnabled={active}
        rotateEnabled={active}
        pitchEnabled={active && (spec?.pitchEnabled ?? true)}
        mapPadding={spec?.mapPadding}
        onMapReady={onMapReady}
        onMapLoaded={onMapLoaded}
        onPress={active ? spec?.onPress : undefined}
        onLongPress={active ? spec?.onLongPress : undefined}
        onRegionChangeStart={onRegionChangeStart}
        onRegionChangeComplete={onRegionChangeComplete}
      >
        {/* Children arrive with the reveal, not with the claim: see
            MAP_MOUNT_AFTER_TRANSITION for why the markers wait for the animation
            rather than landing in the middle of it. */}
        {revealed ? spec?.children : null}
      </MapView>
    </View>
  );
}

/* ── The claim ───────────────────────────────────────────────── */

/**
 * Borrow the shared map for as long as this screen is focused.
 *
 * Focus is the whole contention rule. expo-router's native stack keeps
 * pushed-behind screens mounted, so a user three lines deep has three screens
 * that would all like to draw on one map; the focused one gets it and the rest
 * render nothing onto it. That is also why the blurred screens keep their state:
 * their markers come off the map, not out of React, and their viewport is
 * remembered so a pop puts it back.
 *
 * The one thing a caller must not get wrong: the screen's background has to be
 * transparent exactly when `revealed` is true, and opaque otherwise. `revealed`
 * false with a transparent background shows the screen underneath through the
 * hole; `revealed` true with an opaque background shows a black rectangle where
 * the map should be.
 */
export function useMapSurface(spec: MapSurfaceSpec): MapSurface {
  /* Per component instance, so two line maps in the stack are two claimants with
     two remembered viewports rather than one shared identity. */
  const id = useId();
  const { label, focused } = spec;

  useSyncExternalStore(subscribe, screenSnapshot);
  const holdsSurface = claimId === id;
  const ready = phase === 'ready' || phase === 'loaded';

  const [settled, setSettled] = useState(!MAP_MOUNT_AFTER_TRANSITION);
  /* `ready` is the third term for the same reason the host has it: this screen
     must not turn transparent over a map that has not been built yet. Normally it
     has been ready since a quarter-second after launch and this changes nothing. */
  const revealed = holdsSurface && settled && ready;

  const [frame, setFrame] = useState<MapFrame | null>(null);
  const onFrame = useCallback((next: MapFrame) => {
    setFrame((prev) => (prev && sameFrame(prev, next) ? prev : next));
  }, []);

  const navigation = useNavigation<TransitionAwareNavigation>();
  /* Through a ref: React Navigation rebuilds the per-route navigation object
     whenever the stack's state changes, and an effect keyed on it would
     resubscribe — and restart the cap timer — on every navigation. */
  const navRef = useRef(navigation);
  navRef.current = navigation;

  /* Pushed on every render — no dependency array on purpose, because `children`
     is a fresh element tree every render and the map must show the current one.
     `useLayoutEffect` rather than `useEffect` so the host re-renders in the same
     commit and the markers never lag the screen's own state by a visible frame.
     It cannot loop: the host re-rendering does not re-render this screen.

     `!focused && !holdsSurface` is the contention rule in one line. A focused
     screen takes the surface, from whoever had it. A blurred screen that still
     has it keeps it up to date — that is the screen being popped, whose map must
     stay on screen until its animation is over. A blurred screen that has lost
     it does nothing at all, which is what stops a line map two deep in the stack
     from drawing its stops over the screen on top of it. */
  useLayoutEffect(() => {
    if (!focused && !holdsSurface) return;
    claim(id, { ...spec, frame, reveal: settled });
  });

  /**
   * Reveal when this screen's own appearance animation has finished.
   *
   * Re-arms on every appearance rather than latching for the screen's life,
   * because a pop back onto a screen is another transition and putting its
   * markers back on the map is the same UI-thread work as the first time.
   */
  useEffect(() => {
    if (!MAP_MOUNT_AFTER_TRANSITION || !focused || settled) return;
    const appearedAt = mapNow();
    let done = false;
    const reveal = (why: string) => {
      if (done) return;
      done = true;
      mapPerf(`${label} map usable (${why}, host=${hostPhase()})`, appearedAt);
      setSettled(true);
    };

    const unsubscribe = navRef.current.addListener('transitionEnd', (e) => {
      // `closing: true` is this screen going *away*. Handled below, not here.
      if (e?.data?.closing) return;
      reveal('transitionEnd');
    });
    const cap = setTimeout(() => reveal('CAP — no transitionEnd'), REVEAL_CAP_MS);

    return () => {
      unsubscribe();
      clearTimeout(cap);
    };
  }, [focused, settled, label]);

  /**
   * Hand the surface back when this screen's *departure* animation has finished,
   * not when it merely loses focus.
   *
   * The difference is the whole feel of a back-press. Releasing on blur makes the
   * map blink out to black and only then slide away, because focus changes at the
   * start of the animation; holding on until the end lets it travel with the
   * screen it belongs to. Nothing is at risk in the meantime — the map cannot be
   * touched while unfocused, and a *push* onto another map screen has already
   * taken the surface by claim, so this release finds nothing to give back.
   *
   * Not load-bearing on its own: if the event never arrives, the unmount below
   * still releases, and a screen that has already lost the surface to a claim is
   * already showing nothing.
   */
  useEffect(() => navRef.current.addListener('transitionEnd', (e) => {
    if (!e?.data?.closing) return;
    setSettled(false);
    release(id);
  }), [id]);

  useEffect(() => () => {
    release(id);
    forget(id);
  }, [id]);

  const getMap = useCallback(() => (claimId === id ? hostMap : null), [id]);

  return { revealed, ready, getMap, onFrame };
}

/**
 * The hole in a screen where the map shows through.
 *
 * Laid out exactly where the screen's own `<MapView>` used to be, and reports its
 * window-space rectangle so the host can put the shared map there. Measuring
 * rather than computing it from insets and a header constant is what stops a
 * wrong assumption about header height from becoming a visible strip of
 * background under the header.
 *
 * `collapsable={false}` is load-bearing: this View has no background, no children
 * and no visual of its own, so without it RN flattens it away and it is never
 * laid out and never measured.
 */
export function MapSurfaceSlot(
  { onFrame, style }: { onFrame: (frame: MapFrame) => void; style?: StyleProp<ViewStyle> },
) {
  const ref = useRef<View>(null);
  const measure = useCallback(() => {
    ref.current?.measureInWindow((x, y, w, h) => {
      if (w > 0 && h > 0) onFrame({ left: x, top: y, width: w, height: h });
    });
  }, [onFrame]);

  return (
    <View
      ref={ref}
      style={style}
      onLayout={measure}
      collapsable={false}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

/* ── Helpers ─────────────────────────────────────────────────── */

/**
 * The slice of the route-scoped navigation object the reveal needs.
 *
 * `transitionEnd` is a native-stack event and is not in the event map of
 * expo-router's default `useNavigation` type, so it is named here rather than
 * reached for through `any`. `NativeStackView` emits it from
 * react-native-screens' `onAppear`/`onDisappear`, targeted at this route's key.
 *
 * Deliberately used instead of `InteractionManager.runAfterInteractions`: that
 * resolves when no JS interaction handle is pending and knows nothing about a
 * native transition, so with no JS-driven animation in flight it fires almost at
 * once and would defer nothing at all. `REVEAL_CAP_MS` is the fallback instead.
 */
interface TransitionAwareNavigation {
  addListener(
    type: 'transitionEnd',
    listener: (e: { data?: { closing?: boolean } }) => void,
  ): () => void;
}

/** Sub-pixel differences are layout noise, not a move worth resizing a GL
 *  surface for. */
function sameFrame(a: MapFrame, b: MapFrame): boolean {
  return (
    Math.abs(a.left - b.left) < 1 &&
    Math.abs(a.top - b.top) < 1 &&
    Math.abs(a.width - b.width) < 1 &&
    Math.abs(a.height - b.height) < 1
  );
}

const hs = StyleSheet.create({
  /* Absolute, so it takes no part in layout and cannot resize the navigator
     above it — the same rule every other root-level sibling follows. */
  host: { position: 'absolute' },
  map: { ...StyleSheet.absoluteFillObject },
});
