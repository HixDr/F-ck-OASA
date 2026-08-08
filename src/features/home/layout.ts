/**
 * The saved-stop canvas: units, size tiers, magnets and overlap resolution.
 *
 * Everything that decides *where a card may sit* lives here, with no React in
 * it, because the same maths has to run in three places that must not be
 * allowed to disagree: a render pass on the JS thread, a gesture worklet on the
 * UI thread, and an accessibility action that involves no gesture at all. A
 * "move left" that resolved a collision differently from a drag would be a
 * second layout engine that nobody maintains and only screen-reader users hit.
 *
 * ## Units
 *
 * See `StopLayout`. Every number is a fraction of the canvas's usable width
 * `u`; `y` and `h` use the same unit rather than a fraction of height, so a
 * card's aspect survives rotation. `x + w <= 1` is an invariant, which is why
 * nothing here needs a "rescue a stranded card" pass — off-screen horizontally
 * is not representable, and the canvas grows downwards to fit whatever `y` says.
 *
 * The one thing fractions cannot preserve is the *dp* floor: 0.33 of a 412dp
 * phone is a legible compact card, and of a 320dp one it is not. `fitAll` is
 * the answer, and it runs when `u` changes rather than on every frame.
 *
 * ## Flowing cards
 *
 * `h === 0` — or no layout at all — means "this card has never been arranged".
 * It is full width, its height is whatever its content measures, and the canvas
 * stacks it beneath everything that *has* been arranged.
 *
 * That single rule is the whole migration story. An existing install has no
 * layouts, so every card flows, and the canvas reproduces 1.2.4's column
 * exactly — same width, same content-driven heights, same 8dp gap. It is also
 * what a newly saved stop gets, which is precisely "appends below the lowest
 * card at full width".
 *
 * A flowing card is allowed to grow when its arrivals land, because nothing is
 * ever placed below it. A *placed* card is not: growing into a neighbour would
 * cover another stop's minutes, so a placed card is a fixed box whose content
 * scrolls inside it. Picking any card up freezes every flowing card at the box
 * it already occupies, so the transition between the two worlds is invisible.
 */

import { spacing } from '../../theme';
import type { FavoriteStop, StopLayout } from '../../types';

/** A box in stored units. Structurally `StopLayout`; aliased so the geometry
 *  below reads as geometry rather than as persistence. */
export type Rect = StopLayout;

/* ── The numbers the design rests on ─────────────────────────── */

/**
 * Magnet radius. Small enough that a deliberate offset of a dozen points
 * survives being dragged past a neighbour, large enough that "nearly aligned"
 * never survives a drop — an 8dp misalignment across two columns is exactly the
 * kind of thing the eye reads as broken rather than as intentional.
 */
export const SNAP_DP = 8;

/**
 * The floor. Content is ~88dp inside the card's own padding, and a line badge
 * (44) plus an arrival block (56) is 100dp, so at this width the two cannot sit
 * side by side. The compact tier stacks them instead and drops the figure to
 * ~24pt — the one place the "the arrival number survives as long as possible"
 * principle is traded away, deliberately, to fit three cards across a phone.
 */
export const CARD_MIN_W_DP = 120;
/** Half of a 364dp canvas: badge + figure fit side by side at full size, with
 *  ~46dp left over — enough for the pair and a gap, not for a destination. */
export const TIER_STANDARD_DP = 178;
/** Where a destination label becomes legible beside badge and figure. */
export const TIER_DETAILED_DP = 300;
/** A stop name plus one arrival row. */
export const CARD_MIN_H_DP = 80;

/**
 * Gap between flowing cards.
 *
 * This is 1.2.4's `marginBottom: spacing.sm` on the card itself, moved out to
 * the canvas: a card must now fill exactly the box it is handed, and a margin
 * inside that box is height the geometry thinks it owns and the card does not.
 */
export const CARD_GAP_DP = spacing.sm;

/**
 * Height assumed for a flowing card that has not reported a measurement yet.
 * Only the first frame after a cold start leans on it, and it is roughly a
 * two-line card, so the stack it produces is close enough that the correction a
 * frame later does not read as a jump.
 */
export const FALLBACK_CARD_H_DP = 168;

/**
 * How far a "move left/right/up/down" accessibility action travels when there
 * is no alignment opportunity nearer than this. Small enough to be a nudge,
 * large enough that crossing a screen is a handful of activations rather than
 * forty.
 */
export const NUDGE_STEP_DP = 32;

/** How much "grow" and "shrink" change a card's width: a quarter of the canvas,
 *  so four activations span the whole range and every stop lands on a tier
 *  boundary or a clean fraction rather than somewhere arbitrary. */
export const RESIZE_STEP = 0.25;

