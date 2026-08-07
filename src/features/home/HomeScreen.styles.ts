import { StyleSheet } from 'react-native';
import { colors, spacing, radius, font, HIT_SIZE } from '../../theme';

export const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    // Top padding comes from useSafeAreaInsets(): a hardcoded 56 put the logo
    // under the Dynamic Island on any device with a taller inset.
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  /** 32×32 artwork inside a 44×44 target. */
  avatarBtn: {
    width: HIT_SIZE,
    height: HIT_SIZE,
    marginLeft: -spacing.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoIcon: {
    width: 32,
    height: 32,
  },
  /** Deliberately no longer the largest type on screen — the arrival minutes
   *  on the cards below are. Color is applied inline from the accent setting. */
  logo: {
    flex: 1,
    fontSize: font.size.title,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: HIT_SIZE,
    paddingHorizontal: spacing.sm,
    marginRight: -spacing.sm,
  },
  editBtnText: {
    fontSize: font.size.label,
    fontWeight: '700',
  },

  /* ── Entry points ──────────────────────────────────────────────
     Search used to share a row with Nearby and Go To on `flex: 1`, which left
     the app's primary entry point about 130dp on a 360dp screen — and less
     than that once the system font scale grew the two labels beside it. It
     owns a full-width row now; the two destinations share the row below. */
  searchBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    minHeight: HIT_SIZE,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopColor: colors.edge,
    overflow: 'hidden',
  },
  searchBtnText: {
    flex: 1,
    color: colors.textMuted,
    fontSize: font.size.body,
    marginLeft: spacing.sm,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  /** Nearby / Go To. Equal flex so neither can crowd the other out, and
   *  vertical padding rather than a fixed height so a wrapped label at a large
   *  font scale grows the button instead of being clipped by it. */
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    minHeight: HIT_SIZE,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopColor: colors.edge,
    gap: spacing.xs,
  },
  actionBtnText: {
    color: colors.text,
    fontSize: font.size.body,
    fontWeight: '600',
    flexShrink: 1,
  },
  /** Download progress stays visible after the settings sheet is dismissed. */
  headerProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  headerProgressText: {
    color: colors.textMuted,
    fontSize: font.size.micro,
  },
  headerProgressTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  headerProgressFill: {
    height: '100%',
    borderRadius: 2,
  },
  list: {
    paddingHorizontal: spacing.lg,
  },
  /** Wrapper the drag gesture transforms. `elevation` is animated from 0, and
   *  is what keeps a lifted card painted over the cells it travels across —
   *  sibling FlatList cells otherwise paint in list order. */
  stopCell: {
    elevation: 0,
  },
  lineGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  lineCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderTopColor: colors.edge,
    minHeight: HIT_SIZE,
    minWidth: HIT_SIZE,
    paddingHorizontal: spacing.xs,
  },
  lineBadge: {
    backgroundColor: colors.primary, // overridden inline
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.xs + 2,
    minWidth: 44,
    alignItems: 'center',
  },
  /** Color comes from `onAccent(primaryColor)` inline: a hardcoded white sits
   *  at ~2:1 on the yellow and green accents the picker offers. */
  lineBadgeText: {
    ...font.num,
    color: colors.text,
    fontSize: font.size.label,
    fontWeight: '700',
  },
  /** Remove badge shown on a saved line while Home is in edit mode. */
  lineRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    borderRadius: 10,
    backgroundColor: colors.bg,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: font.size.title,
    fontWeight: '700',
    marginTop: spacing.md,
  },
  emptySubtitle: {
    color: colors.textMuted,
    fontSize: font.size.label,
    textAlign: 'center',
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  emptyActions: {
    alignSelf: 'stretch',
    gap: spacing.sm,
  },
  emptyPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: HIT_SIZE + 4,
    borderRadius: radius.lg,
  },
  emptyPrimaryText: {
    fontSize: font.size.body,
    fontWeight: '700',
  },
  emptySecondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: HIT_SIZE + 4,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopColor: colors.edge,
    backgroundColor: colors.card,
  },
  emptySecondaryText: {
    color: colors.text,
    fontSize: font.size.body,
    fontWeight: '600',
  },
  /** Section title and, beside it, the only hint that a card can be picked up.
   *  A long press advertises nothing on its own. */
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: font.size.micro,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  sectionHint: {
    flex: 1,
    color: colors.textMuted,
    fontSize: font.size.micro,
    textAlign: 'right',
    opacity: 0.7,
    marginBottom: spacing.xs,
  },
});
