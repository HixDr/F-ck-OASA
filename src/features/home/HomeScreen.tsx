/**
 * Home Screen — saved stops first, then saved lines.
 *
 * The saved stops used to be a virtualized FlatList. They are a canvas now:
 * every card is absolutely positioned on a surface that scrolls vertically and
 * grows to fit the lowest card, because a card the user may put anywhere is not
 * something a list can express. `features/home/layout` owns every number behind
 * that — units, size tiers, magnets, overlap resolution — and contains no React
 * on purpose, so the render pass, the gesture worklets and the accessibility
 * actions cannot quietly become three layout engines that disagree.
 *
 * Virtualization is the price, and it is a real one: every saved stop renders
 * at once and each card owns live arrival queries. That is fine at the 5-20
 * stops people actually save, and it is what turns `active` — the focus gate
 * handed to every card — from an optimisation into load-bearing code.
 *
 * A stop that has never been arranged *flows*: full width, sized by its own
 * content, stacked in saved order beneath anything that has been placed. An
 * install arriving from 1.2.4 has no saved placements at all, so every card
 * flows and this canvas reproduces the old column exactly. That is the whole
 * migration; see `layout.ts` for why it is expressed as a property of the
 * geometry rather than as a one-off upgrade step.
 *
 * Two interactions are worth explaining up front.
 *
 * Reordering. Holding a saved-line badge lifts it and the neighbours open a
 * gap, with `moveLeft` / `moveRight` accessibility actions as the equivalent a
 * screen reader can drive — a drag announces nothing, and a 44dp badge has
 * nowhere to put chevrons. That geometry is the grid's own and is shared with
 * nothing: see the section below for why a wrapping grid of content-sized
 * badges cannot borrow anything from the stop canvas.
 *
 * Removal. Nothing here asks "are you sure?" any more. Removing a saved stop or
 * line is one storage write and trivially reversible, so it happens at once and
 * an undo bar offers the way back — see `restoreStops` / `restoreLines` for why
 * "back" has to mean the position too, not just the item. A saved line is
 * removed in edit mode only: long press is the drag lift now, and a gesture
 * cannot mean "pick this up" and "delete this" at the same time.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  RefreshControl,
  Alert,
  useWindowDimensions,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeInDown,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { colors, fontScaleCap, onAccent, spacing } from '../../theme';
import {
  getFavorites,
  addFavorite,
  removeFavorite,
  reorderFavorites,
  getFavoriteStops,
  removeFavoriteStop,
  addFavoriteStop,
  reorderFavoriteStops,
  updateFavoriteStop,
  updateFavoriteStops,
  isOfflineDataDownloaded,
  getOfflineTimestamp,
} from '../../services/storage';
import { downloadAllOfflineData, removeAllOfflineData, type OfflineProgress } from '../../services/offlineData';
import { useLines, usePrefetchLine, useArrivalsPollAt, useArrivalsStatus, ARRIVALS_POLL_MS } from '../../hooks';
import { USER_MARKER_BASE64 } from '../../data/userMarker';
import { useSettings } from '../settings/SettingsProvider';
import { hapticImpact, hapticSelection } from '../../services/haptics';
import { useNetworkStatus } from '../../services/network';
import Pressable from '../../ui/Pressable';
import LiveStatus from '../../ui/LiveStatus';
import { showUndo } from '../../ui/UndoBar';
import { duration, easing, liftSpring, spring, useReduceMotion } from '../../ui/motion';
import FavoriteStopCard from '../../components/FavoriteStopCard';
import SettingsModal from '../../components/SettingsModal';
import { s, LINE_GRID_GAP } from './HomeScreen.styles';
import {
  edgesX,
  edgesY,
  fitAll,
  placeAll,
  resolveMove,
  resolveResize,
  snapAxis,
  CARD_MIN_H_DP,
  CARD_MIN_W_DP,
  SNAP_DP,
  type PlacedCard,
  type Rect,
} from './layout';
import type { FavoriteLine, FavoriteStop } from '../../types';

/* ── Order persistence ───────────────────────────────────────── */

/** Persist a new saved-stop order. One storage write, and one that keeps any
 *  code it was not told about — see `reorderFavoriteStops`. */
function persistStopOrder(next: FavoriteStop[]): void {
  reorderFavoriteStops(next.map((st) => st.stopCode));
}

/** The same, for saved lines. */
function persistLineOrder(next: FavoriteLine[]): void {
  reorderFavorites(next.map((f) => f.lineCode));
}

/**
 * Put a captured saved-stop array back, order included.
 *
 * `addFavoriteStop` appends, so undoing a removal by re-adding the one stop
 * would silently drop it to the bottom of the list — a "fix" that quietly
 * changes something else the user cared about. Re-adding and then replaying the
 * whole captured order is the only shape that restores what was actually there.
 * Anything saved *since* the removal survives: adding an existing code is a
 * no-op, and `reorderFavoriteStops` keeps codes it was not told about.
 */
function restoreStops(before: FavoriteStop[]): FavoriteStop[] {
  for (const st of before) addFavoriteStop(st);
  persistStopOrder(before);
  return getFavoriteStops();
}

/**
 * The same, for saved lines.
 *
 * This used to rebuild the diverging tail through remove/add, because lines had
 * no reorder API and churning the whole array would briefly persist an empty
 * list — a kill in that window was a user who lost every saved line to an undo.
 * `reorderFavorites` is one write of the final array, so that hazard is gone.
 */
function restoreLines(before: FavoriteLine[]): FavoriteLine[] {
  for (const f of before) addFavorite(f);
  persistLineOrder(before);
  return getFavorites();
}

/* ── Lift vocabulary ─────────────────────────────────────────── */

/** Hold before a card or a saved-line badge lifts. Long enough not to fire
 *  mid-scroll, short enough that the lift reads as a response, not a delay. */
const LIFT_MS = 260;
const LIFT_SCALE = 1.03;

/** Cards below this index get the first-paint entrance; the rest are scrolled
 *  to, and an animation on arrival would read as lag. */
const ENTRANCE_CARDS = 8;

/** A held card near the edge of the canvas scrolls it, so a stop can be carried
 *  further than one screenful without being put down. */
const EDGE_BAND = 96;
const EDGE_MAX_STEP = 16;
const EDGE_TICK_MS = 16;

/* ── Carrying a card ─────────────────────────────────────────── */

/**
 * Everything a card needs to take part in a drag. One object, created once —
 * see the warning where it is built.
 */
interface CanvasCtl {
  /** Index of the carried card, -1 when nothing is held. */
  active: SharedValue<number>;
  /** The carried card's travel from its laid-out position, in canvas pixels,
   *  after snapping. */
  dx: SharedValue<number>;
  dy: SharedValue<number>;
  /** Raw gesture translation, kept separately so the edge auto-scroll can add
   *  its own contribution without the finger having moved. */
  panX: SharedValue<number>;
  panY: SharedValue<number>;
  lift: SharedValue<number>;
  /** Canvas pixel coordinate of the edge each axis is currently snapped to, or
   *  -1. Drives the guide lines. */
  guideX: SharedValue<number>;
  guideY: SharedValue<number>;
  /** Every card's box, in stored units, in render order. */
  rects: SharedValue<Rect[]>;
  /** The same minus the carried one, plus its edges — built once per lift,
   *  because the alternative is rebuilding both on every frame of the drag. */
  others: SharedValue<Rect[]>;
  edgeX: SharedValue<number[]>;
  edgeY: SharedValue<number[]>;
  /** Canvas usable width. Every conversion between stored units and pixels
   *  goes through it. */
  u: SharedValue<number>;
  /** Index of the card whose corner is being dragged, -1 when none. */
  resizing: SharedValue<number>;
  /** The box that corner is currently describing, in canvas pixels. */
  previewX: SharedValue<number>;
  previewY: SharedValue<number>;
  previewW: SharedValue<number>;
  previewH: SharedValue<number>;
  /** Finger position in window coordinates — drives the edge auto-scroll. */
  pointerY: SharedValue<number>;
  scrollY: SharedValue<number>;
  scrollAt: SharedValue<number>;
  reduced: SharedValue<boolean>;
  onLift: (index: number) => void;
  /** An edge was caught or released. Selection haptic, per the app's drag
   *  vocabulary. */
  onSnap: () => void;
  onDrop: (index: number, x: number, y: number, w: number, h: number) => void;
  onResizeStart: (index: number) => void;
  onResizeEnd: (index: number, x: number, y: number, w: number, h: number) => void;
}

interface Sized {
  w: number;
  h: number;
  /** Snapped edge in canvas pixels, or -1. */
  gx: number;
  gy: number;
}

/**
 * The box a corner drag is describing, in stored units.
 *
 * The top-left is fixed, so only the trailing edges snap and only they are
 * clamped. Pure and argument-taking for the same reason as `carryTo`, and
 * because the accessibility "grow" and "shrink" actions have to reach the same
 * answer through `resizeStep` without a gesture anywhere in sight.
 */
