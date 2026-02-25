import { StyleSheet } from 'react-native';
import { colors, spacing, radius, font } from '../theme';

export const s = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  stopName: {
    flex: 1,
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: '600',
  },
  editScroll: {
    maxHeight: 200,
  },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs + 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs + 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  lineBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    marginRight: spacing.sm,
    minWidth: 40,
    alignItems: 'center',
  },
  lineBadgeText: {
    color: '#FFFFFF',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  lineDescr: {
    flex: 1,
    color: colors.textMuted,
    fontSize: font.size.xs,
    marginRight: spacing.sm,
  },
  arrivalBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  arrivalMin: {
    color: '#000',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  noArrival: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontWeight: '600',
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    textAlign: 'center',
    marginTop: spacing.xs,
    opacity: 0.7,
  },
  schedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  schedBadgeText: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  schedExpandContainer: {
    paddingVertical: spacing.xs,
    paddingLeft: spacing.sm,
    maxHeight: 140,
  },
});
