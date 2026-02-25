/**
 * LiveMapScreen styles — extracted from the main screen component.
 */

import { StyleSheet } from 'react-native';
import { colors, spacing, radius, font } from '../../theme';

export const s = StyleSheet.create({
  headerTitleWrap: { alignItems: 'flex-start' },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center' },
  headerLineId: { color: colors.text, fontSize: font.size.lg, fontWeight: '700' },
  headerRouteDescr: { color: colors.textMuted, fontSize: font.size.xs, fontWeight: '500', marginTop: 1, maxWidth: 220 },
  routeMenu: {
    position: 'absolute', top: 0, left: 0, right: 0,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border,
    paddingVertical: spacing.xs, paddingHorizontal: spacing.sm, zIndex: 10,
  },
  routeMenuItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.sm,
  },
  routeMenuItemActive: { backgroundColor: colors.card },
  routeMenuText: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: '500', flex: 1, marginRight: spacing.sm },
  routeMenuTextActive: { color: colors.text, fontWeight: '700' },
  leftStack: {
    position: 'absolute', bottom: spacing.xl * 2, left: spacing.sm,
  },
  arrivalCard: {
    backgroundColor: colors.overlay, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, minWidth: 160, maxWidth: 220,
  },
  arrivalCardExpanded: {
    minWidth: 300,
    maxWidth: 340,
  },
  arrivalRow: { marginTop: 4 },
  arrivalBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm, alignSelf: 'flex-start' },
  arrivalMin: { color: '#000', fontSize: font.size.sm, fontWeight: '700' },
  scheduleCard: {
    position: 'absolute', top: spacing.sm, right: 36 + spacing.sm + spacing.sm,
    backgroundColor: colors.overlay, borderRadius: radius.md, padding: spacing.sm,
    borderWidth: 1, borderColor: colors.border, minWidth: 140, maxWidth: 200, maxHeight: 240,
  },
  nextDepRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm },
  nextDepLabel: { color: colors.textMuted, fontSize: font.size.xs, fontWeight: '600' },
  allLinesBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    marginTop: spacing.sm, paddingVertical: 4,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  allLinesBtnText: { fontSize: font.size.xs, fontWeight: '600' },
  stopLinesScroll: { maxHeight: 180, marginTop: spacing.xs },
  stopLineRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  stopLineBadge: { borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 2, marginRight: spacing.sm, minWidth: 40, alignItems: 'center' },
  stopLineBadgeText: { color: '#FFFFFF', fontSize: font.size.xs, fontWeight: '700' },
  stopLineDescr: { flex: 1, color: colors.textMuted, fontSize: font.size.xs, marginRight: spacing.sm },
  stopLineArrBadge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm },
  stopLineArrMin: { color: '#000', fontSize: font.size.xs, fontWeight: '700' },
  stopLineNone: { color: colors.textMuted, fontSize: font.size.sm, fontWeight: '600' },
  /* ── Native map marker styles — bus icon + arrow ── */
  stopMarkerOuter: {
    width: 40, height: 40,
    alignItems: 'center',
  },
  stopArrow: {
    width: 0, height: 0,
    borderLeftWidth: 7, borderRightWidth: 7, borderBottomWidth: 10,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderBottomColor: '#FFFFFF',
    marginBottom: -2,
  },
  stopDot: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.6, shadowRadius: 3, elevation: 4,
  },
  stopDotWrap: {
    alignItems: 'center', justifyContent: 'center',
  },
  stopRing: {
    position: 'absolute',
    width: 32, height: 32, borderRadius: 16,
    borderWidth: 2.5, borderColor: 'transparent',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  /* ── Arrival alert/header styles ── */
  arrivalHeaderBtns: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
