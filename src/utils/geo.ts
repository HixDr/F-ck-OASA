/**
 * Geo utilities — bearing, distance helpers.
 */

/** Great-circle distance in metres between two lat/lng points. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Longitude scale factor at a given latitude.
 *
 * Anything doing planar maths on raw degrees (segment projection, nearest-point
 * search) must multiply longitude deltas by this, or east-west error is
 * over-weighted by ~27% at Athens' latitude.
 */
export function lngScaleAt(latDeg: number): number {
  return Math.cos((latDeg * Math.PI) / 180);
}

/** Smallest signed difference between two bearings, in (-180, 180]. */
export function angleDeltaDeg(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/** Bearing in degrees (0-360) between two geographic points. */
export function bearingBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLng = (lng2 - lng1) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}
