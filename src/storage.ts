/**
 * Persistent storage via AsyncStorage (Expo Go compatible).
 * Uses an in-memory mirror for synchronous reads during the session.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Directory, Paths } from 'expo-file-system';
import type { FavoriteLine, FavoriteStop, OasaLine, MapStamp, OasaDailySchedule, OasaStop, OasaBulkStop, OasaRoute } from './types';
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

/* ── Schedule Cache (file-system backed) ─────────────────────── */

const schedDir = new Directory(Paths.document, 'oasa_schedules');

/** Ensure the schedules directory exists. */
function ensureSchedDir(): void {
  if (!schedDir.exists) schedDir.create({ intermediates: true });
}

export async function getCachedSchedule(lineCode: string): Promise<OasaDailySchedule | null> {
  try {
    const f = new File(schedDir, `${lineCode}.json`);
    if (!f.exists) return null;
    const raw = await f.text();
    return JSON.parse(raw) as OasaDailySchedule;
  } catch {
    return null;
  }
}

export async function setCachedSchedule(lineCode: string, data: OasaDailySchedule): Promise<void> {
  try {
    ensureSchedDir();
    const f = new File(schedDir, `${lineCode}.json`);
    f.create({ overwrite: true });
    f.write(JSON.stringify(data));
  } catch {}
}

/* ── Routes Cache (file-system backed) ────────────────────────── */

const routesDir = new Directory(Paths.document, 'oasa_routes');

function ensureRoutesDir(): void {
  if (!routesDir.exists) routesDir.create({ intermediates: true });
}

export async function getCachedRoutes(lineCode: string): Promise<OasaRoute[] | null> {
  try {
    const f = new File(routesDir, `${lineCode}.json`);
    if (!f.exists) return null;
    const raw = await f.text();
    return JSON.parse(raw) as OasaRoute[];
  } catch {
    return null;
  }
}

export async function setCachedRoutes(lineCode: string, data: OasaRoute[]): Promise<void> {
  try {
    ensureRoutesDir();
    const f = new File(routesDir, `${lineCode}.json`);
    f.create({ overwrite: true });
    f.write(JSON.stringify(data));
  } catch {}
}

/* ── Routes-For-Stop Cache (file-system backed) ──────────────── */

const routesForStopDir = new Directory(Paths.document, 'oasa_routes_for_stop');

function ensureRoutesForStopDir(): void {
  if (!routesForStopDir.exists) routesForStopDir.create({ intermediates: true });
}

export async function getCachedRoutesForStop(stopCode: string): Promise<OasaRoute[] | null> {
  try {
    const f = new File(routesForStopDir, `${stopCode}.json`);
    if (!f.exists) return null;
    const raw = await f.text();
    return JSON.parse(raw) as OasaRoute[];
  } catch {
    return null;
  }
}

export async function setCachedRoutesForStop(stopCode: string, data: OasaRoute[]): Promise<void> {
  try {
    ensureRoutesForStopDir();
    const f = new File(routesForStopDir, `${stopCode}.json`);
    f.create({ overwrite: true });
    f.write(JSON.stringify(data));
  } catch {}
}

/* ── Route Stops Cache (file-system backed) ──────────────────── */

const stopsDir = new Directory(Paths.document, 'oasa_route_stops');

function ensureStopsDir(): void {
  if (!stopsDir.exists) stopsDir.create({ intermediates: true });
}

export async function getCachedStops(routeCode: string): Promise<OasaStop[] | null> {
  try {
    const f = new File(stopsDir, `${routeCode}.json`);
    if (!f.exists) return null;
    const raw = await f.text();
    return JSON.parse(raw) as OasaStop[];
  } catch {
    return null;
  }
}

export async function setCachedStops(routeCode: string, data: OasaStop[]): Promise<void> {
  try {
    ensureStopsDir();
    const f = new File(stopsDir, `${routeCode}.json`);
    f.create({ overwrite: true });
    f.write(JSON.stringify(data));
  } catch {}
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
  try {
    if (stopsFile.exists) stopsFile.delete();
  } catch {}
  try {
    if (schedDir.exists) schedDir.delete();
  } catch {}
  try {
    if (routesDir.exists) routesDir.delete();
  } catch {}
  try {
    if (stopsDir.exists) stopsDir.delete();
  } catch {}
  try {
    if (routesForStopDir.exists) routesForStopDir.delete();
  } catch {}
  await setOfflineDataFlag(false);
}
