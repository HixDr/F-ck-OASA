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
    fontSize: font.size.md,
    fontWeight: '600',
  },
  /** Header icon buttons (filter, remove, reorder). Full-size targets so they
   *  need no hitSlop — overlapping hitSlop is what made the bell and the
   *  timetable button steal each other's taps. */
  headerBtn: {
    width: 36,
    height: 36,
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
  lineBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    marginRight: spacing.sm,
    minWidth: 46,
    alignItems: 'center',
  },
  lineBadgeText: {
    color: '#FFFFFF',
    fontSize: font.size.sm,
    fontWeight: '800',
  },
  lineMain: {
    flex: 1,
    marginRight: spacing.sm,
    gap: 2,
  },
  lineDescr: {
    color: colors.text,
    fontSize: font.size.sm,
  },
  lineDescrMuted: {
    color: colors.textMuted,
    fontSize: font.size.xs,
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
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },

  /* ── The number the app exists to show ─────────────────────── */
  arrivalBlock: {
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrivalMin: {
    fontSize: font.size.xxxl,
    lineHeight: font.size.xxxl + 2,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
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
    color: colors.textMuted,
    fontSize: font.size.xs - 1,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
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
    fontSize: font.size.sm,
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
    fontSize: font.size.sm,
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
    flex: 1,
    color: colors.warning,
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  alertBannerBtn: {
    minHeight: 32,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
  },
  alertBannerBtnText: {
    color: colors.warning,
    fontSize: font.size.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
});
