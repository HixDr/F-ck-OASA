/**
 * Persistent storage via AsyncStorage (Expo Go compatible).
 * Uses an in-memory mirror for synchronous reads during the session.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Directory, Paths } from 'expo-file-system';
import type { FavoriteLine, FavoriteStop, StopLayout, OasaLine, MapStamp, OasaDailySchedule, OasaStop, OasaBulkStop, OasaRoute, OasaArrival } from '../types';
import { getDailySchedule, isUsableSchedule } from './api';
import { onAppActiveChange } from './appState';
/* The canvas's geometry defines which placements are legal, so it also owns
   turning a stored one into a legal one. Importing it here rather than
   reimplementing the quantisation means there is no path — disk, import, or a
   record written by a future build — by which a layout this app cannot draw
   reaches the screen. The module is deliberately free of React and of
   react-native, so this costs nothing at load. */
import { migrateLayout } from '../features/home/layout';

/* ── Keys ────────────────────────────────────────────────────── */

const FAVORITES_KEY = '@oasa/favorites';
const FAVORITE_STOPS_KEY = '@oasa/favorite_stops';
const LINES_CACHE_KEY = '@oasa/lines_cache';
const LINES_CACHE_TS_KEY = '@oasa/lines_cache_ts';
const STAMPS_KEY = '@oasa/stamps';
const TOGGLES_KEY = '@oasa/toggles';
const SETTINGS_KEY = '@oasa/settings';
const SCHED_TS_KEY = '@oasa/sched_ts';
const BUS_POS_PREFIX = '@oasa/buspos/';
const ARRIVALS_PREFIX = '@oasa/arrivals/';
const OFFLINE_FLAG_KEY = '@oasa/offline_downloaded';
const OFFLINE_TS_KEY = '@oasa/offline_ts';

/* ── Cache File Names ────────────────────────────────────────── */

const SCHEDULES_FILE = 'oasa_schedules.json';
const ROUTES_FILE = 'oasa_routes.json';
const ROUTES_FOR_STOP_FILE = 'oasa_routes_for_stop.json';
const ROUTE_STOPS_FILE = 'oasa_route_stops.json';
const ALL_STOPS_FILE = 'oasa_all_stops.json';
/** Deliberately absent from OFFLINE_FILES below: the offline bundle does not
 *  download shapes, so counting this file would make the bundle look incomplete
 *  forever. It fills in from ordinary use instead. */
const ROUTE_SHAPE_FILE = 'oasa_route_shapes.json';

/** Every file the offline bundle consists of. The download flag only means
 *  anything if all of them are present and non-empty. */
const OFFLINE_FILES = [
  SCHEDULES_FILE,
  ROUTES_FILE,
  ROUTES_FOR_STOP_FILE,
  ROUTE_STOPS_FILE,
  ALL_STOPS_FILE,
];

/* ── In-Memory Mirror (for synchronous access) ──────────────── */

let _favorites: FavoriteLine[] = [];
let _favoriteStops: FavoriteStop[] = [];
let _stamps: MapStamp[] = [];
let _toggles: Record<string, boolean> = {};
let _settings: Record<string, string> = {};
/** lineCode → Date.now() of the last successful schedule fetch. */
let _schedFetchedAt: Record<string, number> = {};
let _offlineDownloaded = false;
let _initialized = false;
let _appStateHooked = false;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

/**
 * Bring every saved stop's placement into the shape the canvas can draw.
 *
 * 1.2.5 is unreleased, so in practice this is a no-op for everyone: no stored
 * layout means the stop flows, full span, in order. What it exists for is the
 * layout written during 1.2.5's own development, when the horizontal axis was a
 * fraction of the width rather than a column — `migrateLayout` quantises those
 * to the nearest column, and drops anything it cannot read at all, which leaves
 * the stop flowing exactly like a newly saved one.
 *
 * Done on the way out of the JSON rather than lazily at the point of use,
 * because "the parsed mirror is always legal" is an invariant every reader here
 * and on the canvas already assumes.
 */
function migrateStopLayouts(stops: FavoriteStop[]): FavoriteStop[] {
  if (!Array.isArray(stops)) return [];
  return stops.map((st) =>
    st && st.layout ? { ...st, layout: migrateLayout(st.layout) } : st,
  );
}

