import { StyleSheet } from 'react-native';
import { colors, spacing, radius, font, HIT_SIZE } from '../theme';

/**
 * The compact tier's arrival figure, in points.
 *
 * Every other tier shows 34. The design's first principle is that the arrival
 * number survives as long as possible — content is dropped around it before it
 * is shrunk — and this is the single place that principle is deliberately
 * traded away for density, so that three cards fit across a phone. At ~88dp of
 * content a 44dp badge and a 56dp block cannot sit side by side at all, so they
 * stack, and a stacked 34pt figure with its caption is taller than the box a
 * card that narrow is likely to be given.
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 32,
  },
  /** `header`'s 32 is sized for a 16dp pin, a 15pt name and a 40dp button. At
   *  `compact` only the name is left, and every point of chrome height comes
   *  straight out of the figure below it — see `compactBody`. */
  headerCompact: {
    minHeight: 24,
  },
  stopName: {
    flex: 1,
    color: colors.text,
    fontSize: font.size.body,
    fontWeight: '600',
  },
  /** One step down at `compact`. The name is truncated to a line at any tier,
   *  so the smaller size is not about fitting the whole name — it is about how
   *  many characters of it survive the truncation in ~88dp. */
  stopNameCompact: {
    fontSize: font.size.label,
  },
  /** Header icon buttons (filter, remove, reorder). 40 rather than 36: the
   *  shared Pressable tops every target up to HIT_SIZE with hitSlop, and at 36
   *  in a 4pt-gap row that slop would overlap the neighbour — which is exactly
   *  what once made the bell and the timetable button steal each other's taps.
   *  At 40 the slop is 2 a side and lands precisely in the gap. */
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** `flexShrink` is inert while the card sizes itself to its content — an
   *  unconstrained column has no space to shrink into — and load-bearing once
   *  the card is handed a fixed box, where 240dp of line list inside a 160dp
   *  card would be clipped by the card's `overflow: 'hidden'` rather than
   *  scrolled. */
  editScroll: {
    maxHeight: 240,
    flexShrink: 1,
  },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: HIT_SIZE,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },

  /* ── Arrival row ───────────────────────────────────────────── */
  /**
   * The scroll region the arrival rows get once the card has a fixed height.
   *
   * `flex: 1` rather than a natural height: a scroll view that sized itself to
   * its content is exactly the overflow the box exists to prevent, and the
   * clipping would eat the footer notice — the one line that says the numbers
   * above it are not live — instead of the rows the user can scroll to. Taking
   * the leftover height pins that notice to the bottom edge and gives the rows
   * everything else.
   */
  bodyScroll: {
    flex: 1,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 62,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  /**
   * The same row at `standard`.
   *
   * 62 was the height of a description stacked over a timetable pill beside the
   * figure. `standard` drops both, so the row is one 34pt figure and its
   * caption tall and the extra ten points are empty card — which at ~146dp of
   * content is not cosmetic, it is the difference between three arrival rows
   * fitting in a box and two. The floor still matters for the rows the figure
   * does not fill: an em dash or a "now" would otherwise make a card of expired
   * estimates a ragged stack of short rows.
   */
  lineRowStandard: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  /** Cold-start placeholder. Same metrics as `lineRow` so the real rows land
   *  where the grey ones were rather than shoving the card taller. */
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 62,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  /** And the same at `standard`, for the same reason: a placeholder that does
   *  not match the row replacing it reintroduces the jump it exists to avoid. */
  skeletonRowStandard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 52,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  skeletonGrow: {
    flex: 1,
  },
  /** Stands in for `arrivalBlockFill`, so the grey block sits where the figure
   *  will. */
  skeletonFill: {
    flex: 1,
    alignItems: 'center',
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
  lineDescrMuted: {
    color: colors.textMuted,
    fontSize: font.size.micro,
  },
  /** Timetable affordance. Lives under the description, far from the bell. */
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
  /**
   * `standard` only. With the description and the bell gone, nothing else in
   * the row is flexible, so the block would sit hard against the badge with all
   * the slack pooled at the card's edge. Letting it take the slack centres the
   * figure in the space beside the badge instead.
   *
   * This does not weaken the reservation above: the block's width is now
   * decided by the row rather than by its own contents, which is the same
   * guarantee — a 12 → 9 tick moves nothing — arrived at from the other side.
   */
  arrivalBlockFill: {
    flex: 1,
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
  schedExpandContainer: {
    paddingVertical: spacing.xs,
    paddingLeft: spacing.sm,
    maxHeight: 140,
  },

  /* ── Compact tier ──────────────────────────────────────────── */
  /**
   * The whole body of a compact card: one badge over one figure, centred in
   * whatever box the canvas handed the card.
   *
   * Centred rather than top-aligned, and not only because it looks composed.
   * The card clips what it cannot fit, and centring puts the badge's top edge
   * and the caption's bottom edge at the two boundaries — so a box that is a
   * few points too short loses those first and the digits last, which is the
   * order the app's first principle asks for.
   *
   * No vertical padding, deliberately. The card's own padding already keeps the
   * stack off the border, and padding here is height subtracted from the box
   * before the figure is laid out — which at the bottom of the size range is
   * the difference between a legible number and a clipped one.
   *
   * `flex: 1` is inert when the card has no fixed height (a card the user has
   * never arranged is full width and therefore never compact), so this style is
   * safe on both paths.
   */
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
   *  sentences, and ~88dp of content is not enough for a sentence, so the text
   *  shrinks to a phrase and the sentence moves to the accessibility label
   *  where it costs no width at all. */
  compactNote: {
    color: colors.textMuted,
    fontSize: font.size.micro,
    textAlign: 'center',
    opacity: 0.7,
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
