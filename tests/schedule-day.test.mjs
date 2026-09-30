/**
 * A cached timetable must be today's timetable.
 *
 * `getDailySchedule` answers for the day it is asked on. Line 201 (LineCode
 * 1176), measured against the live API on 2026-09-30: 29 departures on a
 * weekday (sdc 54), 26 on Saturday (59), 14 on Sunday (60).
 *
 * The schedule cache is keyed by line alone. The home stop card read it first
 * and only asked the network when nothing was there, so a timetable saved on
 * Sunday was shown all week: 14 buses on a Wednesday.
 *
 * Source invariants for the storage wiring, for the reason
 * `api-transport.test.mjs` gives. The service-day helper itself is pure and is
 * run for real.
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

const STORAGE = decomment(read('src/services/storage.ts'));
const HOOKS = decomment(read('src/hooks/index.ts'));
const CARD = decomment(read('src/components/FavoriteStopCard.tsx'));

const { athensServiceDay } = await import('../src/utils/scheduleUtils.ts');

/* ── The service day ────────────────────────────────────────── */

test('Sunday and Wednesday are different service days', () => {
  // 2026-09-27 is a Sunday, 2026-09-30 a Wednesday. Noon Athens = 09:00 UTC.
  assert.notEqual(
    athensServiceDay(Date.parse('2026-09-27T09:00:00Z')),
    athensServiceDay(Date.parse('2026-09-30T09:00:00Z')),
  );
  assert.equal(athensServiceDay(Date.parse('2026-09-30T09:00:00Z')), '2026-09-30');
});

test('a bus after midnight still belongs to the evening before', () => {
  // 01:30 Athens on Thursday (22:30 UTC Wednesday) is Wednesday's service.
  assert.equal(athensServiceDay(Date.parse('2026-09-30T22:30:00Z')), '2026-09-30');
  // 03:30 Athens Thursday is Thursday's.
  assert.equal(athensServiceDay(Date.parse('2026-10-01T00:30:00Z')), '2026-10-01');
});

test('the day is Athens time, not device time', () => {
  // 01:30 UTC on the 1st = 04:30 Athens: the 1st, although UTC minus 3h is the 30th.
  assert.equal(athensServiceDay(Date.parse('2026-10-01T01:30:00Z')), '2026-10-01');
});

/* ── The cache ──────────────────────────────────────────────── */

test('getCachedSchedule refuses a copy from another service day', () => {
  const fn = STORAGE.match(/export async function getCachedSchedule\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(
    fn,
    /isScheduleFromToday\(lineCode\)/,
    'getCachedSchedule returns whatever copy is on disk. The cache is keyed ' +
      'by line alone, so that is Sunday\'s timetable on a Wednesday.',
  );
  assert.match(STORAGE, /athensServiceDay\(at\)\s*===\s*athensServiceDay\(\)/);
});

test('favorites are re-fetched when their copy is from another day', () => {
  const fn = STORAGE.match(/export async function prefetchFavoriteSchedules[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /isScheduleFromToday/);
});

/* ── The readers ────────────────────────────────────────────── */

test('the timetable query is keyed by service day', () => {
  assert.match(HOOKS, /queryKey:\s*\['schedule',\s*lineCode,\s*athensServiceDay\(\)\]/);
});

test('the stop card reloads timetables when the day rolls over', () => {
  assert.match(CARD, /\}, \[linesKey, serviceDay\]\);/);
});

test('any-day copies are only an offline fallback', () => {
  // In the hook and the card, the any-day read sits inside a catch.
  for (const [name, src] of [['hooks', HOOKS], ['card', CARD]]) {
    const uses = [...src.matchAll(/getCachedScheduleAnyDay\(/g)].length;
    const inCatch = [...src.matchAll(/catch[^{]*\{[^}]*getCachedScheduleAnyDay\(/g)].length;
    assert.ok(uses > 0, `${name} has no offline fallback`);
    assert.equal(inCatch, uses, `${name} reads another day's timetable outside a network failure`);
  }
});
