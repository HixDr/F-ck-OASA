/**
 * Parsed stop table.
 *
 * `getAllCachedStops()` returns ~9,400 records with lat/lng as strings. The old
 * candidate search parsed all of them twice per search (once per pin) and the
 * index builder parsed them a third time. Coordinates never change between
 * searches, so parse once into typed arrays and keep them, keyed on the array
 * instance storage hands back — when storage memoizes, we never re-parse.
 */

import type { OasaBulkStop } from '../../types';
import { haversineM, lngScaleAt } from '../../utils/geo';
import { CANDIDATE_RADIUS_M } from './constants';
import type { StopCandidate } from './types';

/** Metres per degree of latitude. Good to ~0.1% anywhere in Attica. */
const M_PER_DEG_LAT = 111_320;

export interface StopTable {
  codes: string[];
  names: string[];
  lat: Float64Array;
  lng: Float64Array;
  byCode: Map<string, number>;
}

let _cachedSource: OasaBulkStop[] | null = null;
let _cachedTable: StopTable | null = null;

/** Build (or reuse) the parsed table for a stop array. */
export function buildStopTable(allStops: OasaBulkStop[]): StopTable {
  if (_cachedSource === allStops && _cachedTable) return _cachedTable;

  const n = allStops.length;
  const codes = new Array<string>(n);
  const names = new Array<string>(n);
  const lat = new Float64Array(n);
  const lng = new Float64Array(n);
  const byCode = new Map<string, number>();

  let w = 0;
  for (let i = 0; i < n; i++) {
    const s = allStops[i];
    const la = parseFloat(s.stop_lat);
    const ln = parseFloat(s.stop_lng);
    // A handful of rows carry blank coordinates; they would otherwise become
    // NaN distances that compare false against every threshold.
    if (!Number.isFinite(la) || !Number.isFinite(ln)) continue;
    codes[w] = s.stop_code;
    names[w] = s.stop_descr_eng || s.stop_descr;
    lat[w] = la;
    lng[w] = ln;
    byCode.set(s.stop_code, w);
    w++;
  }
  codes.length = w;
  names.length = w;

  const table: StopTable = {
    codes,
    names,
    lat: lat.subarray(0, w),
    lng: lng.subarray(0, w),
    byCode,
  };
  _cachedSource = allStops;
  _cachedTable = table;
  return table;
}

/**
 * Stops within CANDIDATE_RADIUS_M of a pin, nearest first.
 *
 * A degree bounding box rejects >99% of the table with two subtractions before
 * any trigonometry runs — 9,400 haversines per pin was pure waste.
 */
export function findCandidateStops(
  pinLat: number,
  pinLng: number,
  table: StopTable,
): StopCandidate[] {
  const maxDLat = CANDIDATE_RADIUS_M / M_PER_DEG_LAT;
  const maxDLng = CANDIDATE_RADIUS_M / (M_PER_DEG_LAT * Math.max(0.1, lngScaleAt(pinLat)));
  const { codes, names, lat, lng } = table;

  const out: StopCandidate[] = [];
  for (let i = 0; i < codes.length; i++) {
    if (Math.abs(lat[i] - pinLat) > maxDLat) continue;
    if (Math.abs(lng[i] - pinLng) > maxDLng) continue;
    const d = haversineM(pinLat, pinLng, lat[i], lng[i]);
    if (d <= CANDIDATE_RADIUS_M) {
      out.push({ code: codes[i], name: names[i], lat: lat[i], lng: lng[i], distM: d });
    }
  }
  out.sort((a, b) => a.distM - b.distM);
  return out;
}
