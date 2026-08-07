/**
 * LiveMapScreen styles — extracted from the main screen component.
 *
 * The stop card that used to live here moved to `src/ui/StopSheet`, which both
 * map screens now share. What is left is this screen's own chrome: the header,
 * the direction dropdown, the timetable overlay, and the native stop marker
 * that `components/StopMarkers` renders.
 */

import { StyleSheet } from 'react-native';
import { colors, spacing, radius, font } from '../../theme';

export const s = StyleSheet.create({
  headerTitleWrap: { alignItems: 'flex-start' },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center' },
  headerLineId: { color: colors.text, fontSize: font.size.title, fontWeight: '700' },
  headerChevron: { marginLeft: spacing.xs },
  headerRouteDescr: { color: colors.textMuted, fontSize: font.size.micro, fontWeight: '500', marginTop: 1, maxWidth: 220 },
  headerFavBtn: { marginRight: spacing.sm },
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
  routeMenuText: { color: colors.textMuted, fontSize: font.size.label, fontWeight: '500', flex: 1, marginRight: spacing.sm },
  routeMenuTextActive: { color: colors.text, fontWeight: '700' },
  scheduleCard: {
    position: 'absolute', top: spacing.sm, right: 36 + spacing.sm + spacing.sm,
    backgroundColor: colors.overlay, borderRadius: radius.md, padding: spacing.sm,
    borderWidth: 1, borderColor: colors.border, borderTopColor: colors.edge,
    minWidth: 140, maxWidth: 200, maxHeight: 240,
  },
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
});
