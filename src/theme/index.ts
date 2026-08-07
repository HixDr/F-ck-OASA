/**
 * OASA Live — Dark purple theme constants.
 */

import type { TextStyle } from 'react-native';

export const colors = {
  /** Pure black background */
  bg: '#000000',
  /** Dark neutral surface — inputs, modals, chips */
  surface: '#121212',
  /** Card / container. Deliberately one step lighter than `surface`: the two
   *  used to be the same value, so a card sitting on the page and an input
   *  sitting on a card were indistinguishable and nothing read as elevated. */
  card: '#1C1C1F',
  /** Vivid purple accent (default — overridden by settings) */
  primary: '#7B2CBF',
  /** Clean white secondary accent.
   *  NOT the user's accent color — anything that should follow the accent must
   *  read `primaryColor` from SettingsProvider instead of this constant. */
  primaryLight: '#FFFFFF',
  /** Neutral dark borders / dividers */
  border: '#2A2A2A',
  /** Primary text — white */
  text: '#FFFFFF',
  /** Secondary / muted text */
  textMuted: '#9E9E9E',
  /** Danger / error */
  danger: '#EF4444',
  /** Success / live indicator */
  success: '#22C55E',
  /** Warning / ETA accent */
  warning: '#F59E0B',
  /** Transparent overlay */
  overlay: 'rgba(0,0,0,0.85)',
  /** Hairline highlight along a card's top edge.
   *  bg → surface → card is a 0%/7%/11% fill ramp, which collapses into one
   *  flat plane on OLED in daylight. Elevation should not depend on a 4% fill
   *  delta, so cards are also lit from above. */
  edge: 'rgba(255,255,255,0.06)',
} as const;

/**
 * Arrival urgency ramp.
 *
 * These used to live as three hex literals inside `getArrivalColor`, which is
 * why the app carried two different reds: `#F44336` here and `#EF4444` as
 * `colors.danger`. One red now.
 */
export const arrival = {
  /** ≤2 min — leave now. */
  imminent: colors.danger,
  /** ≤5 min — start moving. */
  soon: colors.warning,
  /** Later. */
  later: colors.success,
} as const;

/**
 * Text color that is legible on top of `hex`.
 *
 * The accent is user-chosen from a full 360° hue bar at a fixed 45% lightness
 * (`AccentPicker` → `hslToHex(hue, 70, 45)`), so its luminance swings widely:
 * a purple accent is dark, a yellow or green one is not. Badges used to
 * hardcode `#FFFFFF`, which lands near 2:1 contrast around hue 60 and hue 120
 * — the app's most important label, unreadable, depending on a color the user
 * was invited to pick.
 *
 * Uses the WCAG relative-luminance threshold rather than a naive average:
 * perceived brightness is overwhelmingly carried by the green channel.
 */
export function onAccent(hex: string): '#FFFFFF' | '#000000' {
  const h = hex.replace('#', '');
  if (h.length !== 6) return '#FFFFFF';
  const chan = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    if (!Number.isFinite(v)) return 0;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
  // Contrast against white is (1.05)/(L+0.05); against black it is (L+0.05)/0.05.
  // They cross at L ≈ 0.179.
  return lum > 0.179 ? '#000000' : '#FFFFFF';
}

export const spacing = {
  /** Badge-internal gaps. */
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;

/** Backing value for `font.num`. See the comment on that property. */
const numStyle: Pick<TextStyle, 'fontVariant'> = { fontVariant: ['tabular-nums'] };

/**
 * Type scale, by role rather than t-shirt size.
 *
 * The old ramp had seven steps with near-equal ratios, of which `xxl` had zero
 * uses and `xl` had three — a hierarchy mostly on paper. The role names below
 * are the vocabulary; the old names remain as aliases so this did not have to
 * be a whole-codebase rename in one commit.
 *
 * Deliberately still System. A downloaded face would cost cold-start time and
 * risk Greek glyph coverage, and this app's data is Greek. Character comes from
 * weight, tracking and numerals instead.
 */
export const font = {
  regular: 'System',
  bold: 'System',
  mono: 'monospace',
  size: {
    /** Freshness, metadata, pills. */
    micro: 11,
    /** Section labels, secondary text, badges. */
    label: 13,
    /** List rows, primary content. */
    body: 15,
    /** Screen and stop titles. */
    title: 18,
    /** The one number the app exists to show: minutes to arrival. */
    figure: 34,

    /* Aliases — pre-existing names, same values. */
    xs: 11,
    sm: 13,
    md: 15,
    lg: 18,
    xl: 22,
    xxl: 28,
    xxxl: 34,
  },
  /**
   * Spread into the style of ANY text that renders a number.
   *
   * Without tabular figures, proportional digits change width as an arrival
   * counts 5 → 4 → 3 and the whole row reflows on every tick. This was already
   * applied in five places and missing from both map stop cards — precisely the
   * two that count down. Spreading a shared object is harder to forget than
   * remembering a property.
   *
   * Annotated rather than inferred, and deliberately NOT `as const`: RN types
   * `fontVariant` as a mutable `FontVariant[]`, so a readonly tuple makes
   * `style={[s.foo, font.num]}` fail to compile — the exact usage this exists
   * to encourage. The annotation also survives the outer `as const` below,
   * which would otherwise deep-freeze it right back.
   */
  num: numStyle,
} as const;

/** Minimum touch target. Below this, taps land on the neighbour. */
export const HIT_SIZE = 44;

/**
 * `#RRGGBB` → `rgba(r,g,b,alpha)`.
 * Used to tint surfaces with the user's accent color, which is a runtime hex
 * string and therefore cannot be baked into the palette above.
 */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return hex;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** MapTiler dark style URL (free tier, no key needed for dev) */
export const MAP_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
