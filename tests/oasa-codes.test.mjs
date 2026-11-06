/**
 * OASA codes are text inside the app, whatever JSON type the API sends.
 *
 * The API switched `"LineCode":"1173"` to `"LineCode":1173` without notice. A
 * saved stop's filter held `"1173"`, `Set.has(1173)` said no, and every stop
 * saved before the switch showed "No lines shown". See `src/services/oasaCodes.ts`.
 *
 * `codesAsText` is tested directly. That `api()` and the disk reads use it is a
 * source invariant, for the reason `api-transport.test.mjs` gives: neither
 * module imports under node's type stripping.
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

const { codesAsText, codeAsText } = await import('../src/services/oasaCodes.ts');

test('a numeric response matches the codes a stop saved as text', () => {
  // Shapes as webRoutesForStop and getStopArrivals send them in November 2026.
  const routes = codesAsText([{ RouteCode: 2557, LineCode: 1173, RouteDescrEng: 'ANO ILIOUPOLI - ST. DAFNI', hidden: 0 }]);
  const arrivals = codesAsText([{ route_code: 2557, veh_code: 52313, btime2: 5 }]);
  const saved = new Set(['1173']);
  assert.equal(saved.has(routes[0].LineCode), true);
  assert.equal(arrivals[0].route_code, routes[0].RouteCode);
  assert.equal(routes[0].RouteDescrEng, 'ANO ILIOUPOLI - ST. DAFNI');
});

test('text, null and nesting pass through unchanged', () => {
  assert.deepEqual(
    codesAsText({ go: [{ sde_start1: '1900-01-01 05:00:00', sde_end1: null, n: 3 }], come: [] }),
    { go: [{ sde_start1: '1900-01-01 05:00:00', sde_end1: null, n: '3' }], come: [] },
  );
});

test('a stored code reads back as text', () => {
  assert.equal(codeAsText(1173), '1173');
  assert.equal(codeAsText('1173'), '1173');
  assert.equal(codeAsText(''), null);
  assert.equal(codeAsText(null), null);
});

test('every response and every stored OASA code goes through the conversion', () => {
  const api = read('src/services/api.ts');
  assert.match(api, /return codesAsText\(parsed\) as T;/);
  assert.doesNotMatch(api, /return parsed as T;/);

  const storage = read('src/services/storage.ts');
  for (const file of ['SCHEDULES_FILE', 'ROUTES_FILE', 'ROUTES_FOR_STOP_FILE', 'ROUTE_STOPS_FILE']) {
    assert.match(storage, new RegExp(`createDictCache<[^>]+>\\(${file}, codesAsText\\)`), file);
  }
  assert.match(storage, /favoriteCodesAsText\(parseJson\(blob\.get\(FAVORITES_KEY\)/);
  assert.match(storage, /stopCodesAsText\(parseJson\(blob\.get\(FAVORITE_STOPS_KEY\)/);
  assert.match(storage, /return codesAsText\(parsed\) as OasaLine\[\];/);
  assert.match(storage, /arrivals: codesAsText\(data\.arrivals\)/);
  assert.match(storage, /_allStopsMemo = codesAsText\(parsed\)/);
});