function sizeTo(
  base: Rect,
  panX: number,
  panY: number,
  u: number,
  edgeX: readonly number[],
  edgeY: readonly number[],
): Sized {
  'worklet';
  const tol = SNAP_DP / u;
  const minW = CARD_MIN_W_DP / u;
  const minH = CARD_MIN_H_DP / u;
  const maxW = 1 - base.x;

  let w = base.w + panX / u;
  w = w < minW ? minW : w > maxW ? maxW : w;
  let h = base.h + panY / u;
  if (h < minH) h = minH;

  /* Only the trailing edge is offered a magnet: the leading one has not moved,
     and snapping an edge the user is not dragging would silently resize the
     card from the side they are holding still. */
  const sx = snapAxis(base.x + w, 0, edgeX, tol);
  let gx = sx.guide;
  if (gx >= 0) {
    const snapped = sx.v - base.x;
    if (snapped >= minW && snapped <= maxW) w = snapped;
    else gx = -1;
  }
  const sy = snapAxis(base.y + h, 0, edgeY, tol);
  let gy = sy.guide;
  if (gy >= 0) {
    const snapped = sy.v - base.y;
    if (snapped >= minH) h = snapped;
    else gy = -1;
  }

  return { w, h, gx: gx >= 0 ? gx * u : -1, gy: gy >= 0 ? gy * u : -1 };
}

interface Carried {
  dx: number;
  dy: number;
  /** Snapped edge in canvas pixels, or -1. */
  gx: number;
  gy: number;
}

/**
 * Where a carried card sits, given how far the finger has travelled.
 *
 * Deliberately pure, and deliberately takes everything as arguments rather than
 * reading the shared values itself: it is called both from the gesture worklet
 * on the UI thread and from the auto-scroll tick on the JS thread, and reading
 * a shared value from JS is a synchronous hop into the UI runtime — cheap once,
 * not cheap sixty times a second in a loop competing with the drag it exists to
 * serve. Writing the results back is the caller's job for the same reason.
 *
 * A snap that would push the card off the canvas is dropped rather than
 * clamped: showing a guide line the card then fails to sit on is worse than not
 * offering the magnet at all.
 */
function carryTo(
  base: Rect,
  panX: number,
  panY: number,
  u: number,
  edgeX: readonly number[],
  edgeY: readonly number[],
): Carried {
  'worklet';
  const tol = SNAP_DP / u;
  const maxX = 1 - base.w;
  let x = base.x + panX / u;
  x = x < 0 ? 0 : x > maxX ? maxX : x;
  let y = base.y + panY / u;
  if (y < 0) y = 0;

  const sx = snapAxis(x, base.w, edgeX, tol);
  let nx = sx.v;
  let gx = sx.guide;
  if (nx < 0 || nx > maxX) {
    nx = x;
    gx = -1;
  }
  const sy = snapAxis(y, base.h, edgeY, tol);
  let ny = sy.v;
  let gy = sy.guide;
  if (ny < 0) {
    ny = y;
    gy = -1;
  }

  return {
    dx: (nx - base.x) * u,
    dy: (ny - base.y) * u,
    gx: gx >= 0 ? gx * u : -1,
    gy: gy >= 0 ? gy * u : -1,
  };
}

/* ── A card on the canvas ────────────────────────────────────── */

interface StopCardProps {
  stop: FavoriteStop;
  index: number;
  count: number;
  /** Where the canvas has decided this card sits, in pixels. */
  card: PlacedCard;
  primaryColor: string;
  focused: boolean;
  editing: boolean;
  arranging: boolean;
  /** First paint only — a card mounting later must not fade in as if new. */
  entrance: boolean;
  reduced: boolean;
  ctl: CanvasCtl;
  onMeasure: (stopCode: string, height: number) => void;
  onRemove: (stop: FavoriteStop) => void;
  onMoveUp: (stop: FavoriteStop) => void;
  onMoveDown: (stop: FavoriteStop) => void;
}

/**
 * One absolutely positioned card.
 *
 * The wrapper carries the geometry and the card carries the content, which is
 * the split that lets a card be moved and resized without anything inside it
 * knowing. A *flowing* card is given no fixed height so it can size itself from
 * its content exactly as it did in 1.2.4, and reports what that came to — the
 * canvas needs the measurement both to stack the next card below it and to know
 * what box to freeze it at when it is first picked up.
 *
 * The gesture detector sits inside the transformed wrapper rather than on it,
 * because the wrapper is what has to be painted over its neighbours while it
 * travels and `GestureDetector` will only accept a single child.
 */
const StopCard = React.memo(function StopCard({
  stop,
  index,
  count,
  card,
  primaryColor,
  focused,
  editing,
  arranging,
  entrance,
  reduced,
  ctl,
  onMeasure,
  onRemove,
  onMoveUp,
  onMoveDown,
}: StopCardProps) {
  const measure = useCallback(
    (e: LayoutChangeEvent) => {
      onMeasure(stop.stopCode, e.nativeEvent.layout.height);
    },
    [onMeasure, stop.stopCode],
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(LIFT_MS)
        .maxPointers(1)
        .onStart((e) => {
          const rects = ctl.rects.value;
          if (index >= rects.length) return;
          /* The previous card is still settling and has not committed yet.
             Lifting a second one now would let that pending commit clear
             `active` out from under this drag. */
          if (ctl.active.value >= 0) return;

          /* Built here rather than handed over from JS: the first `onUpdate`
             can arrive before a `runOnJS` hop has landed, and a frame of
             drag with an empty obstacle set is a frame with no magnets and,
             far worse, a drop that thinks the canvas is empty. `onLift`
             rebuilds the same two things from its own mirror. */
          const others: Rect[] = [];
          for (let i = 0; i < rects.length; i++) {
            if (i !== index) others.push(rects[i]);
          }
          ctl.others.value = others;
          ctl.edgeX.value = edgesX(others);
          ctl.edgeY.value = edgesY(others);

          ctl.active.value = index;
          ctl.dx.value = 0;
          ctl.dy.value = 0;
          ctl.panX.value = 0;
          ctl.panY.value = 0;
          ctl.guideX.value = -1;
          ctl.guideY.value = -1;
          ctl.scrollAt.value = ctl.scrollY.value;
          ctl.pointerY.value = e.absoluteY;
          ctl.lift.value = ctl.reduced.value ? 1 : withSpring(LIFT_SCALE, liftSpring);
          runOnJS(ctl.onLift)(index);
        })
        .onUpdate((e) => {
          if (ctl.active.value !== index) return;
          const rects = ctl.rects.value;
          if (index >= rects.length) return;
          ctl.panX.value = e.translationX;
          ctl.panY.value = e.translationY;
          ctl.pointerY.value = e.absoluteY;
          /* The card's travel is the gesture *plus* however far the canvas has
             auto-scrolled: a finger holding still while the content moves under
             it is still the card moving across the canvas. */
          const next = carryTo(
            rects[index],
            e.translationX,
            e.translationY + (ctl.scrollY.value - ctl.scrollAt.value),
            ctl.u.value,
            ctl.edgeX.value,
            ctl.edgeY.value,
          );
          ctl.dx.value = next.dx;
          ctl.dy.value = next.dy;
          if (next.gx !== ctl.guideX.value || next.gy !== ctl.guideY.value) {
            ctl.guideX.value = next.gx;
            ctl.guideY.value = next.gy;
            if (next.gx >= 0 || next.gy >= 0) runOnJS(ctl.onSnap)();
          }
        })
        /* onFinalize rather than onEnd: a gesture cancelled from outside — a
           call arriving, a navigation — must still put the card down, and must
           still commit where the user had already moved it to. */
        .onFinalize(() => {
          if (ctl.active.value !== index) return;
          const rects = ctl.rects.value;
          const u = ctl.u.value;
          const base = index < rects.length ? rects[index] : null;
          ctl.guideX.value = -1;
          ctl.guideY.value = -1;
          ctl.lift.value = withSpring(1, liftSpring);
          if (!base) {
            ctl.active.value = -1;
            ctl.dx.value = 0;
            ctl.dy.value = 0;
            return;
          }
          /* Resolved before the card lands, not after: the spring has to travel
             to where the card will actually end up, or the drop plays twice —
             once to the finger's position and once again to the free one. */
          const got = resolveMove(
            { x: base.x + ctl.dx.value / u, y: base.y + ctl.dy.value / u, w: base.w, h: base.h },
            ctl.others.value,
          );
          const tx = (got.x - base.x) * u;
          const ty = (got.y - base.y) * u;
          if (ctl.reduced.value) {
            ctl.dx.value = tx;
            ctl.dy.value = ty;
            runOnJS(ctl.onDrop)(index, got.x, got.y, got.w, got.h);
          } else {
            ctl.dx.value = withSpring(tx, liftSpring);
            /* Commit once the card has physically landed. It is already sitting
               on the resolved box by then, so the write that follows changes
               nothing on screen. */
            ctl.dy.value = withSpring(ty, liftSpring, () => {
              runOnJS(ctl.onDrop)(index, got.x, got.y, got.w, got.h);
            });
          }
        }),
    [ctl, index],
  );

  /**
   * The corner handle.
   *
   * A plain pan, not a held one: it is a target the user went looking for, and
   * asking them to hold a control that only exists in arrange mode would be a
   * second lock on a door already unlocked. It still refuses to start while
   * anything else is in the air, for the same reason the body drag does.
   */
  const resize = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .onStart(() => {
          const rects = ctl.rects.value;
          if (index >= rects.length) return;
          if (ctl.active.value >= 0 || ctl.resizing.value >= 0) return;
          const others: Rect[] = [];
          for (let i = 0; i < rects.length; i++) {
            if (i !== index) others.push(rects[i]);
          }
          ctl.others.value = others;
          ctl.edgeX.value = edgesX(others);
          ctl.edgeY.value = edgesY(others);
          const u = ctl.u.value;
          const base = rects[index];
          ctl.previewX.value = base.x * u;
          ctl.previewY.value = base.y * u;
          ctl.previewW.value = base.w * u;
          ctl.previewH.value = base.h * u;
          ctl.guideX.value = -1;
          ctl.guideY.value = -1;
          ctl.resizing.value = index;
          runOnJS(ctl.onResizeStart)(index);
        })
        .onUpdate((e) => {
          if (ctl.resizing.value !== index) return;
          const rects = ctl.rects.value;
          if (index >= rects.length) return;
          const u = ctl.u.value;
          const base = rects[index];
          const next = sizeTo(
            base,
            e.translationX,
            e.translationY,
            u,
            ctl.edgeX.value,
            ctl.edgeY.value,
          );
          ctl.previewW.value = next.w * u;
          ctl.previewH.value = next.h * u;
          if (next.gx !== ctl.guideX.value || next.gy !== ctl.guideY.value) {
            ctl.guideX.value = next.gx;
            ctl.guideY.value = next.gy;
            if (next.gx >= 0 || next.gy >= 0) runOnJS(ctl.onSnap)();
          }
        })
        .onFinalize(() => {
          if (ctl.resizing.value !== index) return;
          const rects = ctl.rects.value;
          const u = ctl.u.value;
          ctl.resizing.value = -1;
          ctl.guideX.value = -1;
          ctl.guideY.value = -1;
          if (index >= rects.length) return;
          const base = rects[index];
          const got = resolveResize(
            { x: base.x, y: base.y, w: ctl.previewW.value / u, h: ctl.previewH.value / u },
            ctl.others.value,
            CARD_MIN_W_DP / u,
            CARD_MIN_H_DP / u,
          );
          runOnJS(ctl.onResizeEnd)(index, got.x, got.y, got.w, got.h);
        }),
    [ctl, index],
  );

  const animStyle = useAnimatedStyle(() => {
    const held = ctl.active.value === index;
    return {
      transform: [
        { translateX: held ? ctl.dx.value : 0 },
        { translateY: held ? ctl.dy.value : 0 },
        { scale: held ? ctl.lift.value : 1 },
      ],
      zIndex: held ? 2 : 0,
      elevation: held ? 10 : 0,
    };
  });

  const entering =
    entrance && !reduced && index < ENTRANCE_CARDS
      ? FadeInDown.duration(duration.slow).delay(index * 45).easing(easing.out)
      : undefined;

  return (
    <Animated.View
      style={[s.stopCard, { left: card.left, top: card.top, width: card.width }, animStyle]}
      // Only a flowing card's measurement means anything: a placed card would
      // just report back the height the canvas already told it to be.
      onLayout={card.flowing ? measure : undefined}
    >
      <GestureDetector gesture={gesture}>
        <Animated.View entering={entering}>
          <FavoriteStopCard
            stop={stop}
            primaryColor={primaryColor}
            active={focused}
            editing={editing}
            tier={card.tier}
            boxHeight={card.flowing ? null : card.height}
            onRemove={onRemove}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            canMoveUp={index > 0}
            canMoveDown={index < count - 1}
          />
          {/* Outline rather than a fill: at three cards across, anything opaque
              is covering an arrival number. */}
          {arranging && (
            <View
              pointerEvents="none"
              style={[s.arrangeOutline, { borderColor: primaryColor }]}
            />
          )}
        </Animated.View>
      </GestureDetector>

      {/* Deliberately a sibling of the body's detector rather than a child of
          it. Nested, a hold on the corner would satisfy the body's long press
          after 260ms and lift the card the user was trying to resize; out here
          the touch never reaches that gesture at all, which is a structural
          answer rather than one that depends on getting a gesture-relation API
          right. */}
      {arranging && (
        <GestureDetector gesture={resize}>
          <View style={s.resizeHandle}>
            <View style={[s.resizeGrip, { backgroundColor: primaryColor }]}>
              <Ionicons name="resize" size={13} color={onAccent(primaryColor)} />
            </View>
          </View>
        </GestureDetector>
      )}
    </Animated.View>
  );
});

