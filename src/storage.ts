/**
 * Persistent storage via AsyncStorage (Expo Go compatible).
 * Uses an in-memory mirror for synchronous reads during the session.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { FavoriteLine, OasaLine, MapStamp, OasaSchedLines, OasaStop } from './types';
import { getMLInfo, getSchedLines } from './api';

/* ── Keys ────────────────────────────────────────────────────── */

const FAVORITES_KEY = '@oasa/favorites';
const LINES_CACHE_KEY = '@oasa/lines_cache';
const LINES_CACHE_TS_KEY = '@oasa/lines_cache_ts';
const STAMPS_KEY = '@oasa/stamps';
const TOGGLES_KEY = '@oasa/toggles';
const SETTINGS_KEY = '@oasa/settings';
const SCHEDULE_CACHE_PREFIX = '@oasa/schedule/';
const STOPS_CACHE_PREFIX = '@oasa/stops/';
const BUS_POS_PREFIX = '@oasa/buspos/';

/* ── In-Memory Mirror (for synchronous access) ──────────────── */

let _favorites: FavoriteLine[] = [];
let _stamps: MapStamp[] = [];
let _toggles: Record<string, boolean> = {};
let _settings: Record<string, string> = {};
let _initialized = false;

/** Must be called once at app start (e.g. in _layout). */
export async function initStorage(): Promise<void> {
  if (_initialized) return;
  try {
    const raw = await AsyncStorage.getItem(FAVORITES_KEY);
    if (raw) _favorites = JSON.parse(raw);
  } catch {
    _favorites = [];
  }
  try {
    const raw = await AsyncStorage.getItem(STAMPS_KEY);
    if (raw) _stamps = JSON.parse(raw);
  } catch {
    _stamps = [];
  }
  try {
    const raw = await AsyncStorage.getItem(TOGGLES_KEY);
    if (raw) _toggles = JSON.parse(raw);
  } catch {
    _toggles = {};
  }
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    if (raw) _settings = JSON.parse(raw);
  } catch {
    _settings = {};
  }
  _initialized = true;
}

/* ── Favorites (sync reads from mirror, async writes) ────────── */

export function getFavorites(): FavoriteLine[] {
  return _favorites;
}

function persistFavorites(): void {
  AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(_favorites)).catch(() => {});
}

export function addFavorite(line: FavoriteLine): FavoriteLine[] {
  if (_favorites.some((f) => f.lineCode === line.lineCode)) return _favorites;
  _favorites = [..._favorites, line];
  persistFavorites();
  return _favorites;
}

export function removeFavorite(lineCode: string): FavoriteLine[] {
  _favorites = _favorites.filter((f) => f.lineCode !== lineCode);
  persistFavorites();
  return _favorites;
}

export function isFavorite(lineCode: string): boolean {
  return _favorites.some((f) => f.lineCode === lineCode);
}

/* ── Lines Cache ─────────────────────────────────────────────── */

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export async function getCachedLines(): Promise<OasaLine[] | null> {
  try {
    const tsRaw = await AsyncStorage.getItem(LINES_CACHE_TS_KEY);
    if (!tsRaw) return null;
    const ts = Number(tsRaw);
    if (Date.now() - ts > CACHE_TTL) return null;
    const raw = await AsyncStorage.getItem(LINES_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as OasaLine[];
  } catch {
    return null;
  }
}

export async function setCachedLines(lines: OasaLine[]): Promise<void> {
  try {
    await AsyncStorage.setItem(LINES_CACHE_KEY, JSON.stringify(lines));
    await AsyncStorage.setItem(LINES_CACHE_TS_KEY, String(Date.now()));
  } catch {
    // Silently fail — cache is best-effort
  }
}

/* ── Map Stamps (sync reads from mirror, async writes) ───────── */

export function getStamps(): MapStamp[] {
  return _stamps;
}

function persistStamps(): void {
  AsyncStorage.setItem(STAMPS_KEY, JSON.stringify(_stamps)).catch(() => {});
}

export function addStamp(stamp: Omit<MapStamp, 'id'>): MapStamp[] {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  _stamps = [..._stamps, { ...stamp, id }];
  persistStamps();
  return _stamps;
}

export function removeStamp(id: string): MapStamp[] {
  _stamps = _stamps.filter((s) => s.id !== id);
  persistStamps();
  return _stamps;
}

/* ── Map Toggles (sync reads from mirror, async writes) ──────── */

export function getToggle(key: string, fallback = true): boolean {
  return _toggles[key] ?? fallback;
}

export function setToggle(key: string, value: boolean): void {
  _toggles[key] = value;
  AsyncStorage.setItem(TOGGLES_KEY, JSON.stringify(_toggles)).catch(() => {});
}

/* ── App Settings (sync reads from mirror, async writes) ─────── */

export function getSetting(key: string, fallback: string): string {
  return _settings[key] ?? fallback;
}

export function setSetting(key: string, value: string): void {
  _settings[key] = value;
  AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings)).catch(() => {});
}

