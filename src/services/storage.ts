/**
 * Persistent storage via AsyncStorage (Expo Go compatible).
 * Uses an in-memory mirror for synchronous reads during the session.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Directory, Paths } from 'expo-file-system';
import type { FavoriteLine, FavoriteStop, OasaLine, MapStamp, OasaDailySchedule, OasaStop, OasaBulkStop, OasaRoute } from '../types';
import { getDailySchedule } from './api';

/* ── Keys ────────────────────────────────────────────────────── */

const FAVORITES_KEY = '@oasa/favorites';
const FAVORITE_STOPS_KEY = '@oasa/favorite_stops';
const LINES_CACHE_KEY = '@oasa/lines_cache';
const LINES_CACHE_TS_KEY = '@oasa/lines_cache_ts';
const STAMPS_KEY = '@oasa/stamps';
const TOGGLES_KEY = '@oasa/toggles';
const SETTINGS_KEY = '@oasa/settings';
const BUS_POS_PREFIX = '@oasa/buspos/';
const OFFLINE_FLAG_KEY = '@oasa/offline_downloaded';
const OFFLINE_TS_KEY = '@oasa/offline_ts';

/* ── In-Memory Mirror (for synchronous access) ──────────────── */

let _favorites: FavoriteLine[] = [];
let _favoriteStops: FavoriteStop[] = [];
let _stamps: MapStamp[] = [];
let _toggles: Record<string, boolean> = {};
let _settings: Record<string, string> = {};
let _offlineDownloaded = false;
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
    const raw = await AsyncStorage.getItem(FAVORITE_STOPS_KEY);
    if (raw) _favoriteStops = JSON.parse(raw);
  } catch {
    _favoriteStops = [];
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
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_FLAG_KEY);
    _offlineDownloaded = raw === '1';
  } catch {
    _offlineDownloaded = false;
  }
  // Migration: reset offline flag if old directory format (consolidated files missing)
  if (_offlineDownloaded) {
    const check = new File(Paths.document, 'oasa_schedules.json');
    if (!check.exists) {
      _offlineDownloaded = false;
      AsyncStorage.removeItem(OFFLINE_FLAG_KEY).catch(() => {});
    }
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

/* ── Favorite Stops (sync reads from mirror, async writes) ──── */

export function getFavoriteStops(): FavoriteStop[] {
  return _favoriteStops;
}

function persistFavoriteStops(): void {
  AsyncStorage.setItem(FAVORITE_STOPS_KEY, JSON.stringify(_favoriteStops)).catch(() => {});
}

export function addFavoriteStop(stop: FavoriteStop): FavoriteStop[] {
  if (_favoriteStops.some((s) => s.stopCode === stop.stopCode)) return _favoriteStops;
  _favoriteStops = [..._favoriteStops, stop];
  persistFavoriteStops();
  return _favoriteStops;
}

export function removeFavoriteStop(stopCode: string): FavoriteStop[] {
  _favoriteStops = _favoriteStops.filter((s) => s.stopCode !== stopCode);
  persistFavoriteStops();
  return _favoriteStops;
}

export function isFavoriteStop(stopCode: string): boolean {
  return _favoriteStops.some((s) => s.stopCode === stopCode);
}

export function updateFavoriteStop(stopCode: string, patch: Partial<FavoriteStop>): FavoriteStop[] {
  _favoriteStops = _favoriteStops.map((s) =>
    s.stopCode === stopCode ? { ...s, ...patch } : s,
  );
  persistFavoriteStops();
  return _favoriteStops;
}

/* ── Lines Cache ─────────────────────────────────────────────── */

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export async function getCachedLines(): Promise<OasaLine[] | null> {
  try {
    const tsRaw = await AsyncStorage.getItem(LINES_CACHE_TS_KEY);
    if (!tsRaw) return null;
    const ts = Number(tsRaw);
    // Skip TTL check if offline data has been downloaded (store indefinitely)
    if (!_offlineDownloaded && Date.now() - ts > CACHE_TTL) return null;
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

/* ── Consolidated File Caches (single file + in-memory dict) ─── */

/**
 * Key-value cache backed by a single JSON file on disk.
 * - In-memory dict loaded lazily on first access (deduplicates concurrent loads).
 * - Runtime writes are debounced (1 s) to avoid blocking the JS thread on large files.
 * - Bulk writes (used by the download orchestrator) are immediate.
 */
function createDictCache<T>(fileName: string) {
  const file = new File(Paths.document, fileName);
  let _dict: Record<string, T> | null = null;
  let _loading: Promise<Record<string, T>> | null = null;
  let _persistTimer: ReturnType<typeof setTimeout> | null = null;

  async function load(): Promise<Record<string, T>> {
    if (_dict) return _dict;
    if (_loading) return _loading;
    _loading = (async () => {
      try {
        if (file.exists) _dict = JSON.parse(await file.text()) as Record<string, T>;
      } catch {}
      if (!_dict) _dict = {};
      _loading = null;
      return _dict;
    })();
    return _loading;
  }

  function persistNow(): void {
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    if (!_dict) return;
    try {
      file.create({ overwrite: true });
      file.write(JSON.stringify(_dict));
    } catch {}
  }

  function persistDebounced(): void {
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(persistNow, 1000);
  }

  return {
    /** Eagerly load the backing file into memory (idempotent). */
    preload: (): Promise<void> => load().then(() => {}),
    get: async (key: string): Promise<T | null> => {
      const d = await load();
      return d[key] ?? null;
    },
    set: async (key: string, data: T): Promise<void> => {
      const d = await load();
      d[key] = data;
      persistDebounced();
    },
    setBulk: (all: Record<string, T>): void => {
      _dict = all;
      _loading = null;
      persistNow();
    },
    clear: (): void => {
      if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
      _dict = null;
      _loading = null;
      try { if (file.exists) file.delete(); } catch {}
    },
  };
}

const _schedCache = createDictCache<OasaDailySchedule>('oasa_schedules.json');
const _routesCache = createDictCache<OasaRoute[]>('oasa_routes.json');
const _routesForStopCache = createDictCache<OasaRoute[]>('oasa_routes_for_stop.json');
const _stopsCache = createDictCache<OasaStop[]>('oasa_route_stops.json');

/**
 * Eagerly load all dict-cache backing files into memory.
 * Call once at app startup (fire-and-forget) so the planner's first run
 * doesn't pay the cold-cache file-read penalty.
 */
export function warmPlannerCaches(): Promise<void> {
  return Promise.all([
    _schedCache.preload(),
    _routesCache.preload(),
    _routesForStopCache.preload(),
    _stopsCache.preload(),
  ]).then(() => {});
}

/* ── Schedule Cache ──────────────────────────────────────────── */

export function getCachedSchedule(lineCode: string): Promise<OasaDailySchedule | null> {
  return _schedCache.get(lineCode);
}

export function setCachedSchedule(lineCode: string, data: OasaDailySchedule): Promise<void> {
  return _schedCache.set(lineCode, data);
}

export function setCachedSchedulesBulk(data: Record<string, OasaDailySchedule>): void {
  _schedCache.setBulk(data);
}

/* ── Routes Cache ────────────────────────────────────────────── */

export function getCachedRoutes(lineCode: string): Promise<OasaRoute[] | null> {
  return _routesCache.get(lineCode);
}

export function setCachedRoutes(lineCode: string, data: OasaRoute[]): Promise<void> {
  return _routesCache.set(lineCode, data);
}

export function setCachedRoutesBulk(data: Record<string, OasaRoute[]>): void {
  _routesCache.setBulk(data);
}

/* ── Routes-For-Stop Cache ───────────────────────────────────── */

export function getCachedRoutesForStop(stopCode: string): Promise<OasaRoute[] | null> {
  return _routesForStopCache.get(stopCode);
}

export function setCachedRoutesForStop(stopCode: string, data: OasaRoute[]): Promise<void> {
  // Skip runtime writes when bulk offline data exists (avoids re-serializing large file)
  if (_offlineDownloaded) return Promise.resolve();
  return _routesForStopCache.set(stopCode, data);
}

export function setCachedRoutesForStopBulk(data: Record<string, OasaRoute[]>): void {
  _routesForStopCache.setBulk(data);
}

/* ── Route Stops Cache ───────────────────────────────────────── */

export function getCachedStops(routeCode: string): Promise<OasaStop[] | null> {
  return _stopsCache.get(routeCode);
}

export function setCachedStops(routeCode: string, data: OasaStop[]): Promise<void> {
  // Skip runtime writes when bulk offline data exists (avoids re-serializing large file)
  if (_offlineDownloaded) return Promise.resolve();
  return _stopsCache.set(routeCode, data);
}

export function setCachedStopsBulk(data: Record<string, OasaStop[]>): void {
  _stopsCache.setBulk(data);
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
 * Fetch and cache today's schedules for all favorited lines.
 * Runs silently — errors are swallowed so it never blocks the app.
 */
export async function prefetchFavoriteSchedules(): Promise<void> {
  try {
    const favs = getFavorites();
    if (favs.length === 0) return;

    await Promise.allSettled(
      favs.map(async (fav) => {
        try {
          const schedule = await getDailySchedule(fav.lineCode);
          if (schedule) {
            await setCachedSchedule(fav.lineCode, schedule);
          }
        } catch {}
      }),
    );
  } catch {}
}

/* ── Offline Data — Bulk Stops (file-system backed) ──────────── */

const stopsFile = new File(Paths.document, 'oasa_all_stops.json');

/** Check if offline data has been downloaded. */
export function isOfflineDataDownloaded(): boolean {
  return _offlineDownloaded;
}

/** Get the timestamp when offline data was last downloaded. */
export async function getOfflineTimestamp(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(OFFLINE_TS_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

/** Mark offline data as downloaded (or cleared). */
export async function setOfflineDataFlag(downloaded: boolean): Promise<void> {
  _offlineDownloaded = downloaded;
  if (downloaded) {
    await AsyncStorage.setItem(OFFLINE_FLAG_KEY, '1');
    await AsyncStorage.setItem(OFFLINE_TS_KEY, String(Date.now()));
  } else {
    await AsyncStorage.removeItem(OFFLINE_FLAG_KEY);
    await AsyncStorage.removeItem(OFFLINE_TS_KEY);
  }
}

/** Get all cached stops (from file system). */
export async function getAllCachedStops(): Promise<OasaBulkStop[] | null> {
  try {
    if (!stopsFile.exists) return null;
    const raw = await stopsFile.text();
    return JSON.parse(raw) as OasaBulkStop[];
  } catch (err) {
    console.warn('[offline] Failed to read cached stops:', err);
    return null;
  }
}

/** Store all stops to the file system (~2 MB). */
export async function setAllCachedStops(stops: OasaBulkStop[]): Promise<void> {
  stopsFile.create({ overwrite: true });
  stopsFile.write(JSON.stringify(stops));
}

/** Clear all offline data. */
export async function clearOfflineData(): Promise<void> {
  // Clear consolidated file caches
  _schedCache.clear();
  _routesCache.clear();
  _routesForStopCache.clear();
  _stopsCache.clear();
  // Clear bulk stops file
  try { if (stopsFile.exists) stopsFile.delete(); } catch {}
  // Clean up old directory-based caches (backward compat from earlier versions)
  for (const name of ['oasa_schedules', 'oasa_routes', 'oasa_routes_for_stop', 'oasa_route_stops']) {
    try {
      const dir = new Directory(Paths.document, name);
      if (dir.exists) dir.delete();
    } catch {}
  }
  await setOfflineDataFlag(false);
}
