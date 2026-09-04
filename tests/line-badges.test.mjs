/**
 * A bus badge must never print an internal code.
 *
 * Every badge in the app is a LineID — the number on the front of the bus.
 * It is resolved by looking the route's LineCode up in the catalogue from
 * `webGetLines`. When that lookup missed, the badge fell back to the LineCode
 * itself: `lineInfo?.LineID ?? r.LineCode`. That does not read as an error, it
 * reads as a bus. 937 where 140 belongs, 1173 where 237 belongs — a wrong
 * number the rider cannot tell from a right one by looking at it.
 *
 * The fallback was never safe, because the two lists it joins are not
 * guaranteed to agree. Measured against the live API on 2026-09-04: stop
 * 240001 lists routes for LineCodes 1298, 1299 and 1300, and `webGetLines`
 * contains none of them. So a clean install with a perfect network renders
 * three fake bus numbers at that stop today. No cache involved.
 *
 * A stale catalogue on disk produced the same thing at any stop, which is what
 * clearing app storage fixed.
 *
 * So: an unresolved LineCode is not a name. It is the absence of one, it is
 * typed as such, and the UI says so rather than inventing a number. The app
 * also gets one chance per session to repair a catalogue that turned out not
 * to name what the routes reference.
 *
 * Source invariants, for the reason `api-transport.test.mjs` gives: these
 * modules do not import under node's type stripping.
 *
 * Run with `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const decomment = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');

const MAP_UTILS = decomment(read('src/features/map/mapUtils.ts'));
const TRIP = decomment(read('src/features/planner/tripExtraction.ts'));
const STORAGE = decomment(read('src/services/storage.ts'));
const LINES_MAP = decomment(read('src/hooks/useLinesMap.ts'));

/* ── The badge itself ───────────────────────────────────────── */

test('buildLineGroups does not name a line after its internal code', () => {
  assert.doesNotMatch(
    MAP_UTILS,
    /LineID\s*\?\?\s*r?\.?\w*[Ll]ineCode/,
    'buildLineGroups still falls back to the LineCode when the catalogue ' +
      'cannot name a line. That renders an internal code as if it were the ' +
      'number on the front of the bus.',
  );
});

test('an unresolved line is typed as having no name', () => {
  const decl = MAP_UTILS.match(/interface LineGroup\s*\{[\s\S]*?\}/)?.[0] ?? '';
  assert.notEqual(decl, '', 'LineGroup is gone from mapUtils');
  assert.match(
    decl,
    /lineId\s*:\s*string\s*\|\s*null/,
    'LineGroup.lineId must be `string | null` so every render site is forced ' +
      `to decide what an unnamed line looks like. Got: ${decl}`,
  );
});

test('the trip planner does not name a leg after its internal code', () => {
  assert.doesNotMatch(
    TRIP,
    /LineID\s*\?\?\s*\w*[Ll]ineCode/,
    'tripExtraction still falls back to the LineCode for a leg label.',
  );
});

test('there is one shared answer for what an unnamed line looks like', () => {
  const helpers = decomment(read('src/utils/lineLabels.ts'));
  assert.match(
    helpers,
    /export function lineBadge/,
    'lineBadge is the single place that decides what a badge shows for a ' +
      'line the catalogue cannot name. Every badge must go through it.',
  );
  assert.match(
    helpers,
    /export function spokenLine/,
    'spokenLine is its screen-reader counterpart — "Line 140" has to become ' +
      'something a screen reader can say when there is no number.',
  );
});

/* ── Repairing a catalogue that does not name what routes reference ── */

test('the catalogue gets one chance per session to repair itself', () => {
  assert.match(
    MAP_UTILS,
    /unresolved/,
    'buildLineGroups must report which LineCodes it could not name — it is ' +
      'the only place that knows, and it must stay a pure function.',
  );
  assert.match(
    LINES_MAP,
    /export function useCatalogueHeal/,
    'nothing acts on an unresolved LineCode. A catalogue that cannot name ' +
      'what the routes reference should be refetched, not trusted.',
  );
  assert.match(
    LINES_MAP,
    /let\s+_healed|_healed\s*=\s*false/,
    'the repair must be one-shot per session. OASA itself ships routes for ' +
      'LineCodes that webGetLines does not list (1298, 1299, 1300), so an ' +
      'unconditional refetch on a miss would loop for as long as the app runs.',
  );
});

/* ── The frozen caches ──────────────────────────────────────── */

for (const fn of ['setCachedRoutesForStop', 'setCachedStops']) {
  test(`${fn} still accepts fresh data once the offline bundle exists`, () => {
    const start = STORAGE.indexOf(`export function ${fn}`);
    assert.notEqual(start, -1, `${fn} is gone from storage`);
    const body = STORAGE.slice(start, STORAGE.indexOf('\n}', start));
    assert.doesNotMatch(
      body,
      /_offlineDownloaded/,
      `${fn} drops every runtime write while the offline bundle flag is set. ` +
        'createDictCache has no TTL, so that entry is then frozen on disk for ' +
        'good and nothing can correct it — a stale route list keeps pointing ' +
        'at lines the catalogue no longer names.',
    );
  });
}
