import { StyleSheet } from 'react-native';
import { colors, spacing, radius, font, HIT_SIZE } from '../theme';
/* The rendered heights of the card's parts are the canvas's numbers, not this
   file's. `busCapacity` divides a box by them to decide how many buses this card
   may show, so a `minHeight` here that had drifted a few points from the number
   it divided by would produce a card whose last bus is half visible — with
   nothing in either file looking wrong. Importing them is what makes the two
   sides the same arithmetic rather than two similar arithmetics. Runtime, unlike
   the card's type-only `CardTier` import: a number cannot be erased. */
import {
  BUS_ROW_H_DP,
  BUS_TILE_H_DP,
  CARD_HEADER_COMPACT_H_DP,
  CARD_HEADER_H_DP,
  CONTROLS_COMPACT_H_DP,
  CONTROLS_H_DP,
} from '../features/home/layout';

/**
 * The compact tier's arrival figure, in points.
 *
 * Every other tier shows 34. The design's first principle is that the arrival
 * number survives as long as possible — content is dropped around it before it
 * is shrunk — and this is the single place that principle is deliberately
 * traded away for density, so that three cards fit across a phone. At the ~98dp
 * of content one column leaves, a 44dp badge and a 56dp block come to 100 and so
 * cannot sit side by side at all — the two dp are why `cardCompact` narrowing the
 * padding does not undo this — so they stack, and a stacked 34pt figure with its
 * caption is taller than the box a card that narrow is likely to be given.
 *
 * Named once because the `lineHeight` below it must not be allowed to drift
 * from the size above it: a `lineHeight` smaller than the glyphs clips the
 * digits' descenders, and a larger one silently costs height the box does not
 * have.
 */
const COMPACT_FIGURE_PT = 24;