/**
 * Slack for every edge comparison.
 *
 * Two cards that share an edge must not count as overlapping. After a snap they
 * share it only to within floating-point error, so a strict comparison rejects
 * the position the magnet just produced and the card jumps somewhere else on
 * drop — the single most confusing thing this geometry could do. 1e-4 is ~0.04dp
 * on a 364dp canvas: below the point where anything is visible, far above the
 * error a couple of divisions accumulate.
 */
const EPS = 1e-4;

/* ── Size tiers ──────────────────────────────────────────────── */

export type CardTier = 'compact' | 'standard' | 'detailed';

/** Chosen from the card's measured width, so a tier change is a consequence of
 *  resizing rather than a mode the user has to select. */
export function tierFor(widthDp: number): CardTier {
  'worklet';
  if (widthDp >= TIER_DETAILED_DP) return 'detailed';
  if (widthDp >= TIER_STANDARD_DP) return 'standard';
  return 'compact';
}

/* ── Rect predicates ─────────────────────────────────────────── */

export function overlaps(a: Rect, b: Rect): boolean {
  'worklet';
  return (
    a.x + EPS < b.x + b.w &&
    b.x + EPS < a.x + a.w &&
    a.y + EPS < b.y + b.h &&
    b.y + EPS < a.y + a.h
  );
}

function hitsAny(r: Rect, others: readonly Rect[]): boolean {
  'worklet';
  for (let i = 0; i < others.length; i++) {
    if (overlaps(r, others[i])) return true;
  }
  return false;
}

/** Lowest edge in a set of boxes. The canvas's height, and the one `y` at which
 *  a card of any size is guaranteed to fit. */
export function bottomOf(rects: readonly Rect[]): number {
  'worklet';
  let bottom = 0;
  for (let i = 0; i < rects.length; i++) {
    const b = rects[i].y + rects[i].h;
    if (b > bottom) bottom = b;
  }
  return bottom;
}

/* ── Magnets ─────────────────────────────────────────────────── */

/** Coordinates worth aligning a card's left or right edge to: both canvas
 *  margins, and both vertical edges of every other card. */
export function edgesX(others: readonly Rect[]): number[] {
  'worklet';
  const out: number[] = [0, 1];
  for (let i = 0; i < others.length; i++) {
    out.push(others[i].x);
    out.push(others[i].x + others[i].w);
  }
  return out;
}

/** The same vertically. There is no bottom margin — the canvas grows. */
export function edgesY(others: readonly Rect[]): number[] {
  'worklet';
  const out: number[] = [0];
  for (let i = 0; i < others.length; i++) {
    out.push(others[i].y);
    out.push(others[i].y + others[i].h);
  }
  return out;
}

export interface Snap {
  /** Where the card's leading edge ends up. */
  v: number;
  /** The edge that attracted it, for the guide line. Negative when nothing did. */
  guide: number;
}

/**
 * Snap one axis, independently of the other — so a card can align to one
 * neighbour horizontally and a different one vertically, which is what makes
 * this feel like a grid the user invented rather than one imposed on them.
 *
 * Both of the card's own edges are tested against every candidate in the same
 * loop, so "align lefts", "align rights" and "sit flush against" all fall out
 * of one comparison instead of being three cases to keep in step.
 *
 * The magnet only ever *offers* a position: `tol` is a radius, and pulling
 * beyond it simply stops matching. Nothing here can refuse a placement.
 */
export function snapAxis(origin: number, size: number, edges: readonly number[], tol: number): Snap {
  'worklet';
  let v = origin;
  let best = tol;
  let guide = -1;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const dLead = Math.abs(origin - e);
    if (dLead < best) {
      best = dLead;
      v = e;
      guide = e;
    }
    const dTrail = Math.abs(origin + size - e);
    if (dTrail < best) {
      best = dTrail;
      v = e - size;
      guide = e;
    }
  }
  return { v, guide };
}

/* ── Overlap resolution ──────────────────────────────────────── */

/**
 * The nearest free position for a card that was dropped on top of something.
 *
 * Rejecting the drop and springing the card home is the obvious alternative and
 * it feels broken — the user aimed somewhere, and the app answered by undoing
 * the whole gesture. Sliding to the nearest gap reads as magnetism instead, and
 * it is never more than one card-width away from where they aimed.
 *
 * "Nearest" is exact rather than a heuristic walk: the only positions that can
 * possibly be the nearest free one are those where the card sits flush against
 * a blocker on one axis, so the candidate set is the desired coordinate plus
 * the four flush positions per blocker, and every combination of the two axes
 * is tried. With 20 saved stops that is ~1700 candidates of a handful of
 * comparisons each, once per drop, which is nothing — and it cannot fail,
 * because `bottom` (below every card) is always in the candidate set.
 */