/**
 * The two magnet guides.
 *
 * Its own component so that catching and releasing an edge — which can happen
 * many times in one drag — repaints two hairlines instead of every card on the
 * canvas: the positions live in shared values and never reach React state.
 *
 * Nothing here is animated, and that is the point rather than an omission. The
 * guide's whole job is to say "this edge, right now"; fading it in would put
 * the confirmation behind the moment the user is asking about, and there is
 * consequently nothing for `useReduceMotion` to turn off.
 */
const SnapGuides = React.memo(function SnapGuides({
  ctl,
  color,
}: {
  ctl: CanvasCtl;
  color: string;
}) {
  const vStyle = useAnimatedStyle(() => ({
    opacity: ctl.guideX.value >= 0 ? 1 : 0,
    transform: [{ translateX: ctl.guideX.value }],
  }));
  const hStyle = useAnimatedStyle(() => ({
    opacity: ctl.guideY.value >= 0 ? 1 : 0,
    transform: [{ translateY: ctl.guideY.value }],
  }));
  /**
   * The box a corner drag is describing.
   *
   * The card itself is left alone until the gesture ends, and that is the whole
   * design of the resize rather than a shortcut. Re-laying-out a card on every
   * frame means a Yoga pass over up to ten arrival rows sixty times a second,
   * on a screen where every card is already running a live query — and the tier
   * change that a resize exists to produce is a React render, which cannot
   * happen per frame at all. One outline moves instead, and the card takes the
   * new box, at the new tier, in a single commit when the finger lifts.
   */
  const boxStyle = useAnimatedStyle(() => ({
    opacity: ctl.resizing.value >= 0 ? 1 : 0,
    width: ctl.previewW.value,
    height: ctl.previewH.value,
    transform: [{ translateX: ctl.previewX.value }, { translateY: ctl.previewY.value }],
  }));
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={[s.resizePreview, { borderColor: color }, boxStyle]}
      />
      <Animated.View
        pointerEvents="none"
        style={[s.snapGuideV, { backgroundColor: color }, vStyle]}
      />
      <Animated.View
        pointerEvents="none"
        style={[s.snapGuideH, { backgroundColor: color }, hStyle]}
      />
    </>
  );
});

/* ── Saved lines: the grid's own geometry ────────────────────── */

/**
 * None of the stop canvas's maths transfers here, and it is worth saying why
 * before someone tries to share it.
 *
 * The canvas is free placement: a card is wherever the user put it, `layout.ts`
 * only has to say whether that position is legal, and no other card moves when
 * one does. This grid is the opposite — the badges have no positions of their
 * own at all. They are content-sized, wrapping flex children (a 2-digit line and
 * a 4-digit one are different widths, and both grow with the system font scale),
 * so inserting one mid-grid reflows the tail *across row boundaries* and every
 * other badge's travel is a different (dx, dy).
 *
 * So the grid's wrapping is re-run here, from measured widths, for the
 * hypothetical order. Everything is stated as a *difference* against the
 * identity layout (`k === a`), which means any disagreement between this
 * simulation and Yoga's own line-breaking cancels out instead of showing up as
 * every badge jumping the moment one is picked up.
 */

/** Which original index sits at position `p`, once the badge lifted from `a` has
 *  been re-inserted at slot `k`. */
function origAt(p: number, a: number, k: number): number {
  'worklet';
  if (p === k) return a;
  // Position in the array with `a` removed, then back to an original index.
  const j = p < k ? p : p - 1;
  return j < a ? j : j + 1;
}

/** The inverse: where original index `i` ends up. */
function posOf(i: number, a: number, k: number): number {
  'worklet';
  if (i === a) return k;
  const j = i < a ? i : i - 1;
  return j < k ? j : j + 1;
}

/**
 * Top-left of the badge at position `p` in that hypothetical order.
 *
 * Walks the prefix only: a wrapping row's geometry depends on everything before
 * an item and nothing after it.
 */
function slotXY(
  p: number,
  a: number,
  k: number,
  ws: number[],
  hs: number[],
  width: number,
  gap: number,
): { x: number; y: number } {
  'worklet';
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (let q = 0; q <= p; q++) {
    const o = origAt(q, a, k);
    const w = ws[o] ?? 0;
    // The epsilon keeps a badge that measured a fraction over its share on the
    // row Yoga actually put it on.
    if (x > 0 && x + w > width + 0.5) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    if (q === p) return { x, y };
    x += w + gap;
    const h = hs[o] ?? 0;
    if (h > rowH) rowH = h;
  }
  return { x, y };
}

