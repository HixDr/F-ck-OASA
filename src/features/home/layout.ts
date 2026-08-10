/**
 * The saved-stop canvas: columns, per-span floors, magnets and overlap resolution.
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
 * See `StopLayout`. The horizontal axis is **three columns and nothing else**:
 * `col` ∈ {0,1,2}, `span` ∈ {1,2,3}, `col + span <= COLS`. The vertical axis is
 * continuous, in fractions of the canvas's usable width `u` — the same unit as
 * before, so a card's aspect survives a rotation or a narrower phone.
 *
 * Columns replaced fractions of the width because free width meant a card could
 * be any size: its content had to adapt at measured breakpoints, and nothing
 * lined up with anything. They also make this file smaller rather than larger.
 * An overlapping drop used to be resolved by searching arbitrary real
 * coordinates on both axes; horizontally there are now at most three answers,
 * `col + span <= COLS` cannot be violated by a clamp that has gone wrong, and
 * the two bounds bugs property-testing found in `resolveMove` and
 * `resolveResize` — a negative ceiling, and a width that could cross the right
 * margin — are no longer expressible.
 *
 * What columns cannot carry is the *dp* floor: a third of a 412dp phone is a
 * legible compact card and a third of a 320dp one is less so, and a stored `h`
 * that was one bus row on the first is under a row's worth on the second.
 * `fitAll` is the answer, and it runs when `u` changes rather than every frame.
 *
 * ## One rule, not three sizes
 *
 * `span` picks the bus layout, `h` picks how many buses. One column stacks the
 * badge over the figure and shows them one across; two columns shows the same
 * compact bus two across; three columns is the detailed row from 1.2.4. That is
 * `tierFor` and `busCapacity` between them, and it is why the card no longer
 * measures itself to find out what it is: `span` is known before layout.
 *
 * ## Flowing cards
 *
 * `h === 0` — or no layout at all — means "this card has never been arranged".
 * It is full span, its height is whatever its content measures, and the canvas
 * stacks it beneath everything that *has* been arranged.
 *
 * That single rule is the whole migration story. A fresh install has no
 * layouts, so every card flows and the canvas reproduces 1.2.4's column exactly
 * — same width, same content-driven heights, same 8dp gap. It is also what a
 * newly saved stop gets, which is precisely "appends below the lowest card at
 * full width". A *fractional* layout, written during 1.2.5's development before
 * columns existed, is quantised to the nearest column on load: see
 * `migrateLayout`.
 *
 * A flowing card is allowed to grow when its arrivals land, because nothing is
 * ever placed below it. A *placed* card is not: growing into a neighbour would
 * cover another stop's minutes, so a placed card is a fixed box whose content
 * is chosen to fit. Picking any card up freezes every flowing card at the box
 * it already occupies, so the transition between the two worlds is invisible.
 */

import { spacing } from '../../theme';
import type { FavoriteStop, StopLayout } from '../../types';

/** A box in stored units. Structurally `StopLayout`; aliased so the geometry
 *  below reads as geometry rather than as persistence. */
export type Rect = StopLayout;

/* ── The numbers the design rests on ─────────────────────────── */

/**
 * The only grid.
 *
 * Three because of what a column has to hold, not because three is tidy: at
 * 412dp the canvas is 364dp and a column is 116dp, which is the narrowest box a
 * stop name, a line badge and an arrival figure can be stacked in and still
 * read. Four would be 85dp, which is under the badge's own 46dp plus its
 * padding.
 */
export const COLS = 3;

/**
 * Gap between cards, both axes.
 *
 * This is 1.2.4's `marginBottom: spacing.sm` on the card itself, moved out to
 * the canvas: a card must now fill exactly the box it is handed, and a margin
 * inside that box is height the geometry thinks it owns and the card does not.
 */
export const CARD_GAP_DP = spacing.sm;

/**
 * Magnet radius, vertical only.
 *
 * Small enough that a deliberate offset of a dozen points survives being
 * dragged past a neighbour, large enough that "nearly aligned" never survives a
 * drop — an 8dp misalignment between two cards side by side is exactly the kind
 * of thing the eye reads as broken rather than as intentional.
 *
 * There is no horizontal equivalent any more, and there is nothing left for one
 * to do: a card is always on a column, so its left and right edges are always
 * already aligned with every other card's.
 */
