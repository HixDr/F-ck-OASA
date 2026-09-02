/**
 * The line catalogue must never be cached, or served, empty.
 *
 * `webGetLines` maps LineCode → LineID: "1173" → "237", "967" → "421". Every
 * bus badge in the app is a LineID, and every one of them is produced by
 * `linesMap.get(r.LineCode)?.LineID ?? r.LineCode`. So an empty catalogue does
 * not blank the badges — it renders the *internal* code in place of the number
 * riders actually look for on the front of the bus. 937 instead of 140.
 *
 * Two source-level defects let that state stick for a day, or a week with the
 * offline bundle downloaded:
 *
 *  1. `useLines` wrote whatever `getLines()` returned straight to the cache.
 *     `api()` maps an empty, `""` or `null` body to `[]` for array endpoints —
 *     a real answer for "no arrivals right now", and a total loss for a
 *     catalogue — so one momentary blank body persisted `[]` with a fresh
 *     timestamp.
 *
 *  2. `getCachedLines` returned that `[]`, and `if (cached) return cached` in
 *     `useLines` treats it as a hit because `[]` is truthy. The network was
 *     then never consulted again until the TTL expired.
 *
 * Together: one bad moment, and every badge in the app showed an internal code
 * until the cache aged out. Force-quitting did not help — the poison was on
 * disk, not in the process.
 *
 * These are source invariants rather than behavioural tests for the reason
 * given in `api-transport.test.mjs`: neither module can be imported here, and
 * the property that matters is structural — an empty catalogue must not be
 * writable to the cache, and must not be readable back as a hit.
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

/** Comments stripped: the prose above describes the old bug on purpose, and an
 *  invariant a comment can satisfy is not an invariant. */
const decomment = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');

const STORAGE = decomment(read('src/services/storage.ts'));
const HOOKS = decomment(read('src/hooks/index.ts'));
const LINES_MAP = decomment(read('src/hooks/useLinesMap.ts'));

/** Every screen that turns routes into badges. All of them read the catalogue
 *  through `useLinesMap`, so all of them can render before it arrives. */
const GROUP_CALLERS = [
  'src/components/FavoriteStopCard.tsx',
  'src/features/map/LiveMapScreen.tsx',
  'src/features/map/NearbyMapScreen.tsx',
];

/** The body of the named function declaration, brace-matched. */
function body(src, name) {
  const start = src.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} is gone from the source`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  assert.fail(`${name} has unbalanced braces`);
}

test('getCachedLines does not report an empty catalogue as a cache hit', () => {
  const fn = body(STORAGE, 'getCachedLines');
  assert.match(
    fn,
    /\.length\s*[>=!]/,
    'getCachedLines returns the parsed array without checking its length. ' +
      '`[]` is truthy, so an empty catalogue reads as a hit and the network ' +
      'is never asked again until the TTL expires.',
  );
});

test('setCachedLines refuses to persist an empty catalogue', () => {
  const fn = body(STORAGE, 'setCachedLines');
  assert.match(
    fn,
    /\.length\s*[>=!]/,
    'setCachedLines writes any array it is handed. One blank response body ' +
      'becomes `[]` on disk with a fresh timestamp, and every bus badge in ' +
      'the app falls back to its internal LineCode.',
  );
});

test('useLines guards its cache write on a non-empty result', () => {
  const start = HOOKS.indexOf('export function useLines(');
  assert.notEqual(start, -1, 'useLines is gone from the source');
  const fn = HOOKS.slice(start, HOOKS.indexOf('\n}', start));
  const write = fn.match(/[^\n]*setCachedLines\([^\n]*/)?.[0] ?? '';
  assert.notEqual(write, '', 'useLines no longer writes the lines cache');
  assert.match(
    fn,
    /(fresh|lines)[\s\S]{0,40}\.length\s*[>=!]/,
    `useLines persists its fetch result unconditionally (${write.trim()}). ` +
      'A `[]` from a blank body must not reach the cache — compare ' +
      'useRoutesForStop, which writes only `if (fresh && fresh.length > 0)`.',
  );
});


/* ── The other way to an empty catalogue: rendering before it lands ── */

/**
 * `buildLineGroups` takes the catalogue as an argument and falls back to the
 * LineCode on a miss, which is the right last resort when the catalogue is
 * genuinely unavailable — a number beats a blank badge. It is the wrong answer
 * while the catalogue is merely still in flight, and the routes query can
 * absolutely resolve first: it comes off its own cache, and a card that keyed
 * "ready" on routes alone painted internal codes for the gap.
 *
 * So the readiness of the catalogue has to be a thing callers can ask about,
 * and every caller has to ask.
 */

test('useLinesMap reports whether the catalogue is usable yet', () => {
  assert.match(
    LINES_MAP,
    /linesReady/,
    'useLinesMap exposes no readiness flag, so callers cannot tell an ' +
      'arrived-but-empty catalogue from one still in flight.',
  );
  const derivation =
    LINES_MAP.match(/linesReady\s*[=:]([^;\n]*(?:\n[^;\n]*)?)/)?.[1] ?? '';
  assert.match(
    derivation,
    /size\s*>/,
    'linesReady must be derived from the map actually having entries — an ' +
      `arrived-but-empty catalogue is not ready. Got: ${derivation.trim()}`,
  );
  assert.match(
    derivation,
    /isError|linesError/,
    'a hard failure must also count as ready, or a lines request that cannot ' +
      'succeed (offline, no cache) strands every badge behind a skeleton for ' +
      `good instead of showing the fallback and a Retry. Got: ${derivation.trim()}`,
  );
});

for (const file of GROUP_CALLERS) {
  test(`${file} waits for the catalogue before building line groups`, () => {
    const src = decomment(read(file));
    assert.match(
      src,
      /buildLineGroups/,
      `${file} no longer builds line groups — drop it from GROUP_CALLERS.`,
    );
    assert.match(
      src,
      /linesReady/,
      `${file} builds line groups without consulting linesReady, so it can ` +
        'paint a LineCode badge in the window before the catalogue lands.',
    );
  });
}