/** Must be called once at app start (e.g. in _layout). */
export async function initStorage(): Promise<void> {
  if (_initialized) return;
  try {
    // One bridge round-trip instead of six sequential ones — this sits on the
    // critical path between launch and the first frame.
    const pairs = await AsyncStorage.multiGet([
      FAVORITES_KEY,
      FAVORITE_STOPS_KEY,
      STAMPS_KEY,
      TOGGLES_KEY,
      SETTINGS_KEY,
      SCHED_TS_KEY,
      OFFLINE_FLAG_KEY,
    ]);
    const blob = new Map(pairs);
    _favorites = parseJson(blob.get(FAVORITES_KEY), [] as FavoriteLine[]);
    _favoriteStops = migrateStopLayouts(
      parseJson(blob.get(FAVORITE_STOPS_KEY), [] as FavoriteStop[]),
    );
    _stamps = parseJson(blob.get(STAMPS_KEY), [] as MapStamp[]);
    _toggles = parseJson(blob.get(TOGGLES_KEY), {} as Record<string, boolean>);
    _settings = parseJson(blob.get(SETTINGS_KEY), {} as Record<string, string>);
    _schedFetchedAt = parseJson(blob.get(SCHED_TS_KEY), {} as Record<string, number>);
    _offlineDownloaded = blob.get(OFFLINE_FLAG_KEY) === '1';
  } catch {
    // A wiped/locked AsyncStorage must not brick the launch; every mirror keeps
    // its declared default and the screens degrade to empty state.
  }

  // The flag claims the whole offline bundle is on disk. If any file is gone or
  // was truncated by a kill mid-write, clearing it is the only way out: the
  // runtime cache writers short-circuit while it's set, so a broken bundle
  // would otherwise never repopulate and never be re-downloaded either.
  if (_offlineDownloaded && !offlineBundleIntact()) {
    _offlineDownloaded = false;
    AsyncStorage.removeItem(OFFLINE_FLAG_KEY).catch(() => {});
  }

  if (!_appStateHooked) {
    _appStateHooked = true;
    // Debounced writers can hold up to a second of unsaved state and Android
    // kills backgrounded apps without further warning.
    onAppActiveChange((active) => {
      if (!active) void flushPendingWrites();
    });
  }

  _initialized = true;
  // Fire-and-forget: never delay the first frame for housekeeping.
  void pruneTimestampedCaches();
}

/** True when every offline cache file exists and holds more than `{}`. */
function offlineBundleIntact(): boolean {
  try {
    for (const name of OFFLINE_FILES) {
      const f = new File(Paths.document, name);
      recoverTempFile(f);
      if (!f.exists || f.size <= 2) return false;
    }
    return true;
  } catch (err) {
    // `exists`/`size` are synchronous native calls and can throw. We cannot
    // vouch for the bundle, and an unverifiable flag is worse than a re-download.
    console.warn('[storage] Offline bundle check failed:', err);
    return false;
  }
}

/* ── Write Queue ─────────────────────────────────────────────── */

/**
 * Every AsyncStorage blob write goes through one chain.
 *
 * These keys hold whole collections, so two callers doing read-modify-write
 * concurrently used to lose one of the updates. Queuing the *serialiser* rather
 * than the serialised string means each write re-reads the current mirror at
 * flush time, and the chain guarantees an older payload can never land after a
 * newer one.
 */
const _pendingBlobs = new Map<string, () => string>();
let _blobTimer: ReturnType<typeof setTimeout> | null = null;
let _writeChain: Promise<void> = Promise.resolve();

/** Coalescing window for high-frequency writers (the hue slider fires ~60×/s). */
const BLOB_DEBOUNCE_MS = 400;

function flushBlobs(): Promise<void> {
  if (_blobTimer) { clearTimeout(_blobTimer); _blobTimer = null; }
  if (_pendingBlobs.size === 0) return _writeChain;
  const entries: [string, string][] = [];
  for (const [key, serialize] of _pendingBlobs) {
    try { entries.push([key, serialize()]); } catch {}
  }
  _pendingBlobs.clear();
  _writeChain = _writeChain
    .then(() => AsyncStorage.multiSet(entries))
    .then(() => {})
    .catch(() => {});
  return _writeChain;
}

/** Queue a blob write. `debounce` batches bursts from the same key. */
function queueBlobWrite(key: string, serialize: () => string, debounce = false): void {
  _pendingBlobs.set(key, serialize);
  if (!debounce) { void flushBlobs(); return; }
  if (!_blobTimer) _blobTimer = setTimeout(() => { void flushBlobs(); }, BLOB_DEBOUNCE_MS);
}

/**
 * Force every debounced write (AsyncStorage blobs and dict-cache files) to disk.
 * Called automatically when the app backgrounds; exported for callers that need
 * a hard checkpoint (e.g. before exporting user data).
 */
export async function flushPendingWrites(): Promise<void> {
  for (const cache of _dictCaches) {
    try { cache.flushNow(); } catch {}
  }
  await flushBlobs();
}

/* ── Atomic File Writes ──────────────────────────────────────── */

/**
 * Write a file via a temp copy plus a rename.
 *
 * `create({ overwrite: true })` deletes and recreates the target and `write()`
 * truncates — both synchronous. A kill in that window left a zero-length file
 * which parsed as an empty dict on the next launch, and because the download
 * flag was still set nothing ever repopulated it. Renaming means the target is
 * only ever whole or absent, and `recoverTempFile` closes the remaining gap.
 */
function writeFileAtomic(target: File, contents: string): void {
  // move() rewrites the instance's own uri, so the temp handle is single-use.
  const tmp = new File(target.parentDirectory, target.name + '.tmp');
  tmp.write(contents);
  if (target.exists) target.delete();
  tmp.move(target);
}

/** Adopt a `.tmp` left behind by a kill between the delete and the rename. */
function recoverTempFile(target: File): void {
  try {
    if (target.exists) return;
    const tmp = new File(target.parentDirectory, target.name + '.tmp');
    if (tmp.exists) tmp.move(target);
  } catch {}
}

function deleteTempFile(target: File): void {
  try {
    const tmp = new File(target.parentDirectory, target.name + '.tmp');
    if (tmp.exists) tmp.delete();
  } catch {}
}

/* ── Favorites (sync reads from mirror, async writes) ────────── */