export const s = StyleSheet.create({
  /** No `marginBottom` here any more, and nothing may put one back. Home places
   *  this card at an absolute position now and hands it an exact box; the gap
   *  between cards is the canvas's (`CARD_GAP_DP`), and a margin inside the box
   *  is height the geometry believes it owns and the card does not. */
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm + 2,
    paddingBottom: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  /**
   * Narrower side padding at one and two columns, and *only* the side padding.
   *
   * 16dp a side is 32 of a 116dp column — 28% of the card spent on nothing — and
   * the three footer controls need every point of what is left: at `spacing.md`
   * they are ~27dp each, at `spacing.sm` ~32dp. Neither reaches the 44pt floor,
   * so this does not buy a compliant target; it buys back the five points that
   * decide whether three icons read as three controls or as a smudge.
   *
   * The vertical padding is deliberately untouched. `CARD_CHROME_H_DP` is the
   * 2dp border plus this card's 10dp top and 4dp bottom, and `busCapacity`
   * subtracts it before dividing the rest into bus rows — so a point taken off
   * the vertical here would not shrink the card, it would make the geometry
   * promise a bus the card has no room to draw.
   */
  cardCompact: {
    paddingHorizontal: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: CARD_HEADER_H_DP,
  },
  /** `header`'s 32 is sized for a 16dp pin, a 15pt name and a 40dp button. At
   *  `compact` only the name is left, and every point of chrome height comes
   *  straight out of the figure below it.
   *
   *  This was 24 against a geometry that counted 22, which is the drift the
   *  imported constants exist to prevent: `busCapacity` handed a two-bus compact
   *  card a box 2dp shorter than two 66dp tiles, so the second bus was clipped by
   *  a hair at every size above the floor. The number was never wrong in one file
   *  — it was two numbers. */
  headerCompact: {
    minHeight: CARD_HEADER_COMPACT_H_DP,
  },
  stopName: {
    flex: 1,
    color: colors.text,
    fontSize: font.size.body,
    fontWeight: '600',
  },
  /** One step down at `compact`. The name is truncated to a line at any tier,
   *  so the smaller size is not about fitting the whole name — it is about how
   *  many characters of it survive the truncation in ~98dp. */
  stopNameCompact: {
    fontSize: font.size.label,
  },
  /** Header icon buttons — remove and reorder, which is all that is left up here
   *  now the line filter has moved to the controls footer. 40 rather than 36:
   *  the shared Pressable tops every target up to HIT_SIZE with hitSlop, and at
   *  36 in a 4pt-gap row that slop would overlap the neighbour — which is
   *  exactly what once made the bell and the timetable button steal each other's
   *  taps. At 40 the slop is 2 a side and lands precisely in the gap. */
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /**
   * The remove button at one and two columns, sized to the header the geometry
   * counted rather than to the button.
   *
   * A 40dp control in a row `busCapacity` costed at 22 grows the header by 18dp,
   * and in a fixed box that 18dp does not come from the card — it comes out of
   * the bus. Centred, it clips half the badge and all of the caption, so turning
   * on edit mode would visibly damage every small card on the screen. At exactly
   * the header's height it costs nothing at all, and the shared Pressable's
   * hitSlop still tops the target up to the full 44: it is the only control in
   * this row, so there is no neighbour for the slop to overlap.
   */
  headerBtnCompact: {
    width: CARD_HEADER_COMPACT_H_DP,
    height: CARD_HEADER_COMPACT_H_DP,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ── Arrival row ───────────────────────────────────────────── */
  /**
   * The scroll region the arrival rows get once the card has a fixed height.
   *
   * `flex: 1` rather than a natural height: a scroll view that sized itself to
   * its content is exactly the overflow the box exists to prevent, and the
   * clipping would eat what sits below it — the controls footer, which is the
   * only way to reach the schedule, the alarm and the filter, and the notice that
   * says the numbers above are not live — instead of the rows the user can
   * scroll to. Taking the leftover height pins both to the bottom edge and gives
   * the rows everything else.
   *
   * It stays even though the bus count is now chosen to fit exactly: the count
   * is arithmetic over dp constants, and a system font scale of 1.3 makes every
   * one of those constants an underestimate. Scrolling one row is a far better
   * failure than clipping it.
   */
  bodyScroll: {
    flex: 1,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: BUS_ROW_H_DP,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  /** Cold-start placeholder. Same metrics as `lineRow` so the real rows land
   *  where the grey ones were rather than shoving the card taller. */
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: BUS_ROW_H_DP,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  skeletonGrow: {
    flex: 1,
  },
  lineBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    marginRight: spacing.sm,
    minWidth: 46,
    alignItems: 'center',
  },
  /** Color comes from `onAccent(primaryColor)` inline: hardcoded white lands
   *  near 2:1 on the yellow and green accents the picker offers, on the one
   *  label that identifies the bus. */
  lineBadgeText: {
    ...font.num,
    color: colors.text,
    fontSize: font.size.label,
    fontWeight: '800',
  },
  lineMain: {
    flex: 1,
    marginRight: spacing.sm,
    gap: spacing.xxs,
  },
  lineDescr: {
    color: colors.text,
    fontSize: font.size.label,
  },
  /** Timetable affordance. Lives under the description, far from the bell. It
   *  opens a sheet now rather than growing the row, so it has no expanded state
   *  to style — but it still *reads* the timetable, printing the next departure
   *  time, which is why it is a pill with text in it and not a third icon. */
  schedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    minHeight: 26,
    paddingHorizontal: spacing.xs + 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  schedPillText: {
    ...font.num,
    color: colors.textMuted,
    fontSize: font.size.micro,
    fontWeight: '600',
  },

  /* ── The number the app exists to show ─────────────────────── */
  /**
   * `minWidth` is a layout reservation, not decoration. Do not remove it to
   * make the block "shrink to fit" a single digit.
   *
   * The block paints nothing, so the reservation is invisible; what would be
   * visible is its absence. `lineMain` next to it is `flex: 1`, so every point
   * the block gives up goes straight to a `numberOfLines={1}` destination label
   * — let the block hug its digits and a truncated label gains and loses a
   * character each time an arrival ticks 12 → 9, ~20dp of swing, on a list that
   * re-renders every poll. The `min` caption re-centres under the number at the
   * same moment, and the number itself slides half that distance, because the
   * bell after it pins the block's right edge but not its left.
   *
   * 56 is the two-digit state at the figure cap (34pt × 1.3, tabular ≈ 53dp),
   * so the one thing the poll can actually change stays inside the floor and
   * the row's geometry is frozen for the whole countdown. `now` is the widest
   * state and does cross the floor by a couple of points near the top of the
   * scale — that is one reflow per arrival instead of one per poll, which is
   * the trade the floor exists to make.
   *
   * If this block is ever given a fill, put it on the `Text`, never here:
   * painting the container paints the reservation, which is exactly the "7 in a
   * box sized for 17" that a fixed width looks like once it has a colour.
   */
  arrivalBlock: {
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrivalMin: {
    ...font.num,
    fontSize: font.size.figure,
    lineHeight: font.size.figure + 2,
    fontWeight: '800',
  },
  arrivalUnit: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  arrivalNow: {
    fontSize: font.size.xl,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  /** Live data older than a poll cycle — dim it rather than lie. */
  stale: {
    opacity: 0.45,
  },
  noArrival: {
    color: colors.textMuted,
    fontSize: font.size.xl,
    fontWeight: '700',
  },
  bellBtn: {
    width: HIT_SIZE,
    height: HIT_SIZE,
    marginLeft: spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ── Compact tier ──────────────────────────────────────────── */
  /**
   * Where a compact card's buses go: a wrapping row, filling the box the canvas
   * handed the card.
   *
   * A grid rather than a column because the number across is the one thing
   * `span` decides — one tile per line at a single column, two at a double — and
   * `flexWrap` is what lets the same two styles express both. Nothing here knows
   * the span; the tiles carry their own width.
   *
   * `alignContent` centres the rows in whatever slack the box has, and
   * `justifyContent` centres a half-empty last row (three visible lines in a
   * four-slot grid), so a card is never visibly bottom-heavy. Centred rather
   * than top-aligned for the reason the tier exists: the card clips what it
   * cannot fit, and centring spends the clipping on the badge's top edge and the
   * caption's bottom edge before the digits.
   *
   * No vertical padding, deliberately. The card's own padding already keeps the
   * stack off the border, and padding here is height subtracted from the box
   * before the figures are laid out — at the bottom of the size range that is
   * the difference between a legible number and a clipped one.
   *
   * `flex: 1` is inert when the card has no fixed height (a card the user has
   * never arranged is full width and therefore never compact), so this style is
   * safe on both paths.
   */
  busGrid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'center',
    justifyContent: 'center',
  },
  /**
   * One compact bus, at one column: the full width of the grid.
   *
   * `minHeight` is `BUS_TILE_H_DP` and it is the same 66 the geometry divided
   * the box by to decide how many of these to ask for. A tile that rendered
   * taller than the number it was counted with does not overflow the card — the
   * card clips — it silently halves the last bus, which is a card that looks
   * finished and is not. That is why the height is imported and not typed here,
   * and why it is a floor on the tile rather than a fixed height on the grid:
   * at a large font scale the stack genuinely needs more, and a floor lets the
   * last row scroll off rather than every row shrink.
   *
   * Two complete styles instead of one plus a width override, because the tile
   * style is handed to a `React.memo`'d component: a composed array would be a
   * fresh identity on every arrival poll and would defeat the memo on the one
   * subtree that re-renders most.
   */
  busTile: {
    width: '100%',
    minHeight: BUS_TILE_H_DP,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The same tile at two columns. Half the grid, so two sit across; still the
   *  same bus, which is the whole of what "two columns" means. */
  busTileHalf: {
    width: '50%',
    minHeight: BUS_TILE_H_DP,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The compact card's single centred message — loading, failed, or nothing to
   *  show. Not a bus tile: these have no count and no pairing, they are one
   *  thing in the middle of the body. */
  compactBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** `lineBadge` is built for a row and carries a right margin. Stacked, that
   *  margin offsets the badge from the figure it labels by 8dp — visible at
   *  this size, and the one thing a centred stack must not do. */
  compactBadge: {
    marginRight: 0,
    marginBottom: spacing.xs,
  },
  compactFigureBlock: {
    alignItems: 'center',
  },
  compactFigure: {
    ...font.num,
    fontSize: COMPACT_FIGURE_PT,
    lineHeight: COMPACT_FIGURE_PT + 2,
    fontWeight: '800',
  },
  /** The compact stand-in for the empty, failed and no-lines rows. Those are
   *  sentences, and ~98dp of content is not enough for a sentence, so the text
   *  shrinks to a phrase and the sentence moves to the accessibility label
   *  where it costs no width at all. */
  compactNote: {
    color: colors.textMuted,
    fontSize: font.size.micro,
    textAlign: 'center',
    opacity: 0.7,
  },

  /* ── Controls footer ───────────────────────────────────────── */
  /**
   * Schedule, alarm and filter — at every span, which is the point of the whole
   * rework. The schedule used to exist only at three columns, so at any smaller
   * size it did not exist at all and the only way to reach it was to resize the
   * card first. A size that hides a feature is a trap, not a size.
   *
   * `alignItems: 'stretch'` so each target is the full row height rather than
   * the height of its 18dp icon: the row is the only dimension there is any
   * height to spend, and spending it is free.
   *
   * ### The floor this knowingly goes under
   *
   * At one column the card is 116dp; less its 2dp of border and the 8dp a side
   * `cardCompact` cuts the padding to, that is 116 − 2 − 16 = **98dp of content**,
   * and three `flex: 1` targets across it are **~32dp each**. The app's floor is
   * `HIT_SIZE` = 44. This is deliberate, and it has a second consequence to state
   * plainly: the shared `Pressable` tops an undersized target up to 44 with
   * hitSlop, so at 32dp each control's slop is 6dp a side, neighbouring slops
   * overlap, and a tap within a few dp of a boundary can land on the control next
   * to the one it was aimed at. Both the size and the overlap are the accepted
   * price of having all three reachable at the smallest size.
   *
   * The alternative is folding them into one overflow menu. That is a floor-sized
   * target, and it is also one extra tap for every user at every size, including
   * the three-column card where there is 330dp of room and nothing to solve. Do
   * not "fix" this into that without knowing you are making the common case worse
   * to repair the rare one.
   */
  controls: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: CONTROLS_COMPACT_H_DP,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  /** Three columns, where there is width for real targets: 330dp of content, so
   *  each third is ~110dp wide and the only thing left to buy is height. */
  controlsWide: {
    minHeight: CONTROLS_H_DP,
  },
  /** Thirds rather than fixed widths, so the targets are as large as the card
   *  can make them at every span and their positions never move between spans —
   *  a control that is in a different place on a resized card has to be found
   *  again. */
  controlBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ── Status / footer ───────────────────────────────────────── */
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 22,
    paddingTop: spacing.xs,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  footerText: {
    ...font.num,
    color: colors.textMuted,
    fontSize: font.size.micro - 1,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: font.size.label,
    textAlign: 'center',
    marginVertical: spacing.sm,
    opacity: 0.7,
  },
  errorBox: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  errorText: {
    color: colors.textMuted,
    fontSize: font.size.label,
    textAlign: 'center',
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  retryText: {
    fontSize: font.size.label,
    fontWeight: '700',
  },
  /** Reachable "stop the alert" row for a line the filter has hidden. */
  alertBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(245,158,11,0.14)',
  },
  alertBannerText: {
    ...font.num,
    flex: 1,
    color: colors.warning,
    fontSize: font.size.micro,
    fontWeight: '700',
  },
  alertBannerBtn: {
    minHeight: 32,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
  },
  alertBannerBtnText: {
    color: colors.warning,
    fontSize: font.size.micro,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
});