/** How far the badge at `index` slides to open (or close) the gap. */
function shiftFor(
  index: number,
  a: number,
  k: number,
  ws: number[],
  hs: number[],
  width: number,
  gap: number,
): { dx: number; dy: number } {
  'worklet';
  const from = slotXY(index, a, a, ws, hs, width, gap);
  const to = slotXY(posOf(index, a, k), a, k, ws, hs, width, gap);
  return { dx: to.x - from.x, dy: to.y - from.y };
}

/** The slot a badge lifted from `a` is closest to, given where it is now. */
function slotForXY(
  px: number,
  py: number,
  a: number,
  count: number,
  ws: number[],
  hs: number[],
  width: number,
  gap: number,
): number {
  'worklet';
  let best = a;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let k = 0; k < count; k++) {
    const p = slotXY(k, a, k, ws, hs, width, gap);
    const dx = p.x - px;
    const dy = p.y - py;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return best;
}

/** Total height of the grid as laid out. Only the drop clamp needs it. */
function gridHeight(ws: number[], hs: number[], width: number, gap: number): number {
  'worklet';
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (x > 0 && x + w > width + 0.5) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    x += w + gap;
    if (hs[i] > rowH) rowH = hs[i];
  }
  return y + rowH;
}

function clamp(v: number, min: number, max: number): number {
  'worklet';
  return v < min ? min : v > max ? max : v;
}

/** Everything a badge needs to take part in the grid drag. Its own set of
 *  shared values — the stop drag's are screen-level singletons and a badge
 *  borrowing them would let one gesture clear the other's state. */
interface LineDragCtl {
  active: SharedValue<number>;
  target: SharedValue<number>;
  /** The lifted badge's travel from its laid-out position. */
  ox: SharedValue<number>;
  oy: SharedValue<number>;
  lift: SharedValue<number>;
  /** Measured badge sizes, in the current order. */
  ws: SharedValue<number[]>;
  hs: SharedValue<number[]>;
  gridW: SharedValue<number>;
  gridH: SharedValue<number>;
  reduced: SharedValue<boolean>;
  onLift: (index: number) => void;
  onTarget: (index: number) => void;
  onDrop: (from: number, to: number) => void;
  onMeasure: (lineCode: string, w: number, h: number) => void;
}

/* ── Saved line chip ─────────────────────────────────────────── */

interface LineChipProps {
  fav: FavoriteLine;
  index: number;
  count: number;
  editing: boolean;
  accentColor: string;
  ctl: LineDragCtl;
  onOpen: (fav: FavoriteLine) => void;
  onRemove: (fav: FavoriteLine) => void;
  onMove: (fav: FavoriteLine, delta: number) => void;
}

const LineChip = React.memo(function LineChip({
  fav,
  index,
  count,
  editing,
  accentColor,
  ctl,
  onOpen,
  onRemove,
  onMove,
}: LineChipProps) {
  const measure = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      ctl.onMeasure(fav.lineCode, width, height);
    },
    [ctl, fav.lineCode],
  );

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(LIFT_MS)
        .maxPointers(1)
        .onStart(() => {
          const ws = ctl.ws.value;
          // One saved line cannot be reordered, and nothing can be dropped
          // before the grid has been measured.
          if (ws.length < 2 || index >= ws.length || ctl.gridW.value <= 0) return;
          /* The previous badge is still settling and has not committed yet.
             Lifting a second one would let that pending commit clear `active`
             out from under this drag. */
          if (ctl.active.value >= 0) return;
          ctl.active.value = index;
          ctl.target.value = index;
          ctl.ox.value = 0;
          ctl.oy.value = 0;
          ctl.lift.value = ctl.reduced.value ? 1 : withSpring(LIFT_SCALE, liftSpring);
          runOnJS(ctl.onLift)(index);
        })
        .onUpdate((e) => {
          if (ctl.active.value !== index) return;
          const ws = ctl.ws.value;
          const hs = ctl.hs.value;
          if (index >= ws.length) return;
          const width = ctl.gridW.value;
          const base = slotXY(index, index, index, ws, hs, width, LINE_GRID_GAP);
          // Clamped as a position rather than as a translation, so a badge
          // cannot be carried outside the grid it belongs to.
          const px = clamp(base.x + e.translationX, 0, Math.max(0, width - (ws[index] ?? 0)));
          const py = clamp(base.y + e.translationY, 0, Math.max(0, ctl.gridH.value - (hs[index] ?? 0)));
          ctl.ox.value = px - base.x;
          ctl.oy.value = py - base.y;
          const k = slotForXY(px, py, index, ws.length, ws, hs, width, LINE_GRID_GAP);
          if (k !== ctl.target.value) {
            ctl.target.value = k;
            runOnJS(ctl.onTarget)(k);
          }
        })
        /* onFinalize rather than onEnd: a gesture cancelled from outside — a
           call arriving, a navigation — must still put the badge down, and must
           still commit where the user had already moved it to. */
        .onFinalize(() => {
          if (ctl.active.value !== index) return;
          const k = ctl.target.value;
          const ws = ctl.ws.value;
          const rest =
            index < ws.length
              ? shiftFor(index, index, k, ws, ctl.hs.value, ctl.gridW.value, LINE_GRID_GAP)
              : { dx: 0, dy: 0 };
          ctl.lift.value = withSpring(1, liftSpring);
          if (ctl.reduced.value) {
            ctl.ox.value = rest.dx;
            ctl.oy.value = rest.dy;
            runOnJS(ctl.onDrop)(index, k);
          } else {
            ctl.ox.value = withSpring(rest.dx, liftSpring);
            /* Commit once the badge has physically landed. The neighbours are
               already sitting in the new order by then, so the data swap that
               follows changes nothing on screen. */
            ctl.oy.value = withSpring(rest.dy, liftSpring, () => {
              runOnJS(ctl.onDrop)(index, k);
            });
          }
        }),
    [ctl, index],
  );

  /* Two scalars rather than one `{dx, dy}`: a derived value carrying an
     animation has to *be* the animation, and the animated style must not
     re-target a spring on every frame of someone else's drag. */
  const shiftX = useDerivedValue(() => {
    const a = ctl.active.value;
    if (a < 0 || a === index) return 0;
    const to = shiftFor(index, a, ctl.target.value, ctl.ws.value, ctl.hs.value, ctl.gridW.value, LINE_GRID_GAP);
    return ctl.reduced.value ? to.dx : withSpring(to.dx, spring);
  });
  const shiftY = useDerivedValue(() => {
    const a = ctl.active.value;
    if (a < 0 || a === index) return 0;
    const to = shiftFor(index, a, ctl.target.value, ctl.ws.value, ctl.hs.value, ctl.gridW.value, LINE_GRID_GAP);
    return ctl.reduced.value ? to.dy : withSpring(to.dy, spring);
  });

  const animStyle = useAnimatedStyle(() => {
    const held = ctl.active.value === index;
    return {
      transform: [
        { translateX: held ? ctl.ox.value : shiftX.value },
        { translateY: held ? ctl.oy.value : shiftY.value },
        { scale: held ? ctl.lift.value : 1 },
      ],
      zIndex: held ? 2 : 0,
      elevation: held ? 10 : 0,
    };
  });

  /* A drag announces nothing and a 44dp badge has no room for chevrons, so the
     screen-reader path is a pair of custom actions. Only the ones that can
     actually move this badge are offered. */
  const a11yActions = useMemo<AccessibilityActionInfo[] | undefined>(() => {
    if (count < 2) return undefined;
    const acts: AccessibilityActionInfo[] = [];
    if (index > 0) acts.push({ name: 'moveLeft', label: 'Move left' });
    if (index < count - 1) acts.push({ name: 'moveRight', label: 'Move right' });
    return acts;
  }, [index, count]);

  const onAction = useCallback(
    (e: AccessibilityActionEvent) => {
      const { actionName } = e.nativeEvent;
      if (actionName === 'moveLeft') onMove(fav, -1);
      else if (actionName === 'moveRight') onMove(fav, 1);
    },
    [fav, onMove],
  );

  return (
    /* The detector sits on the transformed wrapper rather than inside it: its
       one child is then a single element, which is all `GestureDetector` will
       accept. The stop cells attach one level down only because a FlatList
       owns their outermost view. */
    <GestureDetector gesture={gesture}>
      <Animated.View style={[s.lineCell, animStyle]} onLayout={measure}>
        <Pressable
          style={s.lineCard}
          onPress={() => (editing ? onRemove(fav) : onOpen(fav))}
          accessibilityRole="button"
          accessibilityLabel={
            editing
              ? `Remove line ${fav.lineId} from saved lines`
              : `Line ${fav.lineId}, ${fav.lineDescrEng}`
          }
          accessibilityHint={editing ? undefined : 'Opens the live map for this line'}
          accessibilityActions={a11yActions}
          onAccessibilityAction={a11yActions ? onAction : undefined}
        >
          <View style={[s.lineBadge, { backgroundColor: accentColor }]}>
            <Text style={[s.lineBadgeText, { color: onAccent(accentColor) }]} maxFontSizeMultiplier={fontScaleCap.badge}>{fav.lineId}</Text>
          </View>
          {editing && (
            <Ionicons name="close-circle" size={20} color={colors.danger} style={s.lineRemove} />
          )}
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
});

