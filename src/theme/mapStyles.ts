/**
 * Shared map styles used by all map screens.
 */

import { StyleSheet } from 'react-native';
import { colors, spacing, font } from '.';

export const mapStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  map: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  topControls: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  toggleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.overlay,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  toggleBtnActive: {
    borderColor: colors.primary,
  },
  bottomControls: {
    position: 'absolute',
    bottom: spacing.lg,
    right: spacing.lg,
    alignItems: 'flex-end',
    gap: spacing.sm,
  },
  locationBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.overlay,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  locationIcon: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#4285F4',
    justifyContent: 'center',
    alignItems: 'center',
  },
  locationDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#4285F4',
  },
  loader: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.bg,
  },
  loaderOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  arrivalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
    gap: spacing.sm,
  },
  arrivalName: {
    color: colors.text,
    fontSize: font.size.sm,
    fontWeight: '700',
    flex: 1,
  },
  arrivalEmpty: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    marginTop: 4,
  },
  walkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: spacing.xs,
  },
  walkText: {
    color: '#4285F4',
    fontSize: font.size.xs,
    fontWeight: '600',
  },
  userDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(66,133,244,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  userDotInner: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#4285F4',
    borderWidth: 2.5,
    borderColor: '#FFF',
  },
  /** Wrapper for user marker + heading cone */
  userMarkerWrap: {
    width: 80,
    height: 80,
    justifyContent: 'center',
    alignItems: 'center',
  },
  /** SVG heading beam wrapper — fills the 80×80 marker, rotates around center (dot position) */
  headingBeam: {
    ...StyleSheet.absoluteFillObject,
  },
  catIcon: {
    width: 30,
    height: 30,
  },
  stampMarker: {
    alignItems: 'center' as const,
  },
  stampEmoji: {
    fontSize: 22,
  },
  stampLabel: {
    fontSize: 9,
    color: '#FFF',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
    marginTop: 1,
  },
});