export const SNAP_DP = 8;

/* ── Card metrics ────────────────────────────────────────────────
   The rendered heights of the card's parts, in dp.

   They live here, in the file with no React in it, because the geometry cannot
   do its job without them: "how many buses fit in this box" and "how short may
   this box be" are the two questions the whole rework turns on, and both are
   arithmetic over these numbers. `FavoriteStopCard.styles` imports them for the
   matching `minHeight`s, so the card renders the rows the geometry counted
   rather than a second set that happens to be similar. A drift of a few points
   between the two is a card whose last bus is half visible. */

/** Card padding and border: 1dp border top and bottom, 10dp `paddingTop`, 4dp
 *  `paddingBottom`. Everything below is measured inside this. */
export const CARD_CHROME_H_DP = 16;
/** Header at three columns: a 16dp pin, a 15pt name and a 40dp edit-mode
 *  button. */
export const CARD_HEADER_H_DP = 32;
/** Header at one and two columns, where only the name is left. One line of it,
 *  at 13 or 15pt; every point of chrome height here comes straight out of the
 *  figure below it. */
export const CARD_HEADER_COMPACT_H_DP = 22;
/** One compact bus: a 22dp badge, a 4dp gap, a 26dp figure line and its 14dp
 *  caption. */
export const BUS_TILE_H_DP = 66;
/** One detailed bus row — 1.2.4's `lineRow`, unchanged, which is what "three
 *  columns is today's card" means in dp. */
export const BUS_ROW_H_DP = 62;
/** The controls footer where there is width for `HIT_SIZE` targets. */
export const CONTROLS_H_DP = 44;
/**
 * The controls footer at one column, and the one place this design knowingly
 * goes under the 44pt floor the rest of the app holds.
 *
 * Three targets have to share ~98dp of content, so each is ~32dp wide and this
 * is the matching height. It is a deliberate trade for having the schedule, the
 * alarm and the filter *reachable at every size* — a stop card that could only
 * offer them once it had been resized would make the smallest size a trap. Do
 * not "fix" it into a single overflow menu: that is one extra tap for every
 * user at every size, to buy back a floor that only the smallest card is under.
 */
export const CONTROLS_COMPACT_H_DP = 38;

/**
 * How short a card may be, per span, and why.
 *
 * The floor is whatever the span must show at all: chrome, one header, **one**
 * bus and the controls footer. Below that the card is not a smaller version of
 * itself, it is a card with something missing.
 *
 * The design estimated ~132dp; these are ~10dp taller because they count the
 * card's border, a header tall enough for one line of the name at its rendered
 * size, and the caption under the figure at the line height it actually gets.
 * The estimate was the intent, this is the arithmetic.
 */
export const MIN_H_COMPACT_DP =
  CARD_CHROME_H_DP + CARD_HEADER_COMPACT_H_DP + BUS_TILE_H_DP + CONTROLS_COMPACT_H_DP;
/** Three columns: the taller header, one 62dp detailed row, a full-size
 *  footer. */
export const MIN_H_WIDE_DP = CARD_CHROME_H_DP + CARD_HEADER_H_DP + BUS_ROW_H_DP + CONTROLS_H_DP;

/**
 * Height assumed for a flowing card that has not reported a measurement yet.
 *
 * Only the frame between mount and the first `onLayout` leans on it, and on
 * that frame every card is showing the cold-start placeholder: a 32dp header,
 * three 62dp skeleton rows and 14dp of card padding. So the number is that,
 * rather than an average of what cards eventually become — being right about
 * the one frame it is actually used on is worth more than being right on
 * average about frames where a real measurement exists.
 */
export const FALLBACK_CARD_H_DP = 232;

/**
 * How far a "move up / move down" accessibility action travels when there is no
 * alignment opportunity nearer than this. Small enough to be a nudge, large
 * enough that crossing a screen is a handful of activations rather than forty.
 *
 * There is no horizontal counterpart: "move left" is one column, exactly, and a
 * dp step across an axis with three positions would be a worse way of saying
 * the same thing.
 */
export const NUDGE_STEP_DP = 32;

