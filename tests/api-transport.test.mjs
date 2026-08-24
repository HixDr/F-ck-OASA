/**
 * The API transport's base URL, asserted against the real source.
 *
 * The plaintext host does not answer. As of 2026-08 `http://telematics.oasa.gr`
 * does not complete a connection at all — it hangs until the timeout — while
 * HTTPS serves every endpoint normally on a certificate valid to Feb 2027.
 *
 * So the failover this file exists to prevent could never *help*, and it could
 * permanently break the app. It worked like this: one transport error moved a
 * module-level `_resolvedBase` from HTTPS to HTTP and left it there, with
 * nothing in the process able to move it back. A single bad moment — a tunnel,
 * a lift, a cell handover, all routine on a phone — was therefore enough to
 * point every subsequent request at a host that does not respond, for the whole
 * life of the process. Recovery required a force-quit.
 *
 * The symptom was every saved stop showing no bus times at once, which reads
 * like an outage rather than a bug: lines and stop names keep rendering from the
 * offline cache, so the screen stays populated and only the numbers go. The API
 * was healthy throughout.
 *
 * These are source invariants rather than behavioural tests because `api.ts`
 * cannot be imported here — node's type stripping rejects its constructor
 * parameter properties — and because the property that matters is structural:
 * there must be no way for one request's failure to change where the next
 * request goes.
 *
 * Run with `npm test`. No test framework: node's own runner, no new deps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = readFileSync(join(ROOT, 'src/services/api.ts'), 'utf8');

/** Source with comments stripped — the prose above describes the old failover
 *  on purpose, and an invariant that a comment can break is not an invariant.
 *  The lookbehind matters: without it the `//` in `https://` reads as a comment,
 *  which silently ate the URLs and made the first test below pass vacuously. */
const CODE = API.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');

test('the OASA API is reached over HTTPS only', () => {
  const plaintext = CODE.match(/['"`]http:\/\/[^'"`]*oasa[^'"`]*['"`]/gi) ?? [];
  assert.deepEqual(
    plaintext,
    [],
    `a plaintext OASA base is still in the source: ${plaintext.join(', ')}. ` +
      'That host does not answer, so nothing may fall back to it.',
  );
});

test('no module-level mutable holds the API base', () => {
  // Module scope only: a `let` inside a function body is indented.
  const moduleLets = CODE.split('\n').filter((l) => /^let\s/.test(l));
  const baseHolders = moduleLets.filter((l) => /base|url|host|https?:/i.test(l));
  assert.deepEqual(
    baseHolders,
    [],
    `these module-level mutables decide where requests go: ${baseHolders.join(' | ')}. ` +
      'Where the next request goes must not be a value a previous request can write.',
  );
});

test('nothing latches a transport choice across requests', () => {
  const flags = CODE.split('\n').filter(
    (l) => /^let\s/.test(l) && /failover|fallback|tried|latch|resolved|probe/i.test(l),
  );
  assert.deepEqual(
    flags,
    [],
    `these module-level flags survive a request: ${flags.join(' | ')}. ` +
      'A one-shot flag is what made the broken state permanent.',
  );
});

test('the base URL is a const the request path only reads', () => {
  const decl = /const\s+(\w*BASE\w*)\s*=\s*['"`]https:\/\//.exec(CODE);
  assert.ok(decl, 'expected a `const …BASE = "https://…"` declaration in api.ts');
  const name = decl[1];
  // Any assignment to it after declaration, e.g. `NAME = …` / `NAME +=  …`.
  const reassigned = new RegExp(`(?<!const\\s)\\b${name}\\s*(?:=[^=]|\\+=)`).test(
    CODE.replace(decl[0], ''),
  );
  assert.equal(reassigned, false, `${name} is assigned to after its declaration`);
});