export function getFavorites(): FavoriteLine[] {
  return _favorites;
}

function persistFavorites(): void {
  queueBlobWrite(FAVORITES_KEY, () => JSON.stringify(_favorites));
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

/**
 * Reorder saved lines to match `codes` — the line grid on Home can be dragged
 * into the order the user actually rides.
 *
 * Same contract as `reorderFavoriteStops`: codes that no longer exist are
 * ignored, and any line missing from `codes` is kept and appended, so a stale
 * list from the UI can never silently delete a saved line.
 */
export function reorderFavorites(codes: string[]): FavoriteLine[] {
  const byCode = new Map(_favorites.map((f) => [f.lineCode, f]));
  const ordered: FavoriteLine[] = [];
  for (const code of codes) {
    const line = byCode.get(code);
    if (line) {
      ordered.push(line);
      byCode.delete(code);
    }
  }
  for (const leftover of byCode.values()) ordered.push(leftover);
  _favorites = ordered;
  persistFavorites();
  return _favorites;
}

/* ── Favorite Stops (sync reads from mirror, async writes) ──── */

export function getFavoriteStops(): FavoriteStop[] {
  return _favoriteStops;
}

function persistFavoriteStops(): void {
  queueBlobWrite(FAVORITE_STOPS_KEY, () => JSON.stringify(_favoriteStops));
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

/**
 * Reorder saved stops to match `codes`, so the stop you use every morning can
 * be pinned to the top instead of being stuck in bookmark order.
 *
 * Codes that no longer exist are ignored, and any stop missing from `codes` is
 * kept and appended — a stale list from the UI must never silently delete a
 * saved stop.
 */
export function reorderFavoriteStops(codes: string[]): FavoriteStop[] {
  const byCode = new Map(_favoriteStops.map((s) => [s.stopCode, s]));
  const ordered: FavoriteStop[] = [];
  for (const code of codes) {
    const stop = byCode.get(code);
    if (stop) {
      ordered.push(stop);
      byCode.delete(code);
    }
  }
  for (const leftover of byCode.values()) ordered.push(leftover);
  _favoriteStops = ordered;
  persistFavoriteStops();
  return _favoriteStops;
}

export function updateFavoriteStop(stopCode: string, patch: Partial<FavoriteStop>): FavoriteStop[] {
  _favoriteStops = _favoriteStops.map((s) =>
    s.stopCode === stopCode ? { ...s, ...patch } : s,
  );
  persistFavoriteStops();
  return _favoriteStops;
}

/**
 * The same, for several stops at once.
 *
 * Home's canvas needs this: the first time a card is picked up, every stop that
 * had no saved placement is frozen at the box it is currently occupying, so one
 * gesture writes the whole set. Calling `updateFavoriteStop` in a loop would
 * rebuild the array once per stop and enqueue a flush each time, for a single
 * user action.
 */
export function updateFavoriteStops(
  patches: ReadonlyMap<string, Partial<FavoriteStop>>,
): FavoriteStop[] {
  if (patches.size === 0) return _favoriteStops;
  _favoriteStops = _favoriteStops.map((s) => {
    const patch = patches.get(s.stopCode);
    return patch ? { ...s, ...patch } : s;
  });
  persistFavoriteStops();
  return _favoriteStops;
}

/* ── Lines Cache ─────────────────────────────────────────────── */

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
/** Offline users tolerate a stale catalogue, but not a permanently frozen one:
 *  an infinite TTL meant new or renamed lines never showed up again. */
const OFFLINE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function getCachedLines(): Promise<OasaLine[] | null> {
  try {
    const [[, tsRaw], [, raw]] = await AsyncStorage.multiGet([LINES_CACHE_TS_KEY, LINES_CACHE_KEY]);
    if (!tsRaw || !raw) return null;
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts)) return null;
    const ttl = _offlineDownloaded ? OFFLINE_CACHE_TTL : CACHE_TTL;
    if (Date.now() - ts > ttl) return null;
    const parsed = JSON.parse(raw);
    /* An empty catalogue is a miss, not a hit. Callers test the result for
       truth — `if (cached) return cached` — and `[]` is truthy, so returning
       one parks every LineCode → LineID lookup on a map with nothing in it
       and stops the network from ever being asked again until the TTL runs
       out. That does not blank the badges: it renders the internal LineCode
       where the rider expects the number on the front of the bus, 937 for
       140. `setCachedLines` will not write one, and this will not serve one. */
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as OasaLine[];
  } catch {
    return null;
  }
}

export async function setCachedLines(lines: OasaLine[]): Promise<void> {
  /* Never persist an empty catalogue. `api()` maps an empty, `""` or `null`
     body to `[]` for array endpoints — the right answer for "no arrivals right
     now", a total loss for the line catalogue — so one blank response used to
     land `[]` on disk with a fresh timestamp and poison every badge in the app
     for a day, or a week with the offline bundle downloaded. Keeping the older
     good copy is strictly better than replacing it with nothing. */
  if (!Array.isArray(lines) || lines.length === 0) return;
  try {
    await AsyncStorage.multiSet([
      [LINES_CACHE_KEY, JSON.stringify(lines)],
      [LINES_CACHE_TS_KEY, String(Date.now())],
    ]);
  } catch {
    // Silently fail — cache is best-effort
  }
}