/**
 * Slack for every vertical edge comparison.
 *
 * Two cards that share an edge must not count as overlapping. After a snap they
 * share it only to within floating-point error, so a strict comparison rejects
 * the position the magnet just produced and the card jumps somewhere else on
 * drop — the single most confusing thing this geometry could do. 1e-4 is ~0.04dp
 * on a 364dp canvas: below the point where anything is visible, far above the
 * error a couple of divisions accumulate.
 *
 * The horizontal axis needs none of this. Columns are integers, so "these two
 * cards touch" is `a.col + a.span === b.col` and not a question about tolerance.
 */
const EPS = 1e-4;

/* ── Columns to pixels ───────────────────────────────────────── */

/** One column, in canvas pixels. 116dp on a 412dp phone. */
export function colWidthPx(u: number): number {
  'worklet';
  return (u - CARD_GAP_DP * (COLS - 1)) / COLS;
}

/** Column to column, gap included — the distance a card travels when it moves
 *  one column sideways. */
export function colStridePx(u: number): number {
  'worklet';
  return colWidthPx(u) + CARD_GAP_DP;
}

/** A span in canvas pixels: the columns it covers *and* the gaps it swallows,
 *  which is why span 3 is the full 364dp canvas and not 348. */
export function spanWidthPx(span: number, u: number): number {
  'worklet';
  return span * colWidthPx(u) + (span - 1) * CARD_GAP_DP;
}

export function colLeftPx(col: number, u: number): number {
  'worklet';
  return col * colStridePx(u);
}

/** The legal column nearest a pixel offset — the whole of the horizontal drag.
 *  Clamped by `span`, so a card cannot be carried off the right edge by
 *  choosing a column its own width will not fit in. */
export function colAtPx(leftPx: number, span: number, u: number): number {
  'worklet';
  const stride = colStridePx(u);
  const max = COLS - span;
  const c = stride > 0 ? Math.round(leftPx / stride) : 0;
  return c < 0 ? 0 : c > max ? max : c;
}

/** The legal span nearest a pixel width, for the corner drag. Clamped by `col`,
 *  so widening cannot take a card past the last column. */
export function spanAtPx(widthPx: number, col: number, u: number): number {
  'worklet';
  const stride = colStridePx(u);
  const max = COLS - col;
  /* `+ CARD_GAP_DP` because a span swallows the gaps between its columns: two
     columns is 240dp, not 232, so dividing the raw width by the stride would
     read every span as slightly narrower than it is and make the midpoint
     between two spans land in the wrong one. */
  const s = stride > 0 ? Math.round((widthPx + CARD_GAP_DP) / stride) : 1;
  return s < 1 ? 1 : s > max ? max : s;
}

/* ── Size, from span and height ──────────────────────────────── */

/**
 * What a card of this span can afford to show.
 *
 * Read off `span` rather than measured from the rendered width, which removes a
 * whole measurement round-trip: the canvas knew the answer before it laid the
 * card out. Two values, not three, because there are two bus layouts — the
 * middle tier of the free-width design existed only to describe a width between
 * the two, and a width between two columns is not something this model can have.
 */
export type CardTier = 'compact' | 'detailed';

export function tierFor(span: number): CardTier {
  'worklet';
  return span >= COLS ? 'detailed' : 'compact';
}

/** How many buses sit across one row of a card of this span. Two columns is the
 *  same compact bus as one, twice — not a different bus. */
export function busesAcross(span: number): number {
  'worklet';
  return span === 2 ? 2 : 1;
}

/** Height of one bus, in the layout this span uses. */
export function busRowH(span: number): number {
  'worklet';
  return span >= COLS ? BUS_ROW_H_DP : BUS_TILE_H_DP;
}

/** Height of the header, and of the controls footer, for this span. */
function headerH(span: number): number {
  'worklet';
  return span >= COLS ? CARD_HEADER_H_DP : CARD_HEADER_COMPACT_H_DP;
}

function controlsH(span: number): number {
  'worklet';
  return span >= COLS ? CONTROLS_H_DP : CONTROLS_COMPACT_H_DP;
}

/** The floor for a span, in dp. */
export function minHDp(span: number): number {
  'worklet';
  return span >= COLS ? MIN_H_WIDE_DP : MIN_H_COMPACT_DP;
}

