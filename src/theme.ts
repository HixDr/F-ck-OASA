/**
 * OASA Live — Dark purple theme constants.
 */

export const colors = {
  /** Pure black background */
  bg: '#000000',
  /** Dark neutral surface */
  surface: '#121212',
  /** Card / container */
  card: '#121212',
  /** Vivid purple accent (default — overridden by settings) */
  primary: '#7B2CBF',
  /** Clean white secondary accent */
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
  },
} as const;

/** MapTiler dark style URL (free tier, no key needed for dev) */
export const MAP_STYLE =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