/**
 * Drop the cached line catalogue so the next read goes to the network.
 *
 * For when the catalogue on disk turns out not to name the LineCodes the route
 * lists actually reference. That is not a miss the TTL can fix — the copy is
 * inside its window and simply wrong about the network — so the only way back
 * is to throw it away. `useCatalogueHeal` is the caller, once per session.
 */
export async function clearCachedLines(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([LINES_CACHE_KEY, LINES_CACHE_TS_KEY]);
  } catch {
    // Best-effort — a failure here just means the stale copy lives out its TTL.
  }
}

/* ── Map Stamps (sync reads from mirror, async writes) ───────── */

export function getStamps(): MapStamp[] {
  return _stamps;
}

function persistStamps(): void {
  queueBlobWrite(STAMPS_KEY, () => JSON.stringify(_stamps));
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
  queueBlobWrite(TOGGLES_KEY, () => JSON.stringify(_toggles));
}

/* ── App Settings (sync reads from mirror, async writes) ─────── */

export function getSetting(key: string, fallback: string): string {
  return _settings[key] ?? fallback;
}

export function setSetting(key: string, value: string): void {
  _settings[key] = value;
  // Debounced: colour sliders drag this at frame rate, and each write
  // re-serialises the whole settings blob.
  queueBlobWrite(SETTINGS_KEY, () => JSON.stringify(_settings), true);
}

/* ── Consolidated File Caches (single file + in-memory dict) ─── */

interface DictCacheHandle {
  /** Write any debounced changes out synchronously. */
  flushNow(): boolean;
}

const _dictCaches: DictCacheHandle[] = [];

/** Debounce for runtime single-key writes — the backing files are megabytes. */
const DICT_PERSIST_DEBOUNCE_MS = 1000;

/**
 * Key-value cache backed by a single JSON file on disk.
 * - In-memory dict loaded lazily on first access (deduplicates concurrent loads).
 * - Runtime writes are debounced (1 s) to avoid blocking the JS thread on large files.
 * - Bulk writes (used by the download orchestrator) are immediate and atomic.
 */
function createDictCache<T>(fileName: string) {
  const file = new File(Paths.document, fileName);
  let _dict: Record<string, T> | null = null;
  let _loading: Promise<Record<string, T>> | null = null;
  let _persistTimer: ReturnType<typeof setTimeout> | null = null;
  // Bumped by clear()/setBulk(). A load() started before the bump has read
  // pre-bump contents, so its result must be dropped rather than installed —
  // otherwise a slow load resurrects deleted data and the next set() writes it
  // back to disk.
  let _generation = 0;

  async function load(): Promise<Record<string, T>> {
    if (_dict) return _dict;
    if (_loading) return _loading;
    const gen = _generation;
    _loading = (async () => {
      let parsed: Record<string, T> | null = null;
      try {
        recoverTempFile(file);
        if (file.exists) {
          const raw = JSON.parse(await file.text());
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) parsed = raw as Record<string, T>;
        }
      } catch (err) {
        // Corrupt file. initStorage's integrity check has already cleared the
        // download flag, so the runtime writers are free to refill this.
        console.warn(`[storage] Failed to read ${fileName}:`, err);
      }
      // Superseded by a clear()/setBulk() while we were reading.
      if (gen !== _generation) return load();
      _dict = parsed ?? {};
      _loading = null;
      return _dict;
    })();
    return _loading;
  }

  /** Returns false when the data did not reach disk. */
  function persistNow(): boolean {
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
    if (!_dict) return true;
    try {
      writeFileAtomic(file, JSON.stringify(_dict));
      return true;
    } catch (err) {
      console.warn(`[storage] Failed to persist ${fileName}:`, err);
      return false;
    }
  }

  function persistDebounced(): void {
    if (_persistTimer) clearTimeout(_persistTimer);
    _persistTimer = setTimeout(persistNow, DICT_PERSIST_DEBOUNCE_MS);
  }

  const cache = {
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
    /**
     * Replace the whole dict and write it out immediately.
     *
     * The in-memory copy is dropped afterwards: the download orchestrator holds
     * several of these dicts at once and keeping every one resident is what put
     * peak RSS through the roof. Readers page it back in lazily.
     * Returns false if the write did not reach disk.
     */
    setBulk: (all: Record<string, T>): boolean => {
      _generation++;
      if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
      _dict = all;
      _loading = null;
      const ok = persistNow();
      _dict = null;
      return ok;
    },
    flushNow: (): boolean => (_persistTimer ? persistNow() : true),
    clear: (): void => {
      _generation++;
      if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
      _dict = null;
      _loading = null;
      try { if (file.exists) file.delete(); } catch {}
      deleteTempFile(file);
    },
  };

  _dictCaches.push(cache);
  return cache;
}

const _schedCache = createDictCache<OasaDailySchedule>(SCHEDULES_FILE);
const _routesCache = createDictCache<OasaRoute[]>(ROUTES_FILE);
const _routesForStopCache = createDictCache<OasaRoute[]>(ROUTES_FOR_STOP_FILE);
const _stopsCache = createDictCache<OasaStop[]>(ROUTE_STOPS_FILE);
/** One entry per route direction — see the Route Shape Cache section below. */
export interface ShapePoint { lat: number; lng: number }
const _shapeCache = createDictCache<ShapePoint[]>(ROUTE_SHAPE_FILE);

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

