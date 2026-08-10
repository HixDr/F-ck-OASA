/**
 * The saved-stop canvas: columns, derived heights, magnets and overlap resolution.
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
 * `span` picks the bus layout and **the number of buses picks the height**. One
 * column stacks the badge over the figure and shows them one across; two columns
 * shows the same compact bus two across; three columns is the detailed row from
 * 1.2.4. That is `tierFor` and `hDpForBuses` between them, and it is why the card
 * no longer measures itself to find out what it is: both are known before layout.
 *
 * The two used to run the other way — the user dragged a corner and
 * `busCapacity` divided the box it produced into rows. That is now inverted. A
 * card is exactly as tall as the buses it shows, `h` is not a value anybody
 * chooses, and the corner drag sets width only.
 *
 * The reason is that a height the user set and a bus count the line filter set
 * are two ways of saying the same thing, and they disagreed. A card sized for
 * four buses whose stop was then filtered down to one showed one bus over three
 * rows of nothing; a card sized for one whose filter was cleared showed one bus
 * out of eight, with nothing on screen to say the other seven existed. Deriving
 * the height means neither state is expressible. `busCapacity` survives as the
 * *inverse* — how many buses a box was built for — which is the only question
 * left that needs it: see `busesFor`.
 *
 * ## Nothing may touch
 *
 * `CARD_GAP_DP` is the gap on both axes, and vertically it is part of what
 * *overlap* means: two cards that share a column and sit edge to edge count as
 * overlapping, so every resolver here pushes them apart. Horizontally the
 * columns already carry it — a card is a whole number of columns wide and the
 * gaps are cut out of the canvas before the columns are, so two cards side by
 * side cannot be closer than one gap however they are placed.
 *
 * ## Flowing cards
 *
 * `h === 0` — or no layout at all — means "this card has never been arranged".
 * It is full span, and the canvas stacks it beneath everything that *has* been
 * arranged.
 *
 * What it is no longer is content-sized: its height comes from its bus count
 * like every other card's, so there is nothing to measure, and no frame where
 * the stack is built out of guesses about cards that have not rendered yet.
 *
 * That single rule is still the whole migration story. A fresh install has no
 * layouts, so every card flows and the canvas reproduces 1.2.4's column — same
 * width, same 8dp gap, every line of every stop — with the heights computed from
 * the line count instead of measured off the rendered rows. It is also what a
 * newly saved stop gets, which is precisely "appends below the lowest card at
 * full width". A *fractional* layout, written during 1.2.5's development before
 * columns existed, is quantised to the nearest column on load: see
 * `migrateLayout`.
 *
 * ## Why `h` is still stored
 *
 * It is a **cache** of the derived height and never an independent value.
 * Dropping it from `StopLayout` is the obvious move and it is the wrong one: a
 * stop's bus count is only known once its routes have come back off the network,
 * and `fitAll` *writes*. A launch with no cached heights would lay every placed
 * card out at the fallback, resolve the overlaps that produces, and persist them
 * — so every cold start would quietly rearrange the canvas the user built,
 * before the first response landed. With the cache the pre-count frame is the
 * post-count frame, and the common launch writes nothing at all.
 *
 * Nothing trusts it any further than that. `placeAll` draws the height it
 * derives rather than the one it read, and `fitAll` overwrites the cache from the
 * count the moment there is one. A height stored by a build where the user chose
 * it is quantised *down* to the nearest whole number of buses, which can only
 * shrink a card and therefore cannot create an overlap that was not already
 * there.
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
   do its job without them: "how tall is a card showing this many buses" is now the
   question the whole canvas turns on, and it is arithmetic over these numbers.
   `FavoriteStopCard.styles` imports them for the matching `minHeight`s, so the card
   renders the rows the geometry counted rather than a second set that happens to be
   similar. A drift of a few points between the two is a card whose last bus is half
   visible. */

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
 * Bus count assumed for a stop whose lines have not arrived yet.
 *
 * This is the cold-start placeholder's own row count, and that is the whole
 * argument for it: the card draws `maxBuses` grey rows, so a box sized for this
 * many is the box the grey rows exactly fill, and the one that the real rows will
 * then replace in place. A dp constant used to live here instead, and it could
 * only ever be right at one span.
 *
 * It applies for as long as a stop has no count — a slow network, an offline
 * launch of a stop that was never cached, a route request that failed outright —
 * so it has to be a plausible card and not merely a placeholder. Three is the
 * count the old fallback assumed, for the same reason: it is about what a stop
 * serves.
 */