export function resolveMove(want: Rect, others: readonly Rect[]): Rect {
  'worklet';
  const maxX = 1 - want.w;
  const x = want.x < 0 ? 0 : want.x > maxX ? maxX : want.x;
  const y = want.y < 0 ? 0 : want.y;
  const base = { x, y, w: want.w, h: want.h };
  if (!hitsAny(base, others)) return base;

  const xs: number[] = [x];
  const ys: number[] = [y];
  const bottom = bottomOf(others);
  for (let i = 0; i < others.length; i++) {
    const b = others[i];
    const left = b.x - want.w;
    if (left > 0) xs.push(left > maxX ? maxX : left);
    const right = b.x + b.w;
    if (right < maxX) xs.push(right < 0 ? 0 : right);
    const above = b.y - want.h;
    if (above > 0) ys.push(above);
    ys.push(b.y + b.h);
  }
  // Always available, always free. Without it a pathological arrangement could
  // leave the loop below with nothing to return.
  ys.push(bottom);

  let bestX = x;
  let bestY = bottom;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < ys.length; j++) {
      const cand = { x: xs[i], y: ys[j], w: want.w, h: want.h };
      if (hitsAny(cand, others)) continue;
      const dx = cand.x - x;
      const dy = cand.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        bestX = cand.x;
        bestY = cand.y;
      }
    }
  }
  return { x: bestX, y: bestY, w: want.w, h: want.h };
}

/**
 * The same for a resize, which wants a different answer.
 *
 * A card whose corner is being dragged has a fixed top-left; teleporting it to
 * a free position elsewhere — which is what `resolveMove` would do — reads as
 * the card escaping the finger. So the box is shrunk against whatever it ran
 * into first, which is what the user would have done themselves a moment later.
 * Only when it cannot shrink far enough to clear the obstruction *and* stay
 * above the legibility floor does it fall back to moving.
 *
 * Width is clamped against the blockers that share the card's rows, then height
 * against those that share its (now known) columns. Doing both in one pass
 * would need the answer to compute the answer; two passes in that order can
 * only ever over-shrink, never overlap, which is the safe direction.
 */
export function resolveResize(
  want: Rect,
  others: readonly Rect[],
  minW: number,
  minH: number,
): Rect {
  'worklet';
  const maxW = 1 - want.x;
  let w = want.w > maxW ? maxW : want.w;
  let h = want.h;

  for (let i = 0; i < others.length; i++) {
    const b = others[i];
    // Shares rows with the box as the user is dragging it.
    if (want.y + EPS < b.y + b.h && b.y + EPS < want.y + h) {
      const limit = b.x - want.x;
      if (limit > 0 && limit < w) w = limit;
    }
  }
  if (w < minW) w = minW;

  for (let i = 0; i < others.length; i++) {
    const b = others[i];
    if (want.x + EPS < b.x + b.w && b.x + EPS < want.x + w) {
      const limit = b.y - want.y;
      if (limit > 0 && limit < h) h = limit;
    }
  }
  if (h < minH) h = minH;

  const box = { x: want.x, y: want.y, w, h };
  return hitsAny(box, others) ? resolveMove(box, others) : box;
}

/* ── Keyboard / screen-reader steps ──────────────────────────── */

/**
 * Move one step along an axis — the accessibility path, and the reason the
 * resolvers above are not buried inside a gesture callback.
 *
 * A step is "as far as the next alignment opportunity, but no further than
 * `NUDGE_STEP_DP`". A fixed step alone would take forty activations to cross a
 * phone; jumping straight to the next neighbour's edge alone would fling the
 * card across the screen when the nearest neighbour happens to be far away.
 * Taking whichever is closer gives a predictable nudge that still lands exactly
 * on an edge whenever one is within reach.
 */
export function nudge(
  r: Rect,
  others: readonly Rect[],
  axis: 'x' | 'y',
  dir: 1 | -1,
  u: number,
): Rect {
  const size = axis === 'x' ? r.w : r.h;
  const from = axis === 'x' ? r.x : r.y;
  const edges = axis === 'x' ? edgesX(others) : edgesY(others);
  const step = NUDGE_STEP_DP / u;

  let target = from + dir * step;
  for (const e of edges) {
    // Both of the card's edges again, so "sit flush against the card ahead" is
    // reachable as well as "align with it".
    for (const cand of [e, e - size]) {
      if (dir > 0 ? cand > from + EPS && cand < target : cand < from - EPS && cand > target) {
        target = cand;
      }
    }
  }

  const want = axis === 'x' ? { ...r, x: target } : { ...r, y: target };
  return resolveMove(want, others);
}