export async function setCachedSchedule(lineCode: string, data: OasaDailySchedule): Promise<void> {
  // An object with two empty arrays is not worth persisting, and because it is
  // truthy it would be preferred over the good cached copy forever after.
  if (!isUsableSchedule(data)) return;
  await _schedCache.set(lineCode, data);
  _schedFetchedAt[lineCode] = Date.now();
  queueBlobWrite(SCHED_TS_KEY, () => JSON.stringify(_schedFetchedAt), true);
}

export function setCachedSchedulesBulk(data: Record<string, OasaDailySchedule>): boolean {
  const now = Date.now();
  const usable: Record<string, OasaDailySchedule> = {};
  for (const [code, schedule] of Object.entries(data)) {
    if (!isUsableSchedule(schedule)) continue;
    usable[code] = schedule;
    _schedFetchedAt[code] = now;
  }
  queueBlobWrite(SCHED_TS_KEY, () => JSON.stringify(_schedFetchedAt));
  return _schedCache.setBulk(usable);
}

/* ── Routes Cache ────────────────────────────────────────────── */

export function getCachedRoutes(lineCode: string): Promise<OasaRoute[] | null> {
  return _routesCache.get(lineCode);
}

export function setCachedRoutes(lineCode: string, data: OasaRoute[]): Promise<void> {
  return _routesCache.set(lineCode, data);
}

export function setCachedRoutesBulk(data: Record<string, OasaRoute[]>): boolean {
  return _routesCache.setBulk(data);
}

/* ── Routes-For-Stop Cache ───────────────────────────────────── */

export function getCachedRoutesForStop(stopCode: string): Promise<OasaRoute[] | null> {
  return _routesForStopCache.get(stopCode);
}

export function setCachedRoutesForStop(stopCode: string, data: OasaRoute[]): Promise<void> {
  /* This used to drop every write while the offline bundle flag was set, to
     avoid re-serializing a large dict. `createDictCache` has no TTL, so the
     effect was an entry frozen on disk for the life of the install: a stop's
     route list captured at download time, still being served months later,
     still naming LineCodes the catalogue has since dropped. Nothing could
     correct it — not a refetch, not a restart, only clearing app storage.

     Writes are debounced (`persistDebounced`), so letting fresh data through
     costs one coalesced serialization rather than one per stop viewed. That is
     the price of a cache that can be wrong and then stop being wrong. */
  return _routesForStopCache.set(stopCode, data);
}

export function setCachedRoutesForStopBulk(data: Record<string, OasaRoute[]>): boolean {
  return _routesForStopCache.setBulk(data);
}

/* ── Route Stops Cache ───────────────────────────────────────── */

export function getCachedStops(routeCode: string): Promise<OasaStop[] | null> {
  return _stopsCache.get(routeCode);
}

export function setCachedStops(routeCode: string, data: OasaStop[]): Promise<void> {
  // Same reasoning as setCachedRoutesForStop above: an untouchable entry is
  // worse than a re-serialization, because there is no way out of a wrong one.
  return _stopsCache.set(routeCode, data);
}

export function setCachedStopsBulk(data: Record<string, OasaStop[]>): boolean {
  return _stopsCache.setBulk(data);
}

/* ── Route Shape Cache ───────────────────────────────────────── */

/**
 * The drawn polyline for a route, already simplified.
 *
 * This was the one payload of a map open that nothing cached — not even the
 * offline bundle — so every open re-fetched the largest response on the screen
 * (300-1500 shape points, plus the stop list riding along in the same reply)
 * and the polyline was the one thing that could never work offline.
 *
 * Simplified points are what gets stored, not raw: the warm path then skips the
 * Douglas-Peucker pass as well, and the file is a fifth of the size.
 */
export function getCachedRouteShape(routeCode: string): Promise<ShapePoint[] | null> {
  return _shapeCache.get(routeCode);
}

export function setCachedRouteShape(routeCode: string, pts: ShapePoint[]): Promise<void> {
  // No `_offlineDownloaded` guard, unlike the caches above: the bulk download
  // never writes shapes, so skipping runtime writes would leave this empty for
  // exactly the users who most want the map to work offline.
  return _shapeCache.set(routeCode, pts);
}

/* ── Last-Known Bus Positions Cache ──────────────────────────── */

export interface CachedBusPositions {
  ts: number; // Date.now() when saved
  buses: Array<{ lat: number; lng: number; id: string }>;
}

/** Positions older than this are never shown, so keeping them is pure bloat. */
const BUS_POS_MAX_AGE_MS = 60 * 60 * 1000;

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

/* ── Last-Known Arrivals Cache ───────────────────────────────── */

export interface CachedArrivals {
  /**
   * `Date.now()` at the moment this response came off the *network*.
   *
   * Not when it was read back, and deliberately not something the reader can
   * infer: every minute the UI subtracts from an arrival estimate is measured
   * from here. Serving these numbers without their original timestamp is what
   * turns a twenty-minute-old "5 min" into a confident lie about a bus that
   * has already been and gone.
   */
  ts: number;
  arrivals: OasaArrival[];
}

/**
 * How long a saved arrival estimate is worth anything.
 *
 * An estimate only decays; it never improves. Past half an hour every
 * prediction we could be holding has run below zero, so the cache would have
 * nothing left to say except "every bus is arriving now" about buses that
 * left — worse than showing nothing. Half an hour is also roughly two headways
 * on a typical Athens line, and comfortably covers the gaps this exists for: a
 * metro leg, a basement, a tunnel, a dead spot on the walk to the stop.
 */