/* ── Saved lines grid ────────────────────────────────────────── */

interface SavedLinesProps {
  lines: FavoriteLine[];
  editing: boolean;
  accentColor: string;
  onOpen: (fav: FavoriteLine) => void;
  onRemove: (fav: FavoriteLine) => void;
  onReorder: (next: FavoriteLine[]) => void;
  onMove: (fav: FavoriteLine, delta: number) => void;
  /** The list must not scroll out from under a badge being carried. */
  onDragChange: (dragging: boolean) => void;
}

/**
 * The grid owns its drag state.
 *
 * It renders inside Home's `ListFooterComponent`, which is a `useMemo`: keeping
 * the state here means a lift does not touch that memo's dependencies, so the
 * footer element is not rebuilt — once per drag, let alone once per frame.
 */
const SavedLines = React.memo(function SavedLines({
  lines,
  editing,
  accentColor,
  onOpen,
  onRemove,
  onReorder,
  onMove,
  onDragChange,
}: SavedLinesProps) {
  const reduced = useReduceMotion();

  /** The grid as the drag maths sees it, readable from a callback without
   *  waiting for a render. */
  const linesRef = useRef<FavoriteLine[]>(lines);
  /** Measured badge boxes by line code — not by index, because a reorder
   *  renumbers every index but no badge changes size. */
  const sizesRef = useRef<Map<string, { w: number; h: number }>>(new Map());
  const activeRef = useRef(-1);
  /* JS mirror of the grid's width. Reading a shared value from JS is a
     synchronous hop into the UI runtime; the layout maths below needs the width
     on every measurement, and there is no reason to pay for it twice. */
  const gridWRef = useRef(0);

  const active = useSharedValue(-1);
  const target = useSharedValue(-1);
  const ox = useSharedValue(0);
  const oy = useSharedValue(0);
  const lift = useSharedValue(1);
  const wsSV = useSharedValue<number[]>([]);
  const hsSV = useSharedValue<number[]>([]);
  const gridW = useSharedValue(0);
  const gridH = useSharedValue(0);
  const reducedSV = useSharedValue(false);

  useEffect(() => {
    reducedSV.value = reduced;
  }, [reduced, reducedSV]);

  /**
   * Rebuild the geometry the drag maths runs on.
   *
   * Skipped while a badge is up: a font-scale change or a late measurement
   * mid-drag would slide every drop target out from under the user's finger.
   */
  const syncGeometry = useCallback(() => {
    if (activeRef.current >= 0) return;
    const ws: number[] = [];
    const hs: number[] = [];
    for (const f of linesRef.current) {
      const box = sizesRef.current.get(f.lineCode);
      ws.push(box?.w ?? 0);
      hs.push(box?.h ?? 0);
    }
    wsSV.value = ws;
    hsSV.value = hs;
    gridH.value = gridHeight(ws, hs, gridWRef.current, LINE_GRID_GAP);
  }, [wsSV, hsSV, gridH]);

  const onMeasure = useCallback(
    (lineCode: string, w: number, h: number) => {
      const prev = sizesRef.current.get(lineCode);
      // Sub-pixel churn from a re-render is not a new measurement.
      if (prev && Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1) return;
      sizesRef.current.set(lineCode, { w, h });
      syncGeometry();
    },
    [syncGeometry],
  );

  const onGridLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width } = e.nativeEvent.layout;
      if (Math.abs(gridWRef.current - width) < 1) return;
      gridWRef.current = width;
      gridW.value = width;
      syncGeometry();
    },
    [gridW, syncGeometry],
  );

  useEffect(() => {
    linesRef.current = lines;
    syncGeometry();
  }, [lines, syncGeometry]);

  const onLift = useCallback(
    (index: number) => {
      activeRef.current = index;
      hapticImpact();
      onDragChange(true);
    },
    [onDragChange],
  );

  const onTarget = useCallback(() => {
    hapticSelection();
  }, []);

  const onDrop = useCallback(
    (from: number, to: number) => {
      activeRef.current = -1;
      onDragChange(false);

      const arr = linesRef.current;
      if (from !== to && from >= 0 && from < arr.length && to >= 0 && to < arr.length) {
        const next = arr.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        linesRef.current = next;
        // Persisted by the caller, outside the state updater: updaters must be
        // pure, React may replay them.
        onReorder(next);
        hapticImpact();
      }

      /* Cleared in the same JS frame as the reorder. Both the reordered badges
         and the zeroed transforms then reach the UI thread on the same frame;
         deferring either one shows the other alone, which reads as the badge
         snapping back before it settles. */
      active.value = -1;
      target.value = -1;
      ox.value = 0;
      oy.value = 0;

      // Sizes measured while the badge was up were held back; take them now.
      syncGeometry();
    },
    [onDragChange, onReorder, active, target, ox, oy, syncGeometry],
  );

  const ctl = useMemo<LineDragCtl>(
    () => ({
      active,
      target,
      ox,
      oy,
      lift,
      ws: wsSV,
      hs: hsSV,
      gridW,
      gridH,
      reduced: reducedSV,
      onLift,
      onTarget,
      onDrop,
      onMeasure,
    }),
    [active, target, ox, oy, lift, wsSV, hsSV, gridW, gridH, reducedSV, onLift, onTarget, onDrop, onMeasure],
  );

  return (
    <View style={s.linesSection}>
      <View style={s.sectionRow}>
        <Text style={s.sectionLabel}>Saved Lines</Text>
        {/* The only advertisement a long press gets. */}
        {lines.length > 1 && <Text style={s.sectionHint}>Hold a badge to reorder</Text>}
      </View>
      <View style={s.lineGrid} onLayout={onGridLayout}>
        {lines.map((fav, i) => (
          <LineChip
            key={fav.lineCode}
            fav={fav}
            index={i}
            count={lines.length}
            editing={editing}
            accentColor={accentColor}
            ctl={ctl}
            onOpen={onOpen}
            onRemove={onRemove}
            onMove={onMove}
          />
        ))}
      </View>
    </View>
  );
});

/* ── Header live indicator ───────────────────────────────────── */

/**
 * Its own component on purpose: the arrivals summary changes on every poll and
 * the countdown once a second, and Home is a screen full of live cards. This
 * way a tick re-renders one line of text instead of all of them.
 */
const HeaderLive = React.memo(function HeaderLive({
  codes,
  paused,
}: {
  codes: string[];
  paused: boolean;
}) {
  const { updatedAt, failing, fetching } = useArrivalsStatus(codes);
  const nextPollAt = useArrivalsPollAt();
  const online = useNetworkStatus();

  return (
    <LiveStatus
      updatedAt={updatedAt}
      nextPollAt={nextPollAt}
      intervalMs={ARRIVALS_POLL_MS}
      fetching={fetching}
      offline={!online}
      failing={failing}
      paused={paused}
    />
  );
});