/**
 * Grow or shrink by one step, preserving aspect.
 *
 * Two actions rather than four: the stored units already tie `h` to the card's
 * width, so scaling both together keeps the box the shape the user made it and
 * halves the number of entries in an already long screen-reader menu.
 */
export function resizeStep(r: Rect, others: readonly Rect[], dir: 1 | -1, u: number): Rect {
  const minW = CARD_MIN_W_DP / u;
  const minH = CARD_MIN_H_DP / u;
  const maxW = 1 - r.x;
  let w = r.w + dir * RESIZE_STEP;
  if (w > maxW) w = maxW;
  if (w < minW) w = minW;
  const h = r.w > 0 ? r.h * (w / r.w) : r.h;
  return resolveResize({ x: r.x, y: r.y, w, h: h < minH ? minH : h }, others, minW, minH);
}

/* ── Placement ───────────────────────────────────────────────── */

export interface PlacedCard {
  stopCode: string;
  /** Canvas pixels, ready for an absolutely positioned view. */
  left: number;
  top: number;
  width: number;
  height: number;
  tier: CardTier;
  /** Still sizing itself to its content. See the module comment. */
  flowing: boolean;
  /** The same box in stored units — what the drag maths reads and what the
   *  freeze writes. Derived here so the two can never drift apart. */
  rect: Rect;
}

/**
 * Resolve every saved stop to a box on the canvas.
 *
 * Placed cards keep the position they were given. Flowing cards are stacked, in
 * saved order, beneath the lowest placed card — which with no placed cards at
 * all is 1.2.4's column, from y = 0, unchanged.
 *
 * Order is preserved: the gesture code indexes into this array and into the
 * stops array interchangeably.
 */
export function placeAll(
  stops: readonly FavoriteStop[],
  measured: ReadonlyMap<string, number>,
  u: number,
): { cards: PlacedCard[]; height: number } {
  if (u <= 0) return { cards: [], height: 0 };

  let flowTop = 0;
  for (const st of stops) {
    const l = st.layout;
    if (!l || l.h <= 0) continue;
    const b = l.y + l.h;
    if (b > flowTop) flowTop = b;
  }
  if (flowTop > 0) flowTop += CARD_GAP_DP / u;

  const cards: PlacedCard[] = [];
  let height = 0;
  for (const st of stops) {
    const l = st.layout;
    let rect: Rect;
    let flowing: boolean;
    if (l && l.h > 0) {
      rect = l;
      flowing = false;
    } else {
      const hPx = measured.get(st.stopCode) ?? FALLBACK_CARD_H_DP;
      rect = { x: 0, y: flowTop, w: 1, h: hPx / u };
      flowing = true;
      flowTop += (hPx + CARD_GAP_DP) / u;
    }
    const top = rect.y * u;
    const heightPx = rect.h * u;
    cards.push({
      stopCode: st.stopCode,
      left: rect.x * u,
      top,
      width: rect.w * u,
      height: heightPx,
      tier: tierFor(rect.w * u),
      flowing,
      rect,
    });
    if (top + heightPx > height) height = top + heightPx;
  }
  return { cards, height };
}

/**
 * Re-fit placed cards to a canvas of a different width.
 *
 * Fractions carry an arrangement between devices and orientations on their own;
 * the one thing they cannot carry is the legibility floor, because 0.33 of a
 * 412dp phone is a readable compact card and 0.33 of a 320dp one is not. So a
 * width change widens anything that fell under the floor and then re-resolves,
 * in saved order, so the cards that were there first keep their positions.
 *
 * Returns only the boxes that actually changed, because the overwhelmingly
 * common case — the same device, same orientation — must not write anything.
 */
export function fitAll(stops: readonly FavoriteStop[], u: number): Map<string, Rect> {
  const changed = new Map<string, Rect>();
  if (u <= 0) return changed;
  const minW = CARD_MIN_W_DP / u;
  const minH = CARD_MIN_H_DP / u;
  const placed: Rect[] = [];

  for (const st of stops) {
    const l = st.layout;
    if (!l || l.h <= 0) continue;
    let w = l.w < minW ? minW : l.w;
    if (w > 1) w = 1;
    let h = l.h < minH ? minH : l.h;
    const maxX = 1 - w;
    const x = l.x < 0 ? 0 : l.x > maxX ? maxX : l.x;
    const got = resolveMove({ x, y: l.y < 0 ? 0 : l.y, w, h }, placed);
    placed.push(got);
    if (
      Math.abs(got.x - l.x) > EPS ||
      Math.abs(got.y - l.y) > EPS ||
      Math.abs(got.w - l.w) > EPS ||
      Math.abs(got.h - l.h) > EPS
    ) {
      changed.set(st.stopCode, got);
    }
  }
  return changed;
}