const ARRIVALS_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Last-known arrivals for a stop, or null.
 *
 * The age check is here rather than only in the pruner because the pruner runs
 * once at launch: a session that started an hour ago would otherwise still be
 * served entries it read past their bound. An expired entry returns null so it
 * behaves exactly like no cache at all — never as data a caller might weigh up.
 */
export async function getCachedArrivals(stopCode: string): Promise<CachedArrivals | null> {
  try {
    const raw = await AsyncStorage.getItem(ARRIVALS_PREFIX + stopCode);
    if (!raw) return null;
    const data = JSON.parse(raw) as CachedArrivals;
    if (!data || !Number.isFinite(data.ts) || !Array.isArray(data.arrivals)) return null;
    if (Date.now() - data.ts > ARRIVALS_MAX_AGE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Save the arrivals just seen at a stop.
 *
 * Called on every successful poll — roughly once per saved stop per 15 s — so
 * that whenever the connection drops the saved copy is at most one poll old,
 * which is the whole point of it. The payload is a handful of short strings;
 * fire-and-forget, like the bus positions above.
 *
 * An empty response is stored rather than skipped. "Nothing is due here" is a
 * real observation, and keeping it means a later cache read cannot resurrect
 * numbers the network has already superseded.
 */
export function setCachedArrivals(stopCode: string, arrivals: OasaArrival[]): void {
  const data: CachedArrivals = { ts: Date.now(), arrivals };
  AsyncStorage.setItem(ARRIVALS_PREFIX + stopCode, JSON.stringify(data)).catch(() => {});
}

/**
 * Drop expired `@oasa/buspos/*` and `@oasa/arrivals/*` entries.
 *
 * One key is written per route the user ever opens and one per stop they ever
 * watch, and nothing removed them, so the table grew without bound over the
 * app's lifetime for data that is dead within the hour.
 */
async function pruneTimestampedCaches(): Promise<void> {
  try {
    const bounds: Array<[string, number]> = [
      [BUS_POS_PREFIX, BUS_POS_MAX_AGE_MS],
      [ARRIVALS_PREFIX, ARRIVALS_MAX_AGE_MS],
    ];
    const keys = (await AsyncStorage.getAllKeys()).filter((k) =>
      bounds.some(([prefix]) => k.startsWith(prefix)),
    );
    if (keys.length === 0) return;
    const now = Date.now();
    const stale: string[] = [];
    for (const [key, raw] of await AsyncStorage.multiGet(keys)) {
      if (!raw) { stale.push(key); continue; }
      const maxAge = bounds.find(([prefix]) => key.startsWith(prefix))![1];
      try {
        const ts = (JSON.parse(raw) as { ts?: number })?.ts;
        if (!Number.isFinite(ts) || now - (ts as number) > maxAge) stale.push(key);
      } catch {
        stale.push(key);
      }
    }
    if (stale.length > 0) await AsyncStorage.multiRemove(stale);
  } catch {
    // Housekeeping only — never surface.
  }
}

/* ── Prefetch Favorite Schedules ─────────────────────────────── */

/** Schedules are per service day; refetching more often than this is waste. */
const SCHED_PREFETCH_TTL = 6 * 60 * 60 * 1000;

/**
 * Fetch and cache today's schedules for all favorited lines.
 * Runs silently — errors are swallowed so it never blocks the app.
 * Lines fetched recently are skipped: this used to re-hit the API for every
 * favorite on every cold start.
 */
export async function prefetchFavoriteSchedules(opts: { signal?: AbortSignal } = {}): Promise<void> {
  try {
    const cutoff = Date.now() - SCHED_PREFETCH_TTL;
    const stale = getFavorites().filter((f) => (_schedFetchedAt[f.lineCode] ?? 0) < cutoff);
    if (stale.length === 0) return;

    await Promise.allSettled(
      stale.map(async (fav) => {
        try {
          const schedule = await getDailySchedule(fav.lineCode, opts);
          // setCachedSchedule re-checks, but skipping early avoids the write queue.
          if (isUsableSchedule(schedule)) await setCachedSchedule(fav.lineCode, schedule);
        } catch {}
      }),
    );
  } catch {}
}

/* ── Offline Data — Bulk Stops (file-system backed) ──────────── */

const stopsFile = new File(Paths.document, ALL_STOPS_FILE);

/** Parsed mirror of `stopsFile`. Re-reading and re-parsing ~2 MB on every trip
 *  plan (and every ~110 m walked) was one of the app's worst hot paths. */
let _allStopsMemo: OasaBulkStop[] | null = null;
let _allStopsLoading: Promise<OasaBulkStop[] | null> | null = null;
/** Bumped on write/clear so a read that started earlier can't install what it
 *  found over data that has since been replaced or deleted. */
let _allStopsGen = 0;

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
    await AsyncStorage.multiSet([
      [OFFLINE_FLAG_KEY, '1'],
      [OFFLINE_TS_KEY, String(Date.now())],
    ]);
  } else {
    await AsyncStorage.multiRemove([OFFLINE_FLAG_KEY, OFFLINE_TS_KEY]);
  }
}

/** Get all cached stops (from file system, memoized after the first read). */
export function getAllCachedStops(): Promise<OasaBulkStop[] | null> {
  if (_allStopsMemo) return Promise.resolve(_allStopsMemo);
  if (_allStopsLoading) return _allStopsLoading;
  const gen = _allStopsGen;
  const read = async (): Promise<OasaBulkStop[] | null> => {
    try {
      recoverTempFile(stopsFile);
      if (!stopsFile.exists) return null;
      const parsed = JSON.parse(await stopsFile.text());
      if (!Array.isArray(parsed)) return null;
      // Superseded by a write or a clear while we were reading.
      if (gen !== _allStopsGen) return _allStopsMemo;
      _allStopsMemo = parsed as OasaBulkStop[];
      return _allStopsMemo;
    } catch (err) {
      console.warn('[offline] Failed to read cached stops:', err);
      return null;
    }
  };
  const pending = read().finally(() => {
    if (_allStopsLoading === pending) _allStopsLoading = null;
  });
  _allStopsLoading = pending;
  return pending;
}

/** Store all stops to the file system (~2 MB). Throws if the write fails. */
export async function setAllCachedStops(stops: OasaBulkStop[]): Promise<void> {
  writeFileAtomic(stopsFile, JSON.stringify(stops));
  // Invalidate rather than adopt: the only caller is the download orchestrator,
  // which wants to drop its own reference straight after to keep peak RSS down.
  _allStopsGen++;
  _allStopsMemo = null;
}

/**
 * Consumers that derive long-lived in-memory structures from the offline data
 * and need to drop them when it is cleared.
 *
 * This is a listener registry rather than a direct call so that `storage`
 * stays a leaf module — having a service import from `features/` would invert
 * the layering, and it would also drag the planner's index code into the
 * bundle for users who never open the planner.
 */
const _offlineClearedListeners = new Set<() => void>();

/** Register a callback invoked when offline data is cleared. Returns an
 *  unsubscribe fn. Safe to call from a module's top level. */
export function onOfflineDataCleared(fn: () => void): () => void {
  _offlineClearedListeners.add(fn);
  return () => { _offlineClearedListeners.delete(fn); };
}

/** Clear all offline data. */
export async function clearOfflineData(): Promise<void> {
  // Clear consolidated file caches
  _schedCache.clear();
  _routesCache.clear();
  _routesForStopCache.clear();
  _stopsCache.clear();
  // Clear bulk stops file
  _allStopsGen++;
  _allStopsMemo = null;
  _allStopsLoading = null;
  try { if (stopsFile.exists) stopsFile.delete(); } catch {}
  deleteTempFile(stopsFile);
  // Clean up old directory-based caches (backward compat from earlier versions)
  for (const name of ['oasa_schedules', 'oasa_routes', 'oasa_routes_for_stop', 'oasa_route_stops']) {
    try {
      const dir = new Directory(Paths.document, name);
      if (dir.exists) dir.delete();
    } catch {}
  }
  await setOfflineDataFlag(false);
}

/* ── User Data Export / Import ───────────────────────────────── */

/**
 * Everything the user actually created, in one portable blob.
 *
 * A change of signing key forces an uninstall/reinstall, which wipes
 * AsyncStorage; without this the user silently loses every favourite.
 */
export interface UserDataExport {
  version: number;
  exportedAt: string;
  favorites: FavoriteLine[];
  favoriteStops: FavoriteStop[];
  stamps: MapStamp[];
  settings: Record<string, string>;
  toggles: Record<string, boolean>;
}

export const USER_DATA_VERSION = 1;

export async function exportUserData(): Promise<string> {
  // Make sure the debounced settings write can't be lost between export and a
  // subsequent uninstall — the exported copy should match what's on disk.
  await flushPendingWrites();
  const payload: UserDataExport = {
    version: USER_DATA_VERSION,
    exportedAt: new Date().toISOString(),
    favorites: _favorites,
    favoriteStops: _favoriteStops,
    stamps: _stamps,
    settings: _settings,
    toggles: _toggles,
  };
  return JSON.stringify(payload, null, 2);
}

export interface ImportResult {
  ok: boolean;
  error?: string;
  imported: { favorites: number; stops: number; stamps: number };
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function validFavorite(v: unknown): FavoriteLine | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isStr(o.lineCode)) return null;
  return {
    lineCode: o.lineCode,
    lineId: isStr(o.lineId) ? o.lineId : o.lineCode,
    lineDescr: isStr(o.lineDescr) ? o.lineDescr : '',
    lineDescrEng: isStr(o.lineDescrEng) ? o.lineDescrEng : '',
  };
}