/** The same, in stored units. */
export function minHFor(span: number, u: number): number {
  'worklet';
  return u > 0 ? minHDp(span) / u : 0;
}

/**
 * How many buses a box of this height shows.
 *
 * The other half of "height picks how many buses". Never zero: a card at its
 * floor shows one bus (two at two columns, which is one *row* of two), because
 * a saved stop showing no arrivals at all is not a size, it is a bug.
 *
 * The half-point of slack absorbs the rounding in `h * u` — a box that was
 * committed as exactly three rows tall must not come back as 2.9999 of one.
 */
export function busCapacity(span: number, heightPx: number): number {
  'worklet';
  const avail = heightPx - CARD_CHROME_H_DP - headerH(span) - controlsH(span);
  const rows = Math.floor((avail + 0.5) / busRowH(span));
  return (rows < 1 ? 1 : rows) * busesAcross(span);
}

/* ── Rect predicates ─────────────────────────────────────────── */

export function overlaps(a: Rect, b: Rect): boolean {
  'worklet';
  return (
    a.col < b.col + b.span &&
    b.col < a.col + a.span &&
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

/** Coordinates worth aligning a card's top or bottom edge to: the canvas's top
 *  margin, and both horizontal edges of every other card. There is no bottom
 *  margin — the canvas grows. */
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
 * Snap the vertical axis. The horizontal one is columns and needs no magnet.
 *
 * Both of the card's own edges are tested against every candidate in the same
 * loop, so "align tops", "align bottoms" and "sit flush against" all fall out
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
 * Column and span, forced into the legal set, with the **size** winning.
 *
 * A card asked to sit at column 2 at two columns wide is moved to column 1
 * rather than narrowed, because that is what a move is: the card keeps the size
 * the user gave it and finds somewhere to be. `resolveResize` needs the opposite
 * precedence and says so where it clamps.
 *
 *  Non-finite input is answered with a full-span card rather than propagated:
 *  every comparison against a NaN is false, so an unguarded NaN would walk
 *  straight through the clamps below and become a card of NaN columns that
 *  neither overlaps anything nor can be seen. */
function legalCols(col: number, span: number): { col: number; span: number } {
  'worklet';
  let s = Number.isFinite(span) ? Math.round(span) : COLS;
  if (s < 1) s = 1;
  if (s > COLS) s = COLS;
  let c = Number.isFinite(col) ? Math.round(col) : 0;
  if (c < 0) c = 0;
  if (c > COLS - s) c = COLS - s;
  return { col: c, span: s };
}

/**
 * The nearest free position for a card that was dropped on top of something.
 *
 * Rejecting the drop and springing the card home is the obvious alternative and
 * it feels broken — the user aimed somewhere, and the app answered by undoing
 * the whole gesture. Sliding to the nearest gap reads as magnetism instead, and
 * it is never more than one card-width away from where they aimed.
 *
 * "Nearest" is exact rather than a heuristic walk. Horizontally there are at
 * most three columns the card can occupy, so all of them are tried; vertically
 * the only positions that can be the nearest free one are the desired `y` and
 * the two flush positions per blocker. That is ~3 × (2n + 2) candidates, which
 * at twenty saved stops is a couple of hundred rather than the ~1700 the
 * free-width version had to test. It cannot fail, because `bottom` — below
 * every card — is always a candidate.
 */
export function resolveMove(want: Rect, others: readonly Rect[]): Rect {
  'worklet';
  const { col, span } = legalCols(want.col, want.span);
  const y = want.y < 0 ? 0 : want.y;
  const h = want.h;
  const base = { col, span, y, h };
  if (!hitsAny(base, others)) return base;

  const ys: number[] = [y];
  const bottom = bottomOf(others);
  for (let i = 0; i < others.length; i++) {
    const b = others[i];
    const above = b.y - h;
    ys.push(above < 0 ? 0 : above);
    ys.push(b.y + b.h);
  }
  // Always available, always free. Without it a pathological arrangement could
  // leave the loop below with nothing to return.
  ys.push(bottom);

  const maxCol = COLS - span;
  let bestCol = col;
  let bestY = bottom;
  let bestD = Number.POSITIVE_INFINITY;
  for (let c = 0; c <= maxCol; c++) {
    for (let j = 0; j < ys.length; j++) {
      const cand = { col: c, span, y: ys[j], h };
      if (hitsAny(cand, others)) continue;
      /* One column counts as 1/COLS of the canvas against a `y` measured in the
         same unit. That is the column *stride* short by the gap it swallows —
         0.341 rather than 0.333 of the canvas — and the approximation is
         deliberate: this is a weight for comparing candidates, not a
         coordinate, and paying for the exact stride would mean threading `u`
         through a function that otherwise needs nothing but boxes. A 2%
         difference in the horizontal weight can only ever change which of two
         near-equidistant free positions wins, and both are legal. */
      const dx = (c - col) / COLS;
      const dy = cand.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        bestCol = c;
        bestY = cand.y;
      }
    }
  }
  return { col: bestCol, span, y: bestY, h };
}

/**
 * The same for a resize, which wants a different answer.
 *
 * A card whose corner is being dragged has a fixed top-left; teleporting it to
 * a free position elsewhere — which is what `resolveMove` would do — reads as
 * the card escaping the finger. So the box is shrunk against whatever it ran
 * into first, which is what the user would have done themselves a moment later.
 * Only when it cannot shrink far enough to clear the obstruction *and* stay
 * above the floor does it fall back to moving.
 *
 * Span is clamped against the blockers that share the card's rows, then height
 * against those that share its (now known) columns. Doing both in one pass
 * would need the answer to compute the answer; two passes in that order can
 * only ever over-shrink, never overlap, which is the safe direction.
 *
 * `minW` is gone from the signature and there is nothing to replace it with:
 * the minimum width is one column, and the clamp below cannot return less. `minH`
 * is gone too, and that one is a fix rather than a simplification — it was a
 * number every caller derived the same way from the span, and property-testing
 * found that passing the *old* span's floor while changing the span produces a
 * card below its own minimum that the next `fitAll` then has to rescue. The
 * canvas width is the only thing a caller can be trusted to know.
 */
export function resolveResize(want: Rect, others: readonly Rect[], u: number): Rect {
  'worklet';
  /* Position wins over size here, which is the opposite of `legalCols` and the
     whole difference between a resize and a move: the corner the user is *not*
     holding is the one that may give way, so a card at the last column asked for
     two columns is narrowed rather than slid left out from under the finger.
     Property-testing found this the wrong way round — `legalCols` prefers the
     size, which for a resize meant the card walked left as it was widened. */
  let col = Number.isFinite(want.col) ? Math.round(want.col) : 0;
  if (col < 0) col = 0;
  if (col > COLS - 1) col = COLS - 1;
  let span = Number.isFinite(want.span) ? Math.round(want.span) : 1;
  if (span < 1) span = 1;
  if (span > COLS - col) span = COLS - col;
  /* Derived after the span is known, because it is a property of the span: three
     columns has a taller floor than one, being a taller bus row. */
  const minH = minHFor(span, u);
  let h = want.h;

  for (let i = 0; i < others.length; i++) {
    const b = others[i];
    // Shares rows with the box as the user is dragging it.
    if (want.y + EPS < b.y + b.h && b.y + EPS < want.y + h) {
      const limit = b.col - col;
      if (limit > 0 && limit < span) span = limit;
    }
  }
  if (span < 1) span = 1;

  for (let i = 0; i < others.length; i++) {
    const b = others[i];
    if (col < b.col + b.span && b.col < col + span) {
      const limit = b.y - want.y;
      if (limit > 0 && limit < h) h = limit;
    }
  }
  if (h < minH) h = minH;

  /* Flooring the height can push the card back into the neighbour it was just
     shrunk clear of — at which point this is no longer a resize about a corner
     the user is holding still, the box has to move, and the move resolver is
     the only code that knows how to place it. */
  const box = { col, span, y: want.y, h };
  return hitsAny(box, others) ? resolveMove(box, others) : box;
}

/* ── Keyboard / screen-reader steps ──────────────────────────── */

/**
 * Move one column sideways — the accessibility path, and the reason the
 * resolvers above are not buried inside a gesture callback.
 *
 * One column, not a dp step: with three positions on the axis, a nudge measured
 * in points would be a worse way of saying the same thing, and would sometimes
 * say nothing at all. A step that runs off the edge, or into a card that cannot
 * be resolved around, comes back unchanged — which is what lets the caller
 * announce "blocked" rather than moving the card somewhere the user did not ask
 * for.
 */
export function nudgeCol(r: Rect, others: readonly Rect[], dir: 1 | -1): Rect {
  const want = { col: r.col + dir, span: r.span, y: r.y, h: r.h };
  if (want.col < 0 || want.col > COLS - r.span) return r;
  const got = resolveMove(want, others);
  // `resolveMove` may have had to move the card vertically to fit it in the new
  // column. That is a legal placement, but it is not a "move left", and a
  // screen-reader user who asked to go left and ended up somewhere else
  // vertically has lost track of the card.
  return got.col === want.col && Math.abs(got.y - r.y) < EPS ? got : r;
}

/**
 * Move one step vertically.
 *
 * A step is "as far as the next alignment opportunity, but no further than
 * `NUDGE_STEP_DP`". A fixed step alone would take forty activations to cross a
 * phone; jumping straight to the next neighbour's edge alone would fling the
 * card across the screen when the nearest neighbour happens to be far away.
 * Taking whichever is closer gives a predictable nudge that still lands exactly
 * on an edge whenever one is within reach.
 */
export function nudgeY(r: Rect, others: readonly Rect[], dir: 1 | -1, u: number): Rect {
  const edges = edgesY(others);
  const step = NUDGE_STEP_DP / u;

  let target = r.y + dir * step;
  for (const e of edges) {
    // Both of the card's edges again, so "sit flush under the card above" is
    // reachable as well as "align with it".
    for (const cand of [e, e - r.h]) {
      if (dir > 0 ? cand > r.y + EPS && cand < target : cand < r.y - EPS && cand > target) {
        target = cand;
      }
    }
  }

  return resolveMove({ col: r.col, span: r.span, y: target, h: r.h }, others);
}

/**
 * Widen or narrow by one column.
 *
 * Separate from the height step, unlike the free-width design's single
 * "grow" — there, the stored units tied `h` to `w` and scaling both together
 * kept the box the shape the user made it. Here the two axes answer different
 * questions: span picks the bus layout, height picks how many buses. A screen
 * reader user who cannot set them independently cannot reach half the sizes.
 *
 * Widening to three columns raises the height to that span's floor if it has to,
 * because the detailed row it switches to is taller than the compact tile it
 * replaces — otherwise "wider" would silently produce a card with no room for
 * a bus.
 */
export function spanStep(r: Rect, others: readonly Rect[], dir: 1 | -1, u: number): Rect {
  const span = r.span + dir;
  if (span < 1 || span > COLS - r.col) return r;
  const minH = minHFor(span, u);
  const h = r.h < minH ? minH : r.h;
  const got = resolveResize({ col: r.col, span, y: r.y, h }, others, u);
  /* An action names one axis and may only change that axis. `resolveResize` is
     free to give ground on either — it is answering a corner drag, where the
     user can see what happened and pull back — but "Wider" that came back
     shorter, or moved the card, is an answer to a question nobody asked, and
     the only feedback is a sentence read out afterwards. Declining instead lets
     the caller say "already as wide as it fits", which is true and actionable.
     Property-testing found this: growing a card whose neighbour sat lower in the
     next column silently cost it a bus. */
  return got.span === span && got.col === r.col
    && Math.abs(got.y - r.y) < EPS && got.h >= h - EPS
    ? got
    : r;
}

/**
 * Taller or shorter by exactly one bus — the unit the height now means.
 *
 * A partial grow is a good answer and is kept: stopping just under the card
 * below is "as tall as it fits", and asking again then reports exactly that. A
 * *narrower* or moved card is not, for the reason `spanStep` gives.
 */
export function heightStep(r: Rect, others: readonly Rect[], dir: 1 | -1, u: number): Rect {
  const minH = minHFor(r.span, u);
  const step = busRowH(r.span) / u;
  const h = r.h + dir * step;
  const got = resolveResize({ col: r.col, span: r.span, y: r.y, h: h < minH ? minH : h }, others, u);
  return got.span === r.span && got.col === r.col && Math.abs(got.y - r.y) < EPS ? got : r;
}

/* ── Migration ───────────────────────────────────────────────── */

/**
 * A stored placement, in whatever shape it was written in.
 *
 * Three inputs reach this: a `{col, span, y, h}` written by this release, a
 * `{x, y, w, h}` written during 1.2.5's development before columns existed, and
 * anything at all from an imported backup. The fractional shape quantises to
 * the nearest column — 0.5 of the canvas is a card one and a half columns wide,
 * and the nearest legal answer is two.
 *
 * Anything unrecognised is dropped rather than repaired, and dropping it is
 * harmless: a stop with no layout flows, full span, in order, exactly as a
 * newly saved one does. Repairing a NaN would instead put a card on the canvas
 * that cannot be seen, cannot be hit, and cannot be dragged back.
 *
 * Lives here rather than in storage because the legal set is this file's to
 * define; storage calls it on the way in from disk *and* from an import, so
 * there is no path by which a fractional layout reaches the canvas.
 */
export function migrateLayout(v: unknown): Rect | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number | null =>
    typeof x === 'number' && Number.isFinite(x) ? x : null;

  const y = num(o.y);
  const h = num(o.h);
  if (y == null || h == null || y < 0 || h < 0) return null;

  let col = num(o.col);
  let span = num(o.span);
  if (col == null || span == null) {
    const x = num(o.x);
    const w = num(o.w);
    if (x == null || w == null || x < 0 || w <= 0) return null;
    col = x * COLS;
    span = w * COLS;
  }
  return { ...legalCols(col, span), y, h };
}

