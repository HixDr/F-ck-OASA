import { StyleSheet } from 'react-native';
import { colors, spacing, radius, font, HIT_SIZE } from '../theme';

export const s = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm + 2,
    paddingBottom: spacing.xs,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    // Lit from above: bg → surface → card is a 4% fill delta that collapses
    // into one flat plane on OLED in daylight.
    borderTopColor: colors.edge,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 32,
  },
  stopName: {
    flex: 1,
    color: colors.text,
    fontSize: font.size.body,
    fontWeight: '600',
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
  editScroll: {
    maxHeight: 240,
  },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: HIT_SIZE,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },

  /* ── Arrival row ───────────────────────────────────────────── */
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 62,
    paddingVertical: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
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
    borderTopColor: colors.border,
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
  schedExpandContainer: {
    paddingVertical: spacing.xs,
    paddingLeft: spacing.sm,
    maxHeight: 140,
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