/**
 * A card placement from an imported backup.
 *
 * The same funnel the disk path uses, for the same reason: a backup can carry a
 * placement from any build of this app, including the fractional one 1.2.5 was
 * developed with, and the canvas has exactly one legal shape. `migrateLayout`
 * rejects rather than repairs whatever it cannot read — a NaN or a negative
 * height reaching the canvas is a card that cannot be seen, cannot be hit and
 * cannot be dragged back, and dropping the field just makes the stop flow full
 * span like a newly saved one.
 */
function validStopLayout(v: unknown): StopLayout | null {
  return migrateLayout(v);
}

function validFavoriteStop(v: unknown): FavoriteStop | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isStr(o.stopCode) || !isNum(o.lat) || !isNum(o.lng)) return null;
  const lines = Array.isArray(o.visibleLines) ? o.visibleLines.filter(isStr) : null;
  return {
    stopCode: o.stopCode,
    stopName: isStr(o.stopName) ? o.stopName : o.stopCode,
    lat: o.lat,
    lng: o.lng,
    visibleLines: lines,
    layout: validStopLayout(o.layout),
  };
}

function validStamp(v: unknown): MapStamp | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isNum(o.lat) || !isNum(o.lng)) return null;
  return {
    id: isStr(o.id) ? o.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: isStr(o.name) ? o.name : 'Stamp',
    emoji: isStr(o.emoji) ? o.emoji : '📍',
    lat: o.lat,
    lng: o.lng,
  };
}