export const FALLBACK_BUSES = 3;

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
 * Two cards exactly `CARD_GAP_DP` apart must not count as overlapping. After a
 * snap they are that far apart only to within floating-point error, so a strict
 * comparison rejects the position the magnet just produced and the card jumps
 * somewhere else on drop — the single most confusing thing this geometry could
 * do. 1e-4 is ~0.04dp on a 364dp canvas: below the point where anything is
 * visible, far above the error a couple of divisions accumulate.
 *
 * The horizontal axis needs none of this. Columns are integers, so "these two
 * cards touch" is `a.col + a.span === b.col` and not a question about tolerance.
 */
const EPS = 1e-4;

/* ── Columns to pixels ───────────────────────────────────────── */

/**
 * The gap, in stored units.
 *
 * Every resolver below takes `u` for this and this alone. The gap is a fixed
 * number of dp — 8dp is 8dp on a 320dp phone and on a tablet — and `y` and `h`
 * are fractions of the canvas, so the one number cannot be a constant in the
 * unit the boxes are expressed in.
 */
export function gapFor(u: number): number {
  'worklet';
  return u > 0 ? CARD_GAP_DP / u : 0;
}

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

/* ── Size, from span and bus count ───────────────────────────── */

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

/**
 * Rows of buses a card showing this many of them needs.
 *
 * Never zero, and that is the floor: a card whose stop has every line filtered
 * out — or has not loaded any yet — is still chrome, a header, the controls
 * footer and *one* bus row. Below that it is not a smaller card, it is a card
 * with something missing, and a 76dp sliver on the canvas is not a saved stop.
 */
export function busRowsFor(span: number, buses: number): number {
  'worklet';
  const across = busesAcross(span);
  const rows = Math.ceil((buses > 0 ? buses : 0) / across);
  return rows < 1 ? 1 : rows;
}

/**
 * The height a card of this span must be to show this many buses, in dp.
 *
 * The one direction the size now runs in. Everything below and every caller
 * outside this file goes through it, so there is exactly one arithmetic for "how
 * tall is this card" and `FavoriteStopCard.styles` can import the parts it is
 * built from rather than restate them.
 *
 * The design estimated a ~132dp floor; `hDpForBuses(span, 0)` is ~10dp taller
 * because it counts the card's border, a header tall enough for one line of the
 * name at its rendered size, and the caption under the figure at the line height
 * it actually gets. The estimate was the intent, this is the arithmetic.
 */
export function hDpForBuses(span: number, buses: number): number {
  'worklet';
  return (
    CARD_CHROME_H_DP +
    headerH(span) +
    controlsH(span) +
    busRowsFor(span, buses) * busRowH(span)
  );
}

/** The same, in stored units. */
export function hForBuses(span: number, buses: number, u: number): number {
  'worklet';
  return u > 0 ? hDpForBuses(span, buses) / u : 0;
}

/**
 * How many buses a box of this height was built for — the inverse of
 * `hDpForBuses`, and all that is left of "height picks how many buses".
 *
 * Two things still need it. The card is handed it as a cap, so a stale or wrong
 * count can never make the card draw more rows than its box has (the cap is a
 * guard now rather than a policy: the box is derived from the count, so in the
 * ordinary case it admits everything). And a stored height written by a build
 * where the user chose it is read back through here, which is what turns a freely
 * chosen height into a whole number of buses.
 *
 * Never zero: a box always has room for the one row `busRowsFor` floors it at.
 * It rounds **down**, which is the safe direction — a card can only come back
 * from an old install shorter than it was stored, never taller, so quantising
 * cannot push it into a neighbour.
 *
 * The half-point of slack absorbs the rounding in `h * u`: a box committed as
 * exactly three rows tall must not come back as 2.9999 of one.
 */