/* ── Schedule Cache (offline) ────────────────────────────────── */

export async function getCachedSchedule(lineCode: string): Promise<OasaSchedLines | null> {
  try {
    const raw = await AsyncStorage.getItem(SCHEDULE_CACHE_PREFIX + lineCode);
    if (!raw) return null;
    return JSON.parse(raw) as OasaSchedLines;
  } catch {
    return null;
  }
}

export async function setCachedSchedule(lineCode: string, data: OasaSchedLines): Promise<void> {
  AsyncStorage.setItem(SCHEDULE_CACHE_PREFIX + lineCode, JSON.stringify(data)).catch(() => {});
}

/* ── Route Stops Cache (offline) ─────────────────────────────── */

export async function getCachedStops(routeCode: string): Promise<OasaStop[] | null> {
  try {
    const raw = await AsyncStorage.getItem(STOPS_CACHE_PREFIX + routeCode);
    if (!raw) return null;
    return JSON.parse(raw) as OasaStop[];
  } catch {
    return null;
  }
}

export async function setCachedStops(routeCode: string, data: OasaStop[]): Promise<void> {
  AsyncStorage.setItem(STOPS_CACHE_PREFIX + routeCode, JSON.stringify(data)).catch(() => {});
}

/* ── Last-Known Bus Positions Cache ──────────────────────────── */

export interface CachedBusPositions {
  ts: number; // Date.now() when saved
  buses: Array<{ lat: number; lng: number; id: string }>;
}

export async function getCachedBusPositions(routeCode: string): Promise<CachedBusPositions | null> {
  try {
    const raw = await AsyncStorage.getItem(BUS_POS_PREFIX + routeCode);
    if (!raw) return null;
    return JSON.parse(raw) as CachedBusPositions;
  } catch {
    return null;
  }
}

export function setCachedBusPositions(routeCode: string, buses: CachedBusPositions['buses']): void {
  const data: CachedBusPositions = { ts: Date.now(), buses };
  AsyncStorage.setItem(BUS_POS_PREFIX + routeCode, JSON.stringify(data)).catch(() => {});
}

/* ── Prefetch Favorite Schedules ─────────────────────────────── */

/**
 * Fetch and cache schedules for all favorited lines.
 * Runs silently — errors are swallowed so it never blocks the app.
 */
export async function prefetchFavoriteSchedules(): Promise<void> {
  try {
    const favs = getFavorites();
    if (favs.length === 0) return;

    const mlInfo = await getMLInfo();
    if (!mlInfo || mlInfo.length === 0) return;

    const mlMap = new Map(mlInfo.map((m) => [m.line_code, m]));

    await Promise.allSettled(
      favs.map(async (fav) => {
        const ml = mlMap.get(fav.lineCode);
        if (!ml) return;
        try {
          const schedule = await getSchedLines(ml.ml_code, ml.sdc_code, fav.lineCode);
          if (schedule) {
            await setCachedSchedule(fav.lineCode, schedule);
          }
        } catch {}
      }),
    );
  } catch {}
}
