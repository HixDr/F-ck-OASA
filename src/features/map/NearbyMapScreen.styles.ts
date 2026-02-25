import { StyleSheet } from 'react-native';
import { colors, spacing, radius, font } from '../../theme';

export const s = StyleSheet.create({
  arrivalCard: {
    position: 'absolute', bottom: spacing.xl * 2, left: spacing.sm, right: spacing.sm,
    backgroundColor: colors.overlay, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, maxHeight: 320,
  },
  lineScroll: { maxHeight: 220 },
  lineRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  lineBadge: {
    backgroundColor: colors.primary, borderRadius: radius.sm,
    paddingHorizontal: spacing.sm, paddingVertical: 2,
    marginRight: spacing.sm, minWidth: 40, alignItems: 'center',
  },
  lineBadgeText: { color: '#FFFFFF', fontSize: font.size.xs, fontWeight: '700' },
  lineDescr: { flex: 1, color: colors.textMuted, fontSize: font.size.xs, marginRight: spacing.sm },
  lineArrivalBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm },
  lineArrivalMin: { color: '#000', fontSize: font.size.xs, fontWeight: '700' },
  lineNoArrivals: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: '600' },
  /* ── Native map marker styles ── */
  stopPin: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: '#FFF', justifyContent: 'center', alignItems: 'center' },
  stopPinInner: { width: 4, height: 6, borderRadius: 1, backgroundColor: '#FFF' },
});
