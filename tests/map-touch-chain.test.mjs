/**
 * The shared map's touch chain, asserted against the real source.
 *
 * Every link in this chain is a full-screen view between the window and the one
 * `<MapView>`, which lives *below* the navigator. Android hands a touch to the
 * first view that accepts it, and `ReactViewGroup.onTouchEvent` accepts
 * unconditionally whenever `pointerEvents` allows the view to be a target — its
 * own comment is "the root view always assumes any view that was tapped wants
 * the touch". So a single `auto` view anywhere above the map is enough to make
 * the map completely inert: it still draws, still animates, still shows its
 * markers, and receives not one event.
 *
 * That failure is invisible in review and invisible in a screenshot, and it
 * shipped three times (1.2.8, 1.2.9, 1.2.10). These tests are the check that
 * cannot be skipped by looking at the screen, and they exist because the second
 * failure was not a wrong idea but a right idea silently thrown away: React
 * Navigation merges options shallowly, so a screen setting `contentStyle`
 * replaces the navigator's rather than adding to it.
 *
 * Run with `npm test`. No test framework: node's own runner, no new deps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Every .ts/.tsx under a directory, recursively. */
function sources(rel) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const p = join(dir, entry);
      if (statSync(join(ROOT, p)).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry)) out.push(p);
    }
  };
  walk(rel);
  return out;
}

const ALL = [...sources('src'), ...sources('app')];
/** Files that borrow the shared map — the ones the whole chain is about. */
const BORROWERS = ALL.filter((f) => read(f).includes('useMapSurface('))
  .filter((f) => !f.endsWith('MapHost.tsx'));

test('map screens exist to be checked at all', () => {
  assert.ok(
    BORROWERS.length >= 3,
    `expected at least the 3 map screens to call useMapSurface, found ${BORROWERS.length}: ${BORROWERS}`,
  );
});

test('MAP_SCREEN_CONTENT_STYLE carries both properties', () => {
  const src = read('src/ui/MapHost.tsx');
  const m = /export const MAP_SCREEN_CONTENT_STYLE[^=]*=\s*\{([^}]*)\}/.exec(src);
  assert.ok(m, 'MAP_SCREEN_CONTENT_STYLE is not exported from src/ui/MapHost.tsx');
  const body = m[1];
  assert.match(body, /backgroundColor:\s*'transparent'/,
    'without a transparent background the navigator hides the map');
  assert.match(body, /pointerEvents:\s*'box-none'/,
    'without box-none the content wrapper eats every touch and the map is inert');
});

test('every map screen passes the shared contentStyle, not a literal', () => {
  for (const f of BORROWERS) {
    const src = read(f);
    assert.ok(
      src.includes('MAP_SCREEN_CONTENT_STYLE'),
      `${f} borrows the map but does not import MAP_SCREEN_CONTENT_STYLE`,
    );
    // The trap: options merge shallowly, so a literal here *replaces* the
    // navigator's contentStyle and drops its pointerEvents.
    const literals = src.match(/contentStyle:\s*\{/g) ?? [];
    assert.equal(
      literals.length, 0,
      `${f} sets contentStyle to an inline object; that replaces the navigator's ` +
      'and drops pointerEvents. Use MAP_SCREEN_CONTENT_STYLE.',
    );
    const uses = src.match(/contentStyle:\s*MAP_SCREEN_CONTENT_STYLE/g) ?? [];
    const declared = src.match(/contentStyle:/g) ?? [];
    assert.equal(
      uses.length, declared.length,
      `${f} has ${declared.length} contentStyle site(s) but only ${uses.length} use the shared constant`,
    );
  }
});

test('no screen anywhere sets a transparent contentStyle without box-none', () => {
  for (const f of ALL) {
    for (const m of read(f).matchAll(/contentStyle:\s*\{([^}]*)\}/g)) {
      if (/transparent/.test(m[1])) {
        assert.match(
          m[1], /box-none/,
          `${f} makes its content transparent without box-none — a transparent ` +
          'screen over the shared map with a touch-eating wrapper is exactly the 1.2.10 bug',
        );
      }
    }
  }
});

test('the navigator still carries the box-none default', () => {
  const src = read('app/_layout.tsx');
  const m = /contentStyle:\s*\{([^}]*)\}/.exec(src);
  assert.ok(m, 'the Stack no longer sets a default contentStyle');
  assert.match(m[1], /pointerEvents:\s*'box-none'/,
    'the navigator default is the safety net for a screen that forgets');
});

test('each map screen declines touches itself while revealed', () => {
  for (const f of BORROWERS) {
    assert.match(
      read(f), /pointerEvents=\{revealed \? 'box-none'/,
      `${f}'s root container must be box-none while the map shows through it`,
    );
  }
});

test('the hole is fully transparent to touch', () => {
  const slot = /export function MapSurfaceSlot[\s\S]*?\n\}/.exec(read('src/ui/MapHost.tsx'));
  assert.ok(slot, 'MapSurfaceSlot not found');
  assert.match(slot[0], /pointerEvents="none"/,
    'the hole draws nothing and must never be a touch target');
});

