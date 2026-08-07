/**
 * AccentPicker — hue bar for the app accent color.
 *
 * The in-flight hue is deliberately local state. Pushing every touch-move into
 * SettingsProvider re-rendered every consumer (i.e. every card on Home) and
 * queued an AsyncStorage write ~60 times a second; a two-second drag cost ~120
 * full re-renders. The value is committed once, on release.
 *
 * Everything that follows the finger — the indicator and the preview badge —
 * therefore reads the local draft, not the provider. Nothing here may reach for
 * `useSettings()`.
 */

import React, { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, type GestureResponderEvent } from 'react-native';
import { spacing, radius, font, onAccent } from '../theme';
import { hslToHex, hexToHue, HUE_COLORS } from '../utils/colorUtils';
import { hapticSelection } from '../services/haptics';

interface Props {
  /** Committed color. */
  value: string;
  /** Called once per gesture, on release. */
  onCommit: (hex: string) => void;
}

/** Keyboard / screen-reader step, in degrees. */
const HUE_STEP = 15;

/**
 * Stand-in line number for the preview badge.
 *
 * A plain swatch answers "what colour is this?", which was never the question
 * the user got wrong. The bar emits a fixed 45% lightness across all 360°, so
 * the accent's luminance swings from near-black purple to near-white yellow
 * while the thing it actually tints — a line badge — carries the app's most
 * important label. Showing that badge, in the hue under the finger, is what
 * makes the choice honest.
 */
const SAMPLE_LINE = '550';

export default function AccentPicker({ value, onCommit }: Props) {
  const barRef = useRef<View>(null);
  const barWidth = useRef(0);
  const barX = useRef(0);
  const [draft, setDraft] = useState<string | null>(null);

  const shown = draft ?? value;

  const hueAt = useCallback((e: GestureResponderEvent): string | null => {
    const w = barWidth.current;
    if (w <= 0) return null;
    const x = e.nativeEvent.pageX - barX.current;
    const hue = Math.max(0, Math.min(359, (x / w) * 360));
    return hslToHex(hue, 70, 45);
  }, []);

  // Mirrored in a ref so `release` can read the final value without doing
  // work inside a state updater — updaters must be pure, and React is free to
  // replay them, which would commit the accent colour twice.
  const draftRef = useRef<string | null>(null);

  const track = useCallback((e: GestureResponderEvent) => {
    const hex = hueAt(e);
    if (!hex) return;
    draftRef.current = hex;
    setDraft(hex);
  }, [hueAt]);

  const release = useCallback(() => {
    const current = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (current && current !== value) {
      hapticSelection();
      onCommit(current);
    }
  }, [onCommit, value]);

  const nudge = useCallback((delta: number) => {
    const next = (hexToHue(value) + delta + 360) % 360;
    hapticSelection();
    onCommit(hslToHex(next, 70, 45));
  }, [onCommit, value]);

  return (
    <View style={s.wrap}>
      <View
        ref={barRef}
        style={s.bar}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={track}
        onResponderMove={track}
        onResponderRelease={release}
        onResponderTerminate={release}
        onLayout={() => {
          barRef.current?.measureInWindow((x, _y, w) => {
            barX.current = x;
            barWidth.current = w;
          });
        }}
        accessibilityRole="adjustable"
        accessibilityLabel="Accent color"
        accessibilityValue={{ text: `Hue ${Math.round(hexToHue(shown))} degrees` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'increment') nudge(HUE_STEP);
          if (e.nativeEvent.actionName === 'decrement') nudge(-HUE_STEP);
        }}
      >
        {HUE_COLORS.map((c, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: c }} />
        ))}
        <View style={[s.indicator, { left: `${(hexToHue(shown) / 360) * 100}%` }]} />
      </View>
      {/* Reads `shown` — the local draft — so it repaints on every touch-move
          without a provider write or a re-render outside this component. The
          text colour is derived, never stored: `onAccent` keeps it above 4.5:1
          at every hue, which is the whole point of showing it here. */}
      <View
        style={[s.preview, { backgroundColor: shown }]}
        /* Purely a visual contrast check — a screen reader announcing a fake
           line number here would be noise, and the bar above already carries
           the label and the adjustable role. */
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={[s.previewText, s.num, { color: onAccent(shown) }]}>{SAMPLE_LINE}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  num: font.num,
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  bar: {
    flex: 1,
    height: 36,
    borderRadius: radius.sm,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  indicator: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 3,
    marginLeft: -1.5,
    backgroundColor: '#FFF',
    borderRadius: 1.5,
  },
  /* Deliberately the same geometry as the line badges in Search and on the
     saved-stop cards. A preview in a different shape is a different test. */
  preview: {
    minWidth: 44,
    height: 36,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewText: {
    fontSize: font.size.label,
    fontWeight: '700',
  },
});