/* ── Placement ───────────────────────────────────────────────── */

export interface PlacedCard {
  stopCode: string;
  /** Canvas pixels, ready for an absolutely positioned view. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Columns covered. The card reads this to decide how many buses go across. */
  span: number;
  tier: CardTier;
  /** How many buses fit, or null while the card is still allowed to show all of
   *  them because nothing is placed below it. */
  maxBuses: number | null;
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
      rect = { col: 0, span: COLS, y: flowTop, h: hPx / u };
      flowing = true;
      flowTop += (hPx + CARD_GAP_DP) / u;
    }
    const top = rect.y * u;
    const heightPx = rect.h * u;
    cards.push({
      stopCode: st.stopCode,
      left: colLeftPx(rect.col, u),
      top,
      width: spanWidthPx(rect.span, u),
      height: heightPx,
      span: rect.span,
      tier: tierFor(rect.span),
      /* A flowing card is uncapped on purpose: nothing is placed below it, so
         it is allowed to grow to whatever its arrivals come to — which is what
         makes a fresh install identical to 1.2.4 rather than a truncated
         version of it. */
      maxBuses: flowing ? null : busCapacity(rect.span, heightPx),
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
 * Columns carry an arrangement between devices and orientations on their own;
 * the one thing they cannot carry is the height floor, because one bus row is a
 * fixed number of dp and `h` is a fraction of the canvas width. So a width
 * change raises anything that fell under its span's floor and then re-resolves,
 * in saved order, so the cards that were there first keep their positions.
 *
 * It is also the one place a layout from outside is made legal: an imported
 * backup, or a record written by a future version, arrives through
 * `migrateLayout` and lands here to have its overlaps resolved.
 *
 * Returns only the boxes that actually changed, because the overwhelmingly
 * common case — the same device, same orientation — must not write anything.
 * That is also what keeps the effect that calls it from chasing its own tail:
 * the second pass over an already-fitted layout finds nothing to do.
 */
export function fitAll(stops: readonly FavoriteStop[], u: number): Map<string, Rect> {
  const changed = new Map<string, Rect>();
  if (u <= 0) return changed;
  const placed: Rect[] = [];

  for (const st of stops) {
    const l = st.layout;
    if (!l || l.h <= 0) continue;
    const { col, span } = legalCols(l.col, l.span);
    const minH = minHFor(span, u);
    const h = l.h < minH ? minH : l.h;
    const got = resolveMove({ col, span, y: l.y < 0 ? 0 : l.y, h }, placed);
    placed.push(got);
    if (
      got.col !== l.col ||
      got.span !== l.span ||
      Math.abs(got.y - l.y) > EPS ||
      Math.abs(got.h - l.h) > EPS
    ) {
      changed.set(st.stopCode, got);
    }
  }
  return changed;
}
