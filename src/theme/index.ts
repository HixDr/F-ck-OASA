/**
 * OASA Live — Dark purple theme constants.
 */

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
} as const;

export const spacing = {
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

export const font = {
  regular: 'System',
  bold: 'System',
  mono: 'monospace',
  size: {
    xs: 11,
    sm: 13,
    md: 15,
    lg: 18,
    xl: 22,
    xxl: 28,
    /** Reserved for the one number the app exists to show: minutes to arrival. */
    xxxl: 32,
  },
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