export function busCapacity(span: number, heightPx: number): number {
  'worklet';
  const avail = heightPx - CARD_CHROME_H_DP - headerH(span) - controlsH(span);
  const rows = Math.floor((avail + 0.5) / busRowH(span));
  return (rows < 1 ? 1 : rows) * busesAcross(span);
}

/**
 * How many buses a card is sized for, from whatever is known about it.
 *
 * Three cases, in the order they are trusted. A count reported by the card wins,
 * because it is the live answer to "how many lines is this stop showing" and the
 * whole design says the height follows it. Failing that, a card that already has
 * a box is read back through `busCapacity`, so a launch that has not heard from
 * the network yet reproduces exactly the canvas the user last saw — and a
 * height chosen by hand in an older build is quantised on the way through.
 * Failing both, the card has never been arranged and has no box either, and
 * `FALLBACK_BUSES` is the guess the placeholder is drawn at.
 *
 * `span` and `h` must be the ones the box was *stored* at. Reading a box's count
 * off a different span asks a compact tile how many detailed rows it holds, and
 * the answer is out by a factor of two.
 */
export function busesFor(span: number, h: number, reported: number | null, u: number): number {
  'worklet';
  if (reported != null && Number.isFinite(reported)) return reported > 0 ? Math.round(reported) : 0;
  if (h > 0) return busCapacity(span, h * u);
  return FALLBACK_BUSES;
}

/* ── Rect predicates ─────────────────────────────────────────── */

/**
 * Do these two boxes conflict, `gap` being the vertical clearance they owe each
 * other in stored units?
 *
 * The gap is inside the predicate rather than applied by the callers, because
 * "overlap" is the one thing every resolver here asks about and a clearance that
 * only some of them enforced would be a rule with holes in it — a drop that
 * refused to touch, a nudge that did, and a re-fit that then had to tidy up after
 * whichever ran last.
 *
 * Only the vertical axis takes it. Two cards in different columns are already a
 * gap apart by construction; two cards in the *same* columns had nothing keeping
 * them apart at all, which is what this fixes. Passing `gap = 0` therefore asks
 * the old question — whether the boxes literally intersect — and nothing in this
 * file does, so `resolveMove` and friends cannot silently lose the clearance by
 * forgetting to pass it.
 */
export function overlaps(a: Rect, b: Rect, gap: number): boolean {
  'worklet';
  return (
    a.col < b.col + b.span &&
    b.col < a.col + a.span &&
    a.y + EPS < b.y + b.h + gap &&
    b.y + EPS < a.y + a.h + gap
  );
}