test('the host gates its own touchability on being active', () => {
  const src = read('src/ui/MapHost.tsx');
  assert.match(src, /pointerEvents=\{active \? 'auto' : 'none'\}/,
    'an unrevealed map must decline touches meant for the screen above it');
  assert.match(src, /const active = revealed && spec\.focused/,
    'active is what separates "drawing" from "drawing and on top"');
});

test('there is exactly one MapView in the app', () => {
  // The default export of react-native-maps imported as a *value* — a type-only
  // import (`useRef<MapView>`) or a mention in a comment does not render one.
  const hosts = ALL.filter((f) => /^import\s+MapView\b/m.test(read(f)));
  assert.deepEqual(
    hosts, ['src/ui/MapHost.tsx'],
    `a second MapView would mean the map being configured is not the map on screen: ${hosts}`,
  );
});

test('SafeAreaProviderCompat is patched, in this tree, right now', () => {
  // The patch file existing proves nothing: what matters is whether the code
  // Metro will bundle is patched. `lib/module` is the only built output the
  // package ships, so it is the one that runs.
  const built = read('node_modules/@react-navigation/elements/lib/module/SafeAreaProviderCompat.js');
  assert.match(
    built, /pointerEvents:\s*'box-none'/,
    'the installed @react-navigation/elements wrapper is unpatched — it is a ' +
    'full-screen auto view above every screen, so the map gets nothing. ' +
    'Run `npx patch-package` / `npm ci` to reapply.',
  );
  const patches = readdirSync(join(ROOT, 'patches'));
  assert.ok(
    patches.some((p) => p.startsWith('@react-navigation+elements+')),
    `no elements patch in patches/ — the fix would vanish on the next install: ${patches}`,
  );
});

test('the screen content wrapper can decline touches', () => {
  // `RNSScreenContentWrapper` is a native ReactViewGroup whose ViewManager
  // delegate has no `pointerEvents` case, so it discards the prop and consumes
  // every touch its children decline — which is what killed the map in 1.2.8,
  // 1.2.9 and 1.2.10. The patch swaps it for a plain View outside form sheets.
  const resolved = 'node_modules/react-native-screens/src/components/ScreenStackItem.tsx';
  const src = read(resolved);
  assert.match(
    src, /pointerEvents: 'box-none'/,
    `${resolved} is unpatched: the content wrapper will eat every touch and the ` +
    'map will draw perfectly while responding to nothing. Run `npm ci`.',
  );
  assert.match(
    src, /stackPresentation === 'formSheet' \? DebugContainer : View/,
    'form sheets still need the native wrapper (it measures their content height)',
  );
});

test('the screens patch is applied to the file Metro actually bundles', () => {
  // The subtle half of that bug: this package points its `react-native` entry
  // field at TypeScript source, so Metro bundles `src/` and patching the
  // compiled `lib/` output changes nothing that ever runs. An hour went into
  // patching `lib/` and watching the bundle not change.
  const pkg = JSON.parse(read('node_modules/react-native-screens/package.json'));
  const entry = pkg['react-native'] ?? pkg.main;
  assert.ok(
    entry.startsWith('src/'),
    `react-native-screens now resolves to ${entry}, not src/ — the patch may be ` +
    'applying to a file nothing bundles. Re-check which copy Metro reads.',
  );
});

test('the patch matches the installed version of the package', () => {
  const installed = JSON.parse(
    read('node_modules/@react-navigation/elements/package.json'),
  ).version;
  const patches = readdirSync(join(ROOT, 'patches'))
    .filter((p) => p.startsWith('@react-navigation+elements+'));
  assert.ok(
    patches.some((p) => p === `@react-navigation+elements+${installed}.patch`),
    `patch is for a different version than the installed ${installed}: ${patches}. ` +
    'patch-package will refuse to apply it and postinstall will fail.',
  );

  const screens = JSON.parse(read('node_modules/react-native-screens/package.json')).version;
  const screensPatches = readdirSync(join(ROOT, 'patches'))
    .filter((p) => p.startsWith('react-native-screens+'));
  assert.ok(
    screensPatches.some((p) => p === `react-native-screens+${screens}.patch`),
    `no patch for the installed react-native-screens ${screens}: ${screensPatches}`,
  );
});

test('the planner declines touches on its extra map wrapper too', () => {
  // Unique to the planner: an intermediate opaque wrapper between its root and
  // the hole. Left at `auto` it is a second, independent way for one screen's
  // map to be dead while the other two work.
  const src = read('src/features/planner/PlannerScreen.tsx');
  const wrapper = /<View\s+style=\{\[s\.mapFill[\s\S]{0,900}?>/.exec(src);
  assert.ok(wrapper, 'the planner mapFill wrapper moved; re-check its pointerEvents');
  assert.match(
    wrapper[0], /pointerEvents=\{revealed \? 'box-none'/,
    'the planner mapFill wrapper must decline touches while the map shows through',
  );
});
