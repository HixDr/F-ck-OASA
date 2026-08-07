/**
 * MapControls — the floating chrome both map screens draw over the map.
 *
 * Live and Nearby had byte-identical copies of these two clusters, differing
 * only in how many toggles the column held. Both copies also shipped without a
 * single `accessibilityLabel`, in an app that labels everything else: to a
 * screen reader they were four unnamed buttons whose state was carried purely
 * by border color.
 */

import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing } from '../theme';
import { mapStyles as ms } from '../theme/mapStyles';
import Pressable from './Pressable';

export interface MapToggle {
  /** React key, and the storage key these usually persist under. */
  key: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  /** What the toggle shows, spoken. The pressed state rides on `active`. */
  label: string;
  active: boolean;
  onPress: () => void;
}

interface Props {
  toggles: MapToggle[];
  /** The user's accent color — marks an active toggle. */
  accentColor: string;
  onRecenter: () => void;
  /**
   * Pixels to lift the bottom cluster by, so an open stop sheet does not bury
   * the recenter button. See `useStopSheetInset`.
   */
  bottomOffset?: number;
  /** Extra bottom-cluster content under the recenter button (Live's timer). */
  children?: React.ReactNode;
}

export default function MapControls({
  toggles, accentColor, onRecenter, bottomOffset = 0, children,
}: Props) {
  return (
    <>
      <View style={ms.topControls}>
        {toggles.map((t) => (
          <Pressable
            key={t.key}
            style={[ms.toggleBtn, t.active && ms.toggleBtnActive, t.active && { borderColor: accentColor }]}
            onPress={t.onPress}
            accessibilityRole="button"
            accessibilityLabel={t.label}
            accessibilityState={{ selected: t.active }}
          >
            <Ionicons name={t.icon} size={18} color={t.active ? accentColor : colors.textMuted} />
          </Pressable>
        ))}
      </View>

      <View style={[ms.bottomControls, bottomOffset > 0 && { bottom: spacing.lg + bottomOffset }]}>
        <Pressable
          style={ms.locationBtn}
          onPress={onRecenter}
          accessibilityRole="button"
          accessibilityLabel="Center the map on my location"
        >
          <View style={ms.locationIcon}><View style={ms.locationDot} /></View>
        </Pressable>
        {children}
      </View>
    </>
  );
}
