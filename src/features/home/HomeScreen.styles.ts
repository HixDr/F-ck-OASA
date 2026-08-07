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
    fontSize: font.size.lg,
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
    fontSize: font.size.sm,
    fontWeight: '700',
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  searchBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    minHeight: HIT_SIZE,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  searchBtnText: {
    color: colors.textMuted,
    fontSize: font.size.md,
    marginLeft: spacing.sm,
    flexShrink: 1,
  },
  nearbyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    minHeight: HIT_SIZE,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  nearbyBtnText: {
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: '600',
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
    fontSize: font.size.xs,
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
  lineBadgeText: {
    color: '#FFFFFF',
    fontSize: font.size.sm,
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
    fontSize: font.size.lg,
    fontWeight: '700',
    marginTop: spacing.md,
  },
  emptySubtitle: {
    color: colors.textMuted,
    fontSize: font.size.sm,
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
    color: '#FFF',
    fontSize: font.size.md,
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
    backgroundColor: colors.card,
  },
  emptySecondaryText: {
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: '600',
  },
  stopsSection: {
    marginBottom: spacing.sm,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
});