function hitsAny(r: Rect, others: readonly Rect[], gap: number): boolean {
  'worklet';
  for (let i = 0; i < others.length; i++) {
    if (overlaps(r, others[i], gap)) return true;
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

/**
 * The horizontal edges on the canvas that are worth landing near: the canvas's
 * top margin, and both edges of every other card. There is no bottom margin —
 * the canvas grows.
 *
 * Kept as two lists rather than one, because a coordinate now means something
 * different depending on which edge of the card it belongs to. A neighbour's
 * *bottom* is where this card's bottom may align (a card in another column) and
 * also what its top may come to rest one gap below (a card in the same one), and
 * those are two different landing positions from the same number. Flattening
 * them into a single list of candidates that every edge is tested against was the
 * shape before the gap existed, and it now produces positions that are 8dp off a
 * neighbour's edge for no reason anybody could see.
 */
export interface EdgesY {
  /** Every card's top edge, and the canvas's. */
  tops: number[];
  /** Every card's bottom edge. */
  bottoms: number[];
}

export function edgesY(others: readonly Rect[]): EdgesY {
  'worklet';
  const tops: number[] = [0];
  const bottoms: number[] = [];
  for (let i = 0; i < others.length; i++) {
    const b = others[i];
    tops.push(b.y);
    bottoms.push(b.y + b.h);
  }
  return { tops, bottoms };
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
 * Every edge on the canvas offers a card *four* positions, and they are written
 * out rather than folded into one comparison because they are four different
 * intentions: align tops with it, align bottoms with it, rest against it from
 * above, rest against it from below. The last two are the ones the gap changed —
 * "flush" is no longer a position a card can occupy, so resting against a
 * neighbour means landing one gap clear of it.
 *
 * The distance is always measured from where the card's *top* would end up, so
 * all four are comparable and the nearest wins outright. `guide` is the edge that
 * attracted it and not the position it produced: for the two resting cases those
 * differ by exactly the gap, and a hairline drawn 8dp off every card's edge would
 * be a guide that lines up with nothing.
 *
 * The magnet only ever *offers* a position: `tol` is a radius, and pulling
 * beyond it simply stops matching. Nothing here can refuse a placement.
 */
export function snapAxis(
  origin: number,
  size: number,
  edges: EdgesY,
  gap: number,
  tol: number,
): Snap {
  'worklet';
  let v = origin;
  let best = tol;
  let guide = -1;
  for (let i = 0; i < edges.tops.length; i++) {
    const e = edges.tops[i];
    // Tops aligned.
    let d = Math.abs(origin - e);
    if (d < best) {
      best = d;
      v = e;
      guide = e;
    }
    // Sitting above it, clear of it.
    const above = e - gap - size;
    d = Math.abs(origin - above);
    if (d < best) {
      best = d;
      v = above;
      guide = e;
    }
  }
  for (let i = 0; i < edges.bottoms.length; i++) {
    const e = edges.bottoms[i];
    // Bottoms aligned.
    let d = Math.abs(origin - (e - size));
    if (d < best) {
      best = d;
      v = e - size;
      guide = e;
    }
    // Sitting below it, clear of it.
    const below = e + gap;
    d = Math.abs(origin - below);
    if (d < best) {
      best = d;
      v = below;
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
 * the two resting positions per blocker. That is ~3 × (2n + 2) candidates, which
 * at twenty saved stops is a couple of hundred rather than the ~1700 the
 * free-width version had to test. It cannot fail, because one gap below every
 * card is always a candidate.
 *
 * `u` is here for the gap and nothing else. Two cards may not touch, so the
 * resting positions are one gap clear of a blocker rather than flush against it,
 * and the fallback below every card has to clear the lowest one by the same
 * amount — otherwise the position this function guarantees is free would be the
 * one position it is not allowed to use.
 */
export function resolveMove(want: Rect, others: readonly Rect[], u: number): Rect {
  'worklet';
  const gap = gapFor(u);
  const { col, span } = legalCols(want.col, want.span);
  /* Guarded the way `legalCols` guards the columns, and for the same reason.
     `want.y < 0 ? 0 : want.y` was the whole of this, and it lets a NaN through:
     every comparison against a NaN is false, so the clamp declines to fire, every
     overlap test declines to fire, and the card is placed at a coordinate that
     cannot be seen, cannot be hit and cannot be dragged back. Property-testing
     found it — the same class of bug the column clamp was already written for, on
     the axis nobody had checked. A non-finite height gets the floor rather than
     zero, because a card of no height is a card the user cannot pick up again. */
  const y = Number.isFinite(want.y) && want.y > 0 ? want.y : 0;
  const h = Number.isFinite(want.h) && want.h > 0 ? want.h : hForBuses(span, 0, u);
  const base = { col, span, y, h };
  if (!hitsAny(base, others, gap)) return base;

  const ys: number[] = [y];
  const bottom = bottomOf(others) + gap;
  for (let i = 0; i < others.length; i++) {
    const b = others[i];
    const above = b.y - gap - h;
    ys.push(above < 0 ? 0 : above);
    ys.push(b.y + b.h + gap);
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
      if (hitsAny(cand, others, gap)) continue;
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
 * What a resize is allowed to ask for: a position, and a number of columns.
 *
 * Deliberately not a `Rect`. A height here would be a field every caller had to
 * fill in with a value the resolver then discarded, and one of them would
 * eventually fill it in with something the user had dragged.
 */
export interface SizeWant {
  col: number;
  span: number;
  y: number;
}

/**
 * What a card asked to be a given number of columns wide actually becomes.
 *
 * A resize has no height in it any more, which is why it takes a bus count
 * instead of a box: the height is `hForBuses` of whatever span this settles on,
 * and the caller cannot pre-compute it because narrowing a card *raises* it — one
 * column shows one compact tile per row where two columns show two, and three
 * switches to the detailed row and a taller header.
 *
 * That is also what makes the old two-pass shrink unusable. It clamped the span
 * against the blockers sharing the card's rows and then the height against those
 * sharing its columns, which needed the height to be known before the span and
 * the span before the height. So the candidates are tried outright instead:
 * widest first, at the position the user is holding, and the first one whose
 * derived box is free wins. There are at most three.
 *
 * The card keeps its top-left, which is the whole difference between a resize and
 * a move. Teleporting it to a free position elsewhere — what `resolveMove` would
 * do — reads as the card escaping the finger, and property-testing found exactly
 * that when `legalCols` was used here: it prefers the size, so a card at the last
 * column walked left as it was widened. Only when *no* width fits at that
 * position does the box move, and then the move resolver is the only code that
 * knows how to place it.
 */
export function resolveResize(
  want: SizeWant,
  others: readonly Rect[],
  buses: number,
  u: number,
): Rect {
  'worklet';
  const gap = gapFor(u);
  /* Position wins over size, which is the opposite of `legalCols`: the corner the
     user is *not* holding is the one that may give way, so a card at the last
     column asked for two columns is narrowed rather than slid left. */
  let col = Number.isFinite(want.col) ? Math.round(want.col) : 0;
  if (col < 0) col = 0;
  if (col > COLS - 1) col = COLS - 1;
  let span = Number.isFinite(want.span) ? Math.round(want.span) : 1;
  if (span < 1) span = 1;
  if (span > COLS - col) span = COLS - col;
  const y = Number.isFinite(want.y) ? (want.y < 0 ? 0 : want.y) : 0;

  for (let s = span; s >= 1; s--) {
    const box = { col, span: s, y, h: hForBuses(s, buses, u) };
    if (!hitsAny(box, others, gap)) return box;
  }
  return resolveMove({ col, span, y, h: hForBuses(span, buses, u) }, others, u);
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
export function nudgeCol(r: Rect, others: readonly Rect[], dir: 1 | -1, u: number): Rect {
  const want = { col: r.col + dir, span: r.span, y: r.y, h: r.h };
  if (want.col < 0 || want.col > COLS - r.span) return r;
  const got = resolveMove(want, others, u);
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
  const gap = gapFor(u);
  const edges = edgesY(others);
  const step = NUDGE_STEP_DP / u;

  let target = r.y + dir * step;
  const consider = (cand: number) => {
    if (dir > 0 ? cand > r.y + EPS && cand < target : cand < r.y - EPS && cand > target) {
      target = cand;
    }
  };
  /* The same four landing positions `snapAxis` offers a drag, so a step can reach
     everything a gesture can: align with a neighbour's top or bottom, or come to
     rest one gap above or below it. Resting flush is not among them any more, and
     a step that offered it would be a step the resolver then had to undo. */
  for (const e of edges.tops) {
    consider(e);
    consider(e - gap - r.h);
  }
  for (const e of edges.bottoms) {
    consider(e - r.h);
    consider(e + gap);
  }

  return resolveMove({ col: r.col, span: r.span, y: target, h: r.h }, others, u);
}

/**
 * Widen or narrow by one column — the only size step there is.
 *
 * There used to be a `heightStep` beside this, and its removal is the point
 * rather than a saving. Height is what the stop's own line filter decides, so
 * "Taller" was an action that either fought the data or lied about it; a screen
 * reader user changing how tall a card is does it by choosing which lines it
 * shows, in the sheet the filter button opens, which is the same control everyone
 * else uses.
 *
 * The height still moves when this runs, and it has to: one column shows one
 * compact tile per row, two show two, and three switches to the taller detailed
 * row. Same buses, different shape — which is why the announcement names both.
 */
export function spanStep(
  r: Rect,
  others: readonly Rect[],
  dir: 1 | -1,
  buses: number,
  u: number,
): Rect {
  const span = r.span + dir;
  if (span < 1 || span > COLS - r.col) return r;
  const got = resolveResize({ col: r.col, span, y: r.y }, others, buses, u);
  /* An action names one thing and may only change that thing. `resolveResize` is
     free to narrow or move — it is answering a corner drag, where the user can see
     what happened and pull back — but "Wider" that came back narrower, or moved
     the card, is an answer to a question nobody asked, and the only feedback is a
     sentence read out afterwards. Declining instead lets the caller say "already
     as wide as it fits", which is true and actionable. Property-testing found
     this: growing a card whose neighbour sat lower in the next column silently
     cost it a bus. */
  return got.span === span && got.col === r.col && Math.abs(got.y - r.y) < EPS ? got : r;
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
 *
 * ## What it deliberately does not do to `h`
 *
 * A height stored by a build where the user chose it freely is *not* a legal
 * height any more, and this is not the place that can fix it: `h` is a fraction
 * of the canvas's width, so how many buses it stands for is not knowable without
 * `u`, and storage has no canvas. It cannot be dropped either — zeroing it means
 * "never arranged", which would throw away the whole arrangement of every install
 * that has one.
 *
 * So it passes through as a *cache*, which is all `h` is now (see the module
 * comment), and `fitAll` — the one caller that knows `u` — quantises it to a whole
 * number of buses on the first pass over the canvas. That pass can only ever
 * shorten a card, because `busCapacity` rounds down, so nothing it does can put a
 * card into a neighbour; and it runs before any of these boxes can be dragged,
 * because Home re-fits on the effect that follows the render they first appear in.
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
  /**
   * How many buses fit in this box.
   *
   * A guard rather than a policy now that the box is derived from the count: in
   * the ordinary case it admits every line the stop is showing, and what it exists
   * for is the frame between a filter being toggled and the canvas hearing about
   * it — where the card would otherwise draw a row its box has no space for.
   */
  maxBuses: number;
  /** Never arranged: stacked in saved order rather than placed. See the module
   *  comment. */
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
 * Heights are *derived* here, from `counts`, rather than read off the stored
 * layout: the stored one is a cache, and drawing it would mean a card kept the
 * height it had before a line was toggled until `fitAll` had written the new one
 * — a frame of the wrong size on every filter change, and on every launch of an
 * install upgrading from a build where the height was chosen by hand.
 *
 * It does not resolve collisions, which is the other half of the same split.
 * Deriving a height can grow a card into its neighbour, and the only code allowed
 * to answer that is `fitAll`, because the answer has to be persisted: a render
 * pass that quietly moved cards would move them again, differently, on the next
 * render.
 *
 * Order is preserved: the gesture code indexes into this array and into the
 * stops array interchangeably.
 */
export function placeAll(
  stops: readonly FavoriteStop[],
  counts: ReadonlyMap<string, number>,
  u: number,
): { cards: PlacedCard[]; height: number } {
  if (u <= 0) return { cards: [], height: 0 };
  const gap = gapFor(u);

  /** The box each stop wants, before anything is stacked below it. */
  const boxes: (Rect | null)[] = [];
  let flowTop = 0;
  for (const st of stops) {
    const l = st.layout;
    if (!l || l.h <= 0) {
      boxes.push(null);
      continue;
    }
    const reported = counts.get(st.stopCode);
    const h = hForBuses(l.span, busesFor(l.span, l.h, reported ?? null, u), u);
    boxes.push({ col: l.col, span: l.span, y: l.y, h });
    const b = l.y + h;
    if (b > flowTop) flowTop = b;
  }
  if (flowTop > 0) flowTop += gap;

  const cards: PlacedCard[] = [];
  let height = 0;
  stops.forEach((st, i) => {
    let rect = boxes[i];
    const flowing = rect == null;
    if (rect == null) {
      const reported = counts.get(st.stopCode);
      /* Full span, and its height from its own count — with no stored box there
         is nothing to read a count off, so a stop whose lines have not arrived
         gets `FALLBACK_BUSES`. Stacked with the same gap it will keep once it is
         frozen, so freezing changes nothing on screen. */
      const h = hForBuses(COLS, busesFor(COLS, 0, reported ?? null, u), u);
      rect = { col: 0, span: COLS, y: flowTop, h };
      flowTop += h + gap;
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
      maxBuses: busCapacity(rect.span, heightPx),
      flowing,
      rect,
    });
    if (top + heightPx > height) height = top + heightPx;
  });
  return { cards, height };
}

/**
 * Bring every placed card back to a height that matches its bus count, and to a
 * position where nothing overlaps.
 *
 * This is the one writer, and everything that can change a card's size ends up
 * here: a line toggled in the filter sheet, a stop's routes arriving off the
 * network, a rotation or a different phone (one bus row is a fixed number of dp
 * and `h` is a fraction of the canvas width, so the same `h` is a different number
 * of buses at a different width), an imported backup, a record written by a
 * future version, and a height chosen by hand in a build before this one.
 *
 * **Growing is the dangerous direction**, and it is handled by re-resolving the
 * whole canvas in saved order rather than by nudging the card that grew. A card
 * given a taller box can overlap the one beneath it, and the answer has to be the
 * one a drag would reach — otherwise there are two collision rules and only one of
 * them is ever tested. So each card in turn is placed with `resolveMove` against
 * the ones already placed: the cards earlier in the saved order keep where they
 * are, and a card that no longer fits under a grown neighbour slides to the
 * nearest free position exactly as a dropped card does. Shrinking needs none of
 * this and gets it anyway, harmlessly: a shorter box cannot fail to fit.
 *
 * The cost of that rule, stated because it is visible: the card that moves is the
 * one *later* in the saved order, which is not always the one that grew. Cards
 * flow in saved order when they have never been arranged, so in the common case
 * the grown card is above the ones that give way; a canvas whose arrangement runs
 * against its saved order can instead see the grown card itself move. Priority
 * belongs to a stable order rather than to whichever card happened to change,
 * because the alternative — the toggled card wins — makes the outcome depend on
 * which card the user last touched, and the same canvas would settle differently
 * depending on the order they toggled things.
 *
 * Returns only the boxes that actually changed, because the overwhelmingly
 * common case — same device, same orientation, nothing toggled — must not write
 * anything. That is also what keeps the effect that calls it from chasing its own
 * tail: the second pass over an already-fitted layout finds nothing to do, which
 * holds because the height rule is a function of the count and the count does not
 * depend on the box.
 */
export function fitAll(
  stops: readonly FavoriteStop[],
  counts: ReadonlyMap<string, number>,
  u: number,
): Map<string, Rect> {
  const changed = new Map<string, Rect>();
  if (u <= 0) return changed;
  const placed: Rect[] = [];

  for (const st of stops) {
    const l = st.layout;
    if (!l || l.h <= 0) continue;
    const reported = counts.get(st.stopCode);
    /* The count is read off the *stored* span, because that is the span the stored
       height was written at. `legalCols` may then change the span — only for a
       record from outside, since everything this app writes is already legal — and
       the height follows the span it ends up at. */
    const buses = busesFor(l.span, l.h, reported ?? null, u);
    const { col, span } = legalCols(l.col, l.span);
    const h = hForBuses(span, buses, u);
    const got = resolveMove({ col, span, y: l.y < 0 ? 0 : l.y, h }, placed, u);
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