/* ── Home Screen ─────────────────────────────────────────────── */

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const prefetchLine = usePrefetchLine();
  const { primaryColor, setPrimaryColor, iconStyle, setIconStyle } = useSettings();
  const reduced = useReduceMotion();

  /* Seeded from storage's synchronous mirror. These used to start empty and be
     filled in useFocusEffect — which runs after commit, so frame 1 told every
     existing user "No favorites yet" on every cold start. */
  const [favorites, setFavorites] = useState<FavoriteLine[]>(getFavorites);
  const [favoriteStops, setFavoriteStops] = useState<FavoriteStop[]>(getFavoriteStops);
  const [refreshing, setRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editing, setEditing] = useState(false);
  /**
   * The stop canvas is in arrange mode: cards are outlined, draggable by the
   * body, resizable by the corner, and carry the accessibility actions that are
   * the only way to place a card without a gesture.
   *
   * Separate from `editing`, because they answer different questions — `editing`
   * is "show me the destructive controls" and this is "I am rearranging". The
   * header's Edit control turns both on, and that is not tidiness: a long press
   * is not reliably deliverable with a screen reader, so without a button that
   * enters arrange mode there would be no way to reach the move actions at all.
   */
  const [arranging, setArranging] = useState(false);
  /** Home stays mounted under /search, /map/* and /planner, so cards must be
   *  told to stop polling rather than relying on unmount. */
  const [focused, setFocused] = useState(true);
  /** A card is being carried. The canvas must not scroll under it by touch. */
  const [dragging, setDragging] = useState(false);
  /** The same, for a saved-line badge. Separate state so the two drags cannot
   *  clear each other's flag. */
  const [linesDragging, setLinesDragging] = useState(false);

  // Offline data download state
  const [offlineAvailable, setOfflineAvailable] = useState(isOfflineDataDownloaded);
  const [offlineTs, setOfflineTs] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [dlProgress, setDlProgress] = useState<OfflineProgress | null>(null);

  // Preload lines cache in background
  useLines();

  /* ── Canvas geometry ───────────────────────────────────────── */

  const scrollRef = useRef<ScrollView>(null);
  /** The stops as the drag maths sees them, readable from a gesture callback
   *  without waiting for a render. */
  const stopsRef = useRef<FavoriteStop[]>(favoriteStops);
  /** Measured heights of the cards that still size themselves, by stop code —
   *  not by index, because saving or removing a stop renumbers every index and
   *  resizes nothing. Cards run from two rows to ten and grow again when a
   *  timetable is expanded, so nothing here may assume a fixed height. */
  const heightsRef = useRef<Map<string, number>>(new Map());
  /** Bumped when a measurement actually changes, purely to re-run `placeAll`.
   *  The map stays a ref: a card reporting the height it reported last frame
   *  must not cost a render, and there are up to twenty of them each doing it
   *  on every poll. */
  const [heightsVersion, setHeightsVersion] = useState(0);
  const entranceRef = useRef(true);

  /* The canvas's usable width — the unit every stored layout number is a
     fraction of. Seeded from the window rather than left at zero until the
     first onLayout: frame 1 would otherwise stack every card at width zero,
     and this screen has already been through one round of the first frame
     lying to existing users. */
  const { width: windowW } = useWindowDimensions();
  const [measuredW, setMeasuredW] = useState(0);
  const canvasW = measuredW > 0 ? measuredW : Math.max(1, windowW - spacing.lg * 2);

  /* Rotation. Without this the stale measurement places one frame of cards at
     the previous orientation's width, which at 90° is a visible lurch. */
  useEffect(() => {
    setMeasuredW(0);
  }, [windowW]);

  const onCanvasLayout = useCallback((e: LayoutChangeEvent) => {
    const { width } = e.nativeEvent.layout;
    setMeasuredW((prev) => (Math.abs(prev - width) < 1 ? prev : width));
  }, []);

  const onMeasure = useCallback((stopCode: string, height: number) => {
    const prev = heightsRef.current.get(stopCode);
    // Sub-pixel churn from a re-render is not a new measurement.
    if (prev != null && Math.abs(prev - height) < 1) return;
    heightsRef.current.set(stopCode, height);
    setHeightsVersion((v) => v + 1);
  }, []);

  /**
   * Where every card sits.
   *
   * `heightsVersion` rather than the map itself is the dependency: the map is
   * mutated in place so its identity never changes, and the counter is the only
   * honest signal that its contents did.
   */
  const placed = useMemo(
    () => placeAll(favoriteStops, heightsRef.current, canvasW),
    [favoriteStops, canvasW, heightsVersion],
  );

  /* ── Drag state ────────────────────────────────────────────── */

  /* JS mirrors of what the auto-scroll tick needs sixty times a second.
     Reading a shared value from JS is a *synchronous* hop into the UI runtime —
     cheap once, not cheap in a frame loop competing with the drag it is meant
     to serve. */
  const placedRef = useRef(placed);
  const uRef = useRef(canvasW);
  const edgeXRef = useRef<number[]>([]);
  const edgeYRef = useRef<number[]>([]);
  const activeRef = useRef(-1);
  const guideRef = useRef({ x: -1, y: -1 });
  const scrollPosRef = useRef(0);
  const scrollMaxRef = useRef(0);
  const scrollAtRef = useRef(0);
  const viewportRef = useRef({ top: 0, height: 0 });
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const active = useSharedValue(-1);
  const dx = useSharedValue(0);
  const dy = useSharedValue(0);
  const panX = useSharedValue(0);
  const panY = useSharedValue(0);
  const lift = useSharedValue(1);
  const guideX = useSharedValue(-1);
  const guideY = useSharedValue(-1);
  const rectsSV = useSharedValue<Rect[]>([]);
  const othersSV = useSharedValue<Rect[]>([]);
  const edgeXSV = useSharedValue<number[]>([]);
  const edgeYSV = useSharedValue<number[]>([]);
  const uSV = useSharedValue(1);
  const resizing = useSharedValue(-1);
  const previewX = useSharedValue(0);
  const previewY = useSharedValue(0);
  const previewW = useSharedValue(0);
  const previewH = useSharedValue(0);
  const pointerY = useSharedValue(0);
  const scrollY = useSharedValue(0);
  const scrollAt = useSharedValue(0);
  const reducedSV = useSharedValue(false);

  useEffect(() => {
    reducedSV.value = reduced;
  }, [reduced, reducedSV]);

  useEffect(() => () => {
    if (edgeTimer.current) clearInterval(edgeTimer.current);
  }, []);

  /**
   * Republish the geometry the drag maths runs on, into both a JS mirror (for
   * the auto-scroll tick) and a shared copy (for the gesture worklets).
   *
   * Skipped while a card is up: an arrival landing and growing a flowing card
   * mid-drag would slide every magnet out from under the user's finger, and the
   * drop would then resolve against boxes that were not on screen when the user
   * aimed at them. `dropTick` is what guarantees this runs again afterwards
   * even in the paths where putting the card down changed no state.
   */
  const [dropTick, setDropTick] = useState(0);
  useEffect(() => {
    stopsRef.current = favoriteStops;
    if (activeRef.current >= 0) return;
    placedRef.current = placed;
    uRef.current = canvasW;
    rectsSV.value = placed.cards.map((c) => c.rect);
    uSV.value = canvasW;
  }, [favoriteStops, placed, canvasW, dropTick, rectsSV, uSV]);

  /**
   * Re-fit placed cards to the canvas.
   *
   * Fractions carry an arrangement across devices and orientations on their
   * own; what they cannot carry is the 120dp legibility floor, so a narrower
   * screen may need a card widened and everything it then collides with moved.
   * The other way in is an imported backup, which can carry an arrangement from
   * a phone of any size, so this watches the stops as well as the width.
   *
   * `fitAll` returns only what actually changed, which is what stops this from
   * chasing its own tail: the write it triggers re-runs the effect, the second
   * pass finds nothing to do, and the overwhelmingly common case — same phone,
   * same orientation, every launch — writes nothing at all.
   */
  useEffect(() => {
    const changed = fitAll(favoriteStops, canvasW);
    if (changed.size === 0) return;
    const patches = new Map<string, Partial<FavoriteStop>>();
    changed.forEach((rect, stopCode) => patches.set(stopCode, { layout: rect }));
    setFavoriteStops(updateFavoriteStops(patches));
  }, [favoriteStops, canvasW]);

  useEffect(() => {
    const t = setTimeout(() => {
      entranceRef.current = false;
    }, 900);
    return () => clearTimeout(t);
  }, []);

  /* ── Arranging ─────────────────────────────────────────────── */

  /**
   * Turn every flowing card into a placed one, at the box it already occupies.
   *
   * Run the moment anything is picked up, and nothing moves when it does — the
   * boxes being written are the ones `placeAll` just laid out. What changes is
   * that the cards stop being allowed to grow: from here on an arrival landing
   * scrolls inside a card instead of pushing the one below it down, which is
   * the only behaviour compatible with "nothing may overlap".
   *
   * Doing it at lift rather than at drop matters. An interrupted drag — a call
   * arriving mid-gesture — must still leave a consistent canvas, and it would
   * not if half the cards had concrete boxes and half were still flowing under
   * a card that had already been moved out of the stack.
   */
  const freezeFlowing = useCallback(() => {
    const patches = new Map<string, Partial<FavoriteStop>>();
    for (const c of placedRef.current.cards) {
      if (c.flowing) patches.set(c.stopCode, { layout: c.rect });
    }
    if (patches.size === 0) return;
    const next = updateFavoriteStops(patches);
    stopsRef.current = next;
    setFavoriteStops(next);
  }, []);

  /**
   * One tick of the edge auto-scroll. Runs on a timer rather than off the pan
   * callback, because the case it exists for is a finger held still at the edge
   * of the screen — which produces no pan updates at all.
   */
  const edgeTick = useCallback(() => {
    const a = activeRef.current;
    const vp = viewportRef.current;
    const cards = placedRef.current.cards;
    if (a < 0 || a >= cards.length || vp.height <= 0) return;

    const y = pointerY.value;
    const top = vp.top + EDGE_BAND;
    const bottom = vp.top + vp.height - EDGE_BAND;
    let step = 0;
    if (y < top) step = -EDGE_MAX_STEP * Math.min(1, (top - y) / EDGE_BAND);
    else if (y > bottom) step = EDGE_MAX_STEP * Math.min(1, (y - bottom) / EDGE_BAND);
    if (step === 0) return;

    const next = Math.max(0, Math.min(scrollMaxRef.current, scrollPosRef.current + step));
    if (Math.abs(next - scrollPosRef.current) < 0.5) return;
    /* Written optimistically: the onScroll event confirming this offset lands a
       frame later, and the card must not lag behind the content by that frame. */
    scrollPosRef.current = next;
    scrollY.value = next;
    scrollRef.current?.scrollTo({ y: next, animated: false });

    /* The finger has not moved, so nothing else will recompute the carried
       card: from its point of view the whole canvas just slid past it. */
    const carried = carryTo(
      cards[a].rect,
      panX.value,
      panY.value + (next - scrollAtRef.current),
      uRef.current,
      edgeXRef.current,
      edgeYRef.current,
    );
    dx.value = carried.dx;
    dy.value = carried.dy;
    const g = guideRef.current;
    if (carried.gx !== g.x || carried.gy !== g.y) {
      guideRef.current = { x: carried.gx, y: carried.gy };
      guideX.value = carried.gx;
      guideY.value = carried.gy;
      if (carried.gx >= 0 || carried.gy >= 0) hapticSelection();
    }
  }, [pointerY, scrollY, panX, panY, dx, dy, guideX, guideY]);

  const onLift = useCallback(
    (index: number) => {
      activeRef.current = index;
      scrollAtRef.current = scrollPosRef.current;
      guideRef.current = { x: -1, y: -1 };
      /* Rebuilt from this side's own mirror rather than shipped over from the
         gesture: the two are computed from the same `placeAll` output, and
         passing arrays across the runtime boundary on every lift is the more
         expensive way to arrive at the same numbers. */
      const others: Rect[] = [];
      placedRef.current.cards.forEach((c, i) => {
        if (i !== index) others.push(c.rect);
      });
      edgeXRef.current = edgesX(others);
      edgeYRef.current = edgesY(others);

      hapticImpact();
      setArranging(true);
      setDragging(true);
      freezeFlowing();
      if (!edgeTimer.current) edgeTimer.current = setInterval(edgeTick, EDGE_TICK_MS);
    },
    [edgeTick, freezeFlowing],
  );

  const onSnap = useCallback(() => {
    hapticSelection();
  }, []);

  const onDrop = useCallback(
    (index: number, x: number, y: number, w: number, h: number) => {
      if (edgeTimer.current) {
        clearInterval(edgeTimer.current);
        edgeTimer.current = null;
      }
      activeRef.current = -1;
      setDragging(false);

      const stop = stopsRef.current[index];
      if (stop) {
        const next = updateFavoriteStop(stop.stopCode, { layout: { x, y, w, h } });
        stopsRef.current = next;
        setFavoriteStops(next);
        hapticImpact();
      }

      /* Cleared in the same JS frame as the write. The card's new `left`/`top`
         and its zeroed transform then reach the UI thread together; deferring
         either one shows the other alone for a frame, which reads as the card
         snapping back before it settles. */
      active.value = -1;
      dx.value = 0;
      dy.value = 0;
      guideX.value = -1;
      guideY.value = -1;

      // Measurements taken while the card was up were held back; take them now.
      setDropTick((v) => v + 1);
    },
    [active, dx, dy, guideX, guideY],
  );

  /**
   * A corner drag is a lift too, as far as the rest of the screen is concerned:
   * the canvas must stop scrolling, and the flowing cards must become boxes
   * before anything is asked to have a size.
   */
  const onResizeStart = useCallback(
    (index: number) => {
      activeRef.current = index;
      hapticImpact();
      setArranging(true);
      setDragging(true);
      freezeFlowing();
    },
    [freezeFlowing],
  );

  const onResizeEnd = useCallback(
    (index: number, x: number, y: number, w: number, h: number) => {
      activeRef.current = -1;
      setDragging(false);
      const stop = stopsRef.current[index];
      if (stop) {
        const next = updateFavoriteStop(stop.stopCode, { layout: { x, y, w, h } });
        stopsRef.current = next;
        setFavoriteStops(next);
        hapticImpact();
      }
      setDropTick((v) => v + 1);
    },
    [],
  );

  /**
   * Every field here is stable, and it has to be: this object is a dependency
   * of each card's gesture, and a new gesture object mid-drag detaches the one
   * the finger is already holding.
   */
  const ctl = useMemo<CanvasCtl>(
    () => ({
      active,
      dx,
      dy,
      panX,
      panY,
      lift,
      guideX,
      guideY,
      rects: rectsSV,
      others: othersSV,
      edgeX: edgeXSV,
      edgeY: edgeYSV,
      u: uSV,
      resizing,
      previewX,
      previewY,
      previewW,
      previewH,
      pointerY,
      scrollY,
      scrollAt,
      reduced: reducedSV,
      onLift,
      onSnap,
      onDrop,
      onResizeStart,
      onResizeEnd,
    }),
    [
      active, dx, dy, panX, panY, lift, guideX, guideY, rectsSV, othersSV,
      edgeXSV, edgeYSV, uSV, resizing, previewX, previewY, previewW, previewH,
      pointerY, scrollY, scrollAt, reducedSV,
      onLift, onSnap, onDrop, onResizeStart, onResizeEnd,
    ],
  );

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      scrollPosRef.current = contentOffset.y;
      scrollY.value = contentOffset.y;
      scrollMaxRef.current = Math.max(0, contentSize.height - layoutMeasurement.height);
    },
    [scrollY],
  );

  const onScrollLayout = useCallback((e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    // The scroll view's parent fills the screen from the top, so its own y
    // doubles as the window coordinate the gesture's absoluteY is measured
    // against.
    viewportRef.current = { top: y, height };
  }, []);

  /* ── Favorites ─────────────────────────────────────────────── */

  const loadFavorites = useCallback(() => {
    setFavorites(getFavorites());
    setFavoriteStops(getFavoriteStops());
    setOfflineAvailable(isOfflineDataDownloaded());
    getOfflineTimestamp().then(setOfflineTs);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      loadFavorites();
      return () => {
        setFocused(false);
        /* Arrange mode does not survive leaving the screen. Coming back from a
           map to find the cards still outlined and every tap moving something
           is a mode the user did not choose to still be in. */
        setArranging(false);
      };
    }, [loadFavorites]),
  );

  /** Leave both editing and arranging together. The header carries one control
   *  for the pair, so they must not be able to end up in different states. */
  const endEditing = useCallback(() => {
    setEditing(false);
    setArranging(false);
  }, []);

  const toggleEditing = useCallback(() => {
    if (editing || arranging) endEditing();
    else {
      setEditing(true);
      setArranging(true);
    }
  }, [editing, arranging, endEditing]);

  const handleRemove = useCallback((fav: FavoriteLine) => {
    hapticImpact();
    // Captured before the write: `removeFavorite` swaps the mirror for a new
    // array, so this reference stays the pre-removal list.
    const before = getFavorites().slice();
    setFavorites(removeFavorite(fav.lineCode));
    showUndo({
      message: `Removed line ${fav.lineId}`,
      onUndo: () => setFavorites(restoreLines(before)),
    });
  }, []);

  /** Commit a dragged line order. */
  const handleReorderLines = useCallback((next: FavoriteLine[]) => {
    setFavorites(next);
    // Outside the state updater: updaters must be pure, React may replay them.
    persistLineOrder(next);
  }, []);

  /** Move a saved line by one position — the accessible counterpart to the
   *  drag, and the only path a screen reader can drive. Reads the order from
   *  storage's mirror rather than from state so the callback stays stable, and
   *  therefore so does the list footer it is handed to. */
  const moveLine = useCallback((fav: FavoriteLine, delta: number) => {
    const cur = getFavorites();
    const i = cur.findIndex((f) => f.lineCode === fav.lineCode);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= cur.length) return;
    const next = cur.slice();
    next[i] = cur[j];
    next[j] = cur[i];
    setFavorites(next);
    hapticSelection();
    persistLineOrder(next);
  }, []);

  const handleOpenLine = useCallback((fav: FavoriteLine) => {
    // Start the request the map screen would otherwise wait to make, so it runs
    // under the push transition instead of after it.
    prefetchLine(fav.lineCode);
    router.push({
      pathname: '/map/[lineCode]',
      params: { lineCode: fav.lineCode, lineId: fav.lineId, lineDescr: fav.lineDescrEng },
    });
  }, [router, prefetchLine]);

  const handleRemoveStop = useCallback((stop: FavoriteStop) => {
    hapticImpact();
    const before = getFavoriteStops().slice();
    setFavoriteStops(removeFavoriteStop(stop.stopCode));
    showUndo({
      message: `Removed “${stop.stopName}”`,
      onUndo: () => setFavoriteStops(restoreStops(before)),
    });
  }, []);

  /** Reorder by one position. The accessible counterpart to the drag: this is
   *  the path a screen reader can actually drive. The storage write stays
   *  outside the state updater — updaters must be pure, React may replay them. */
  const moveStop = useCallback((stop: FavoriteStop, delta: number) => {
    const i = favoriteStops.findIndex((st) => st.stopCode === stop.stopCode);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= favoriteStops.length) return;
    const next = favoriteStops.slice();
    next[i] = favoriteStops[j];
    next[j] = favoriteStops[i];
    setFavoriteStops(next);
    hapticSelection();
    persistStopOrder(next);
  }, [favoriteStops]);

  const moveStopUp = useCallback((stop: FavoriteStop) => moveStop(stop, -1), [moveStop]);
  const moveStopDown = useCallback((stop: FavoriteStop) => moveStop(stop, 1), [moveStop]);

  /**
   * Pull to refresh. This used to call `loadFavorites()` between two batched
   * `setRefreshing` calls — the spinner never appeared and no arrival data was
   * ever refetched. It is the most natural gesture in a bus app.
   */
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    loadFavorites();
    try {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['arrivals'] }),
        queryClient.refetchQueries({ queryKey: ['routesForStop'] }),
      ]);
    } catch {
      // A failed refresh is surfaced per-card; the spinner must still stop.
    } finally {
      setRefreshing(false);
    }
  }, [loadFavorites, queryClient]);

  const handleDownloadOffline = useCallback(async () => {
    setDownloading(true);
    setDlProgress(null);
    const ok = await downloadAllOfflineData((p) => setDlProgress(p));
    setDownloading(false);
    if (ok) {
      setOfflineAvailable(true);
      getOfflineTimestamp().then(setOfflineTs);
    }
  }, []);

  /* Still a dialog, unlike the removals above: this one deletes a bundle that
     takes minutes to re-download, so it is neither cheap nor reversible. */
  const handleClearOffline = useCallback(() => {
    Alert.alert('Clear Offline Data', 'This will remove all cached stops and schedules.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await removeAllOfflineData();
          setOfflineAvailable(false);
          setOfflineTs(null);
          setDlProgress(null);
        },
      },
    ]);
  }, []);

  /* ── Canvas plumbing ───────────────────────────────────────── */

  const stopsHeader = useMemo(
    () =>
      favoriteStops.length > 0 ? (
        <View style={s.sectionRow}>
          <Text style={s.sectionLabel}>Saved Stops</Text>
          {/* The only advertisement a long press gets, and the only thing that
              says what arrange mode is for while it is on. */}
          <Text style={s.sectionHint}>
            {arranging ? 'Drag to move · Done when finished' : 'Hold a card to arrange'}
          </Text>
        </View>
      ) : null,
    [favoriteStops.length, arranging],
  );

  const listFooter = useMemo(
    () =>
      favorites.length > 0 ? (
        <SavedLines
          lines={favorites}
          editing={editing}
          accentColor={primaryColor}
          onOpen={handleOpenLine}
          onRemove={handleRemove}
          onReorder={handleReorderLines}
          onMove={moveLine}
          onDragChange={setLinesDragging}
        />
      ) : null,
    [favorites, editing, primaryColor, handleOpenLine, handleRemove, handleReorderLines, moveLine],
  );

  /** Which stops the header's freshness readout speaks for. The map screens
   *  also populate `['arrivals', …]`, for stops nobody has saved. */
  const stopCodes = useMemo(() => favoriteStops.map((st) => st.stopCode), [favoriteStops]);

  const isEmpty = favorites.length === 0 && favoriteStops.length === 0;
  const canEdit = !isEmpty;
  const onPrimary = onAccent(primaryColor);

  return (
    <View style={[s.container, { paddingTop: insets.top + spacing.sm }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <View style={s.logoRow}>
          <Pressable
            style={s.avatarBtn}
            onPress={() => setShowSettings(true)}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Image source={{ uri: USER_MARKER_BASE64 }} style={s.logoIcon} />
          </Pressable>
          {/* Wears the accent color: it was the one piece of chrome the
              setting never reached. */}
          <Text style={[s.logo, { color: primaryColor }]}>F*ck OASA</Text>
          {(canEdit || arranging) && (
            <Pressable
              style={s.editBtn}
              onPress={toggleEditing}
              accessibilityRole="button"
              accessibilityState={{ selected: editing || arranging }}
              accessibilityLabel={
                editing || arranging
                  ? 'Finish arranging and editing saved items'
                  : 'Arrange and edit saved items'
              }
              accessibilityHint={
                editing || arranging
                  ? undefined
                  : 'Lets you move and resize saved stops, and remove saved items'
              }
            >
              <Ionicons
                name={editing || arranging ? 'checkmark' : 'create-outline'}
                size={16}
                color={editing || arranging ? primaryColor : colors.textMuted}
              />
              <Text
                style={[
                  s.editBtnText,
                  { color: editing || arranging ? primaryColor : colors.textMuted },
                ]}
              >
                {editing || arranging ? 'Done' : 'Edit'}
              </Text>
            </Pressable>
          )}
        </View>

        <Pressable
          style={s.searchBtn}
          onPress={() => router.push('/search')}
          accessibilityRole="button"
          accessibilityLabel="Search for a bus line"
        >
          <Ionicons name="search" size={20} color={colors.text} />
          <Text style={s.searchBtnText} numberOfLines={1}>Find a line…</Text>
        </Pressable>

        <View style={s.actionRow}>
          <Pressable
            style={s.actionBtn}
            onPress={() => router.push('/map/nearby')}
            accessibilityRole="button"
            accessibilityLabel="Stops near me"
          >
            <Ionicons name="location" size={20} color={primaryColor} />
            <Text style={s.actionBtnText}>Nearby</Text>
          </Pressable>
          <Pressable
            style={s.actionBtn}
            onPress={() => router.push('/planner')}
            accessibilityRole="button"
            accessibilityLabel="Plan a journey"
          >
            <Ionicons name="navigate" size={20} color={primaryColor} />
            <Text style={s.actionBtnText}>Go To</Text>
          </Pressable>
        </View>

        {/* Dismissing the settings sheet used to hide an in-flight download
            entirely, with no way to tell whether it was still running. */}
        {downloading && !showSettings && (
          <View style={s.headerProgress} accessibilityLabel="Downloading offline data">
            <Text style={s.headerProgressText}>Offline data…</Text>
            <View style={s.headerProgressTrack}>
              <View
                style={[
                  s.headerProgressFill,
                  {
                    backgroundColor: primaryColor,
                    width: dlProgress && dlProgress.total > 0
                      ? `${Math.round((dlProgress.current / dlProgress.total) * 100)}%`
                      : '5%',
                  },
                ]}
              />
            </View>
          </View>
        )}

        {/* One indicator for the whole screen. The cards used to carry one
            each, which was six components counting the same seconds and none
            of them able to say when the next refresh was due. */}
        {favoriteStops.length > 0 && <HeaderLive codes={stopCodes} paused={!focused} />}
      </View>

      {isEmpty ? (
        <View style={s.empty}>
          <Ionicons name="bus-outline" size={48} color={colors.border} />
          <Text style={s.emptyTitle}>Nothing saved yet</Text>
          <Text style={s.emptySubtitle}>
            Save the stops you use and their arrivals show up here.
          </Text>
          <View style={s.emptyActions}>
            <Pressable
              style={[s.emptyPrimaryBtn, { backgroundColor: primaryColor }]}
              onPress={() => router.push('/map/nearby')}
              accessibilityRole="button"
              accessibilityLabel="Find stops near me"
            >
              <Ionicons name="location" size={18} color={onPrimary} />
              <Text style={[s.emptyPrimaryText, { color: onPrimary }]}>Find stops near me</Text>
            </Pressable>
            <Pressable
              style={s.emptySecondaryBtn}
              onPress={() => router.push('/search')}
              accessibilityRole="button"
              accessibilityLabel="Search for a bus line"
            >
              <Ionicons name="search" size={18} color={colors.text} />
              <Text style={s.emptySecondaryText}>Search a line</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={[s.list, { paddingBottom: insets.bottom + spacing.xl * 2 }]}
          // A carried card — or badge — would otherwise fight the canvas for
          // the same finger.
          scrollEnabled={!dragging && !linesDragging}
          onScroll={onScroll}
          scrollEventThrottle={16}
          onLayout={onScrollLayout}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={primaryColor}
              colors={[primaryColor]}
            />
          }
          showsVerticalScrollIndicator={false}
        >
          {stopsHeader}
          {/* Every card is absolutely positioned inside this box, so the box
              has to be told how tall it is — nothing inside it contributes to
              its height, and without that the saved lines below would sit on
              top of the stops. `placed.cards` is built from `favoriteStops` in
              the same pass, so the two are indexed alike by construction. */}
          {favoriteStops.length > 0 && (
            <View style={[s.canvas, { height: placed.height }]} onLayout={onCanvasLayout}>
              {favoriteStops.map((stop, i) => (
                <StopCard
                  key={stop.stopCode}
                  stop={stop}
                  index={i}
                  count={favoriteStops.length}
                  card={placed.cards[i]}
                  primaryColor={primaryColor}
                  focused={focused}
                  editing={editing}
                  arranging={arranging}
                  entrance={entranceRef.current}
                  reduced={reduced}
                  ctl={ctl}
                  onMeasure={onMeasure}
                  onRemove={handleRemoveStop}
                  onMoveUp={moveStopUp}
                  onMoveDown={moveStopDown}
                />
              ))}
              {/* Painted last so they sit over the cards, and outside any of
                  them so an alignment with a neighbour is drawn where the two
                  actually meet rather than clipped to the card being moved. */}
              <SnapGuides ctl={ctl} color={primaryColor} />
            </View>
          )}
          {listFooter}
        </ScrollView>
      )}

      <SettingsModal
        visible={showSettings}
        onClose={() => setShowSettings(false)}
        primaryColor={primaryColor}
        setPrimaryColor={setPrimaryColor}
        iconStyle={iconStyle}
        setIconStyle={setIconStyle}
        offlineAvailable={offlineAvailable}
        offlineTs={offlineTs}
        downloading={downloading}
        progress={dlProgress}
        onDownload={handleDownloadOffline}
        onClear={handleClearOffline}
        onDataRestored={loadFavorites}
      />
    </View>
  );
}
