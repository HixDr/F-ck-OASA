import { METRO_LINES } from './metro';

/**
 * Pre-computed metro polyline data for react-native-maps.
 * Avoids identical `Object.values(METRO_LINES).map(...)` in 3 screen components.
 */
export const METRO_POLYLINES = Object.values(METRO_LINES).map((line) => ({
  color: line.color,
  coords: line.stations.map((st) => ({ latitude: st.c[0], longitude: st.c[1] })),
}));