/**
 * Restore a blob produced by `exportUserData`.
 *
 * The input is user-supplied text (a pasted file, a share-sheet payload), so
 * every field is validated and anything unrecognised is dropped rather than
 * trusted. Merges into the existing data — importing never removes what's
 * already there, and existing settings/toggles win over imported ones so a
 * restore can't silently undo the user's current preferences.
 * Never throws; failures come back as `{ ok: false, error }`.
 */
export async function importUserData(json: string): Promise<ImportResult> {
  const imported = { favorites: 0, stops: 0, stamps: 0 };
  try {
    if (typeof json !== 'string' || json.trim().length === 0) {
      return { ok: false, error: 'Empty file', imported };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ok: false, error: 'Not a valid backup file', imported };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'Not a valid backup file', imported };
    }
    const data = parsed as Record<string, unknown>;
    if (isNum(data.version) && data.version > USER_DATA_VERSION) {
      return { ok: false, error: 'Backup was made by a newer version of the app', imported };
    }

    /* Favorites — keyed by lineCode, existing entries kept. */
    const favSeen = new Set(_favorites.map((f) => f.lineCode));
    const nextFavs = [..._favorites];
    for (const raw of asArray(data.favorites)) {
      const fav = validFavorite(raw);
      if (!fav || favSeen.has(fav.lineCode)) continue;
      favSeen.add(fav.lineCode);
      nextFavs.push(fav);
      imported.favorites++;
    }

    /* Favorite stops — keyed by stopCode. */
    const stopSeen = new Set(_favoriteStops.map((s) => s.stopCode));
    const nextStops = [..._favoriteStops];
    for (const raw of asArray(data.favoriteStops)) {
      const stop = validFavoriteStop(raw);
      if (!stop || stopSeen.has(stop.stopCode)) continue;
      stopSeen.add(stop.stopCode);
      nextStops.push(stop);
      imported.stops++;
    }

    /* Stamps — keyed by id, then by position so a re-import isn't duplicated. */
    const stampSeen = new Set(_stamps.map((s) => s.id));
    const stampAt = new Set(_stamps.map((s) => `${s.lat.toFixed(5)},${s.lng.toFixed(5)}`));
    const nextStamps = [..._stamps];
    for (const raw of asArray(data.stamps)) {
      const stamp = validStamp(raw);
      if (!stamp) continue;
      const at = `${stamp.lat.toFixed(5)},${stamp.lng.toFixed(5)}`;
      if (stampSeen.has(stamp.id) || stampAt.has(at)) continue;
      stampSeen.add(stamp.id);
      stampAt.add(at);
      nextStamps.push(stamp);
      imported.stamps++;
    }

    /* Settings + toggles — fill gaps only. */
    let recognised =
      Array.isArray(data.favorites) || Array.isArray(data.favoriteStops) || Array.isArray(data.stamps);
    const nextSettings = { ..._settings };
    const rawSettings = data.settings;
    if (rawSettings && typeof rawSettings === 'object' && !Array.isArray(rawSettings)) {
      recognised = true;
      for (const [k, v] of Object.entries(rawSettings as Record<string, unknown>)) {
        if (isStr(v) && nextSettings[k] === undefined) nextSettings[k] = v;
      }
    }
    const nextToggles = { ..._toggles };
    const rawToggles = data.toggles;
    if (rawToggles && typeof rawToggles === 'object' && !Array.isArray(rawToggles)) {
      recognised = true;
      for (const [k, v] of Object.entries(rawToggles as Record<string, unknown>)) {
        if (typeof v === 'boolean' && nextToggles[k] === undefined) nextToggles[k] = v;
      }
    }

    // Nothing we know how to read — almost certainly the wrong file.
    if (!recognised) return { ok: false, error: 'Not a valid backup file', imported };

    _favorites = nextFavs;
    _favoriteStops = nextStops;
    _stamps = nextStamps;
    _settings = nextSettings;
    _toggles = nextToggles;

    queueBlobWrite(FAVORITES_KEY, () => JSON.stringify(_favorites));
    queueBlobWrite(FAVORITE_STOPS_KEY, () => JSON.stringify(_favoriteStops));
    queueBlobWrite(STAMPS_KEY, () => JSON.stringify(_stamps));
    queueBlobWrite(SETTINGS_KEY, () => JSON.stringify(_settings));
    queueBlobWrite(TOGGLES_KEY, () => JSON.stringify(_toggles));
    await flushBlobs();

    return { ok: true, imported };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Import failed',
      imported,
    };
  }
}
