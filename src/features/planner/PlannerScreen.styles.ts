import { StyleSheet, type TextStyle } from 'react-native';
import { colors, spacing, radius, font } from '../../theme';

/** Re-exported so this screen's numeric styles read `num` rather than `font.num`. */
export const num: TextStyle = font.num;

export const s = StyleSheet.create({
  /* ── Map layer ────────────────────────────────────────────── */

  /** The map is full-bleed now that the results sheet floats over it, so
   *  pulling the sheet down reveals more map instead of more background.
   *  Black, like every other map wrapper: this view is what shows through in the
   *  moment before the native map surface paints, and a default-transparent
   *  wrapper let a light gap flash there. */
  mapFill: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  /** Touch-transparent scrim for everything drawn over the map. Anchored to
   *  the top: the sheet owns the bottom of the screen at every snap point, so
   *  controls parked down there would spend most of their life hidden. */
  mapOverlay: {
    ...StyleSheet.absoluteFillObject,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  mapControls: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  mapPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.overlay,
    borderWidth: 1,
    borderColor: colors.border,
  },
  mapPillText: {
    color: colors.text,
    fontSize: font.size.label,
    fontWeight: '700',
  },
  mapRoundBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.overlay,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'stretch',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.overlay,
    borderWidth: 1,
  },
  placingText: {
    color: colors.text,
    fontSize: font.size.label,
    fontWeight: '600',
    flex: 1,
  },

  /* ── Results sheet ────────────────────────────────────────── */

  /** The sheet sizes itself; this only pins it to the bottom edge so it can
   *  float over the map. */
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  sheetBody: {
    flex: 1,
    paddingHorizontal: spacing.md,
  },
  instructionWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  instructionText: {
    color: colors.textMuted,
    fontSize: font.size.label,
    textAlign: 'center',
    lineHeight: 20,
  },
  /** The affordance the long-press gesture never had. */
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  primaryBtnText: {
    fontSize: font.size.body,
    fontWeight: '700',
  },
  loadingText: {
    color: colors.textMuted,
    fontSize: font.size.label,
  },
  loadingHint: {
    color: colors.textMuted,
    fontSize: font.size.micro,
    opacity: 0.7,
  },
  /** Phase label + cancel, sitting above the skeletons or the partial results.
   *  Naming the stage is the difference between "it is working" and "it is
   *  stuck", so it survives every loading state. */
  phaseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
  },
  grow: {
    flex: 1,
  },
  cancelBtnText: {
    color: colors.textMuted,
    fontSize: font.size.label,
    fontWeight: '600',
  },
  cancelInline: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: font.size.body,
    fontWeight: '700',
    textAlign: 'center',
  },
  resultScroll: {
    flex: 1,
  },
  /** Padding belongs on the content, not the scroller — on the latter it just
   *  shrinks the viewport and the last card still ends flush with the edge. */
  resultScrollContent: {
    paddingBottom: spacing.xl,
  },
  resultCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  legRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  legWalkText: {
    color: '#4285F4',
    fontSize: font.size.micro,
    fontWeight: '600',
    flex: 1,
  },
  legTransferText: {
    color: colors.textMuted,
    fontSize: font.size.micro,
    fontWeight: '600',
    flex: 1,
  },
  legBoardText: {
    color: colors.text,
    fontSize: font.size.micro,
    fontWeight: '600',
    flex: 1,
  },
  legDetailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
    paddingLeft: spacing.lg,
  },
  legDetailText: {
    color: colors.text,
    fontSize: font.size.micro,
    flex: 1,
  },
  legDetailMuted: {
    color: colors.textMuted,
    fontSize: font.size.micro,
    flex: 1,
  },
  lineBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    minWidth: 36,
    alignItems: 'center',
  },
  lineBadgeText: {
    fontSize: font.size.micro,
    fontWeight: '700',
  },
  waitBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderRadius: radius.sm,
  },
  waitBadgeText: {
    fontSize: font.size.micro,
    fontWeight: '700',
  },
  waitUnknownText: {
    color: colors.textMuted,
    fontSize: font.size.micro,
    fontWeight: '600',
  },
  waitWarnText: {
    color: colors.warning,
    fontSize: font.size.micro,
    fontWeight: '700',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  confChip: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    borderWidth: 1,
  },
  confChipText: {
    fontSize: font.size.micro - 1,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  sourceNote: {
    color: colors.textMuted,
    fontSize: font.size.micro - 1,
    fontStyle: 'italic',
  },
  cardSpinnerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  cardErrorText: {
    color: colors.danger,
    fontSize: font.size.micro,
    marginTop: spacing.xs,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  totalText: {
    color: colors.text,
    fontSize: font.size.body,
    fontWeight: '700',
  },
  etaText: {
    color: colors.textMuted,
    fontSize: font.size.micro,
    marginTop: spacing.xxs,
  },
  navBtn: {
    padding: spacing.xs,
  },
  stopPin: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#FFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stopPinInner: {
    width: 4,
    height: 6,
    borderRadius: 1,
    backgroundColor: '#FFF',
  },
  stopPinLarge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 2,
    borderColor: '#FFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stopPinLargeText: {
    color: '#FFF',
    fontSize: font.size.micro,
    fontWeight: '800',
  },
  offlineTitle: {
    color: colors.text,
    fontSize: font.size.title,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: spacing.md,
  },
  offlineSubtitle: {
    color: colors.textMuted,
    fontSize: font.size.label,
    textAlign: 'center',
    marginTop: spacing.xs,
    lineHeight: 20,
  },
  offlineBtn: {
    marginTop: spacing.lg,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  offlineBtnText: {
    fontSize: font.size.body,
    fontWeight: '700',
  },
  tagBadge: {
    alignSelf: 'flex-start',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    marginBottom: spacing.xs,
  },
  tagBadgeText: {
    fontSize: font.size.micro - 1,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
