# UI/UX pass — design

**Date:** 2026-08-07
**Scope:** All six screens, interaction-led, with a shared visual language.
**Approach:** Build shared primitives first, then apply them screen by screen.

## Why

The app is already carefully built — accessibility roles and labels throughout, 44pt
hit targets, virtualized lists, deliberate empty/error/stale states, haptics. The
problems are not carelessness. They are the specific failures that come from
polishing screen by screen with no shared layer:

- **The same concept is implemented twice and has diverged.** `LiveMapScreen` and
  `NearbyMapScreen` each render their own stop card. Live has arrival alerts,
  "All lines", and next-departure. Nearby has none of them. Same object, two
  behaviours, depending on which map you tapped it from.
- **Fixes land in one place.** `FavoriteStopCard.styles.ts` carries a comment
  explaining that the `′` prime glyph is announced as "feet" by screen readers and
  was removed for that reason. Both map screens still print `{line.nextMin}'`.
  `fontVariant: ['tabular-nums']` is applied in five places and missing from the two
  map cards — exactly where digits tick 5→4→3 and jitter.
- **Affordances promise things they do not do.** `PlannerScreen` renders a drag
  handle (`s.panelHandle`) above a fixed-height panel.
- **Accessibility is uneven.** The map control clusters (metro, stamps, schedule,
  recenter) have no `accessibilityLabel`, unlike the rest of the app.
- **One confirmed contrast bug.** `AccentPicker` generates accents as
  `hslToHex(hue, 70, 45)` — fixed 45% lightness across all 360 hues — while line
  badges hardcode `#FFFFFF` text in 14 places. Around hue 60 (yellow) and hue 120
  (green) this lands near 2:1 contrast. The app's most important label becomes
  unreadable depending on a color the user is invited to choose.

A shared primitives layer makes consistency structural rather than something that has
to be remembered six times.

## Principles

1. **The number is the interface.** Everything else is chrome around the minutes.
2. **Never lie about freshness.** Live, decaying, stale, and offline must be visually
   distinct. The app already believes this; it does not apply it evenly.
3. **Motion explains change.** Things move because they moved, arrived, or are
   loading. Nothing animates for decoration.
4. **Undo, don't confirm.** Reversible actions happen immediately with an undo
   affordance. Modal dialogs are reserved for the genuinely irreversible.
5. **One component per concept.** The two stop cards are the cautionary tale.

## Dependencies

Add `react-native-reanimated` **and `react-native-worklets`** — Reanimated 4 split the
worklets runtime into a separate package, and it is a required peer, not optional.
Install with `npx expo install` so versions are chosen to match SDK 54, then
`npx expo prebuild`.

Reanimated 4 requires the New Architecture. This project already has it:
`app.config.ts:85` and `android/gradle.properties:38` both set `newArchEnabled=true`.
No migration needed.

**Babel plugin — verify, do not assume.** The plugin is `react-native-worklets/plugin`
(renamed in v4) and must be **last** in the plugins array. This project has **no
`babel.config.js` at all**; it runs on `babel-preset-expo`'s defaults, and that preset
auto-includes the worklets plugin when reanimated is present. Adding it manually on
top would double-apply it, which is its own failure mode. So: install, prebuild, run,
and only create `babel.config.js` if the runtime actually reports a missing plugin.
Reanimated fails at runtime rather than build time, so this must be checked on device,
not inferred from a successful compile.

**`GestureHandlerRootView` must be mounted, and currently is not.**
`react-native-gesture-handler` is in `package.json` but is imported nowhere in `src/`
or `app/` — it is present only as a transitive dependency of expo-router. Every
gesture in this pass (drag reorder, sheet drags) needs
`<GestureHandlerRootView style={{flex:1}}>` wrapping the tree in `app/_layout.tsx`.
Without it, gestures silently do nothing on Android — no error, just dead touches.

Do **not** add a third-party draggable list. Reordering is built on gesture-handler
plus reanimated, so the behaviour is ours to tune and no list-level third-party
surface enters a project that deliberately pins and patches its dependencies.

This all lands as the **first** implementation step, in isolation, so that any fallout
in the hand-tuned Android config (arm64-only, R8, custom signing, permission stripping
via `plugins/withAndroidOptimizations.js`) surfaces before UI work stacks on top of it.

## Visual foundation

### Typography

Stay on System. No webfont: cold start is a stated priority, and Greek glyph coverage
is a real risk with a downloaded face. Character comes from weight, tracking, and
numerals.

Retune `font.size` to role names rather than t-shirt sizes. `xxl` has zero uses and
`xl` has three, so the current seven-step ramp is mostly fictional:

| Role | Size | Use |
|---|---|---|
| `micro` | 11 | Freshness, metadata, pills |
| `label` | 13 | Section labels, secondary text, badges |
| `body` | 15 | List rows, primary content |
| `title` | 18 | Screen and stop titles |
| `figure` | 34 | The arrival number, tracking -1 |

Old names stay as aliases so the change does not require touching every file at once.

**`tabular-nums` becomes mandatory on every number.** Added to a `font.num` style
object that numeric text spreads in, so it cannot be forgotten again.

### Color

- **Consolidate the two reds.** `getArrivalColor` returns `#F44336`; `colors.danger`
  is `#EF4444`. Arrival colors move into the palette as
  `arrival.imminent` / `arrival.soon` / `arrival.later`, and `getArrivalColor` reads
  from there.
- **Add `onAccent(hex)`** — returns `#FFFFFF` or `#000000` by computing WCAG relative
  luminance of the accent. Every badge that currently hardcodes white asks this
  instead. Fixes the contrast bug.
- **Add a hairline top edge to cards** — `rgba(255,255,255,0.06)`. The bg→surface→card
  ramp is 0%/7%/11% fill, which flattens to a single plane in daylight on OLED.
  Elevation should not depend on a 4% fill delta.

### Spacing and radius

Unchanged. Add `spacing.xxs: 2` for badge-internal gaps.

## Primitives (`src/ui/`)

**`motion.ts`** — durations (`fast` 120, `base` 200, `slow` 320), spring configs, and a
`useReduceMotion()` hook backed by `AccessibilityInfo`. Every animation in the app
honours it. This is not optional: adding reanimated to an app with essentially no
motion means vestibular-sensitive users go from "nothing moves" to "everything moves"
in a single release.

**`Pressable.tsx`** — press-scale to 0.97, haptic on press, enforced `HIT_SIZE`
minimum, reduce-motion aware. Replaces bare `TouchableOpacity` for cards and buttons.

**`Skeleton.tsx`** — shimmering placeholder shaped like the content that will replace
it. Used where the final layout is known (stop cards, search rows, planner results).
`ActivityIndicator` stays where the shape genuinely is not known yet.

**`BottomSheet.tsx`** — real draggable sheet: snap points, backdrop, velocity-aware
dismiss, gesture-handler + reanimated. Makes the planner's handle honest and upgrades
both map stop cards.

**`UndoBar.tsx`** — act-then-undo toast with a timed auto-commit. Replaces
`Alert.alert` for remove-stop, remove-line, and clear-offline-data.

**`StopSheet.tsx`** — the single stop card. Union of the two current implementations:
stop name, save toggle, arrival alert, walk time, arrivals list, all-lines expansion,
next departure. Both map screens render this one component.

## Per-screen application

### Home (`src/features/home/`)

- **Drag to reorder saved stops.** Long-press lifts the card, neighbours animate out of
  the way, drop commits. Replaces the current chevron-tap reorder, which is O(n) taps
  to move a stop and requires entering an edit mode first. Chevrons remain reachable in
  edit mode as the accessible fallback, since drag is not usable with a screen reader.
- **Undo instead of dialogs.** Removing a stop or line applies immediately and raises
  an `UndoBar`. `persistStopOrder` already coalesces writes, so an undo is a cheap
  rewrite of the array.
- **Skeleton cards on cold start** in place of the per-card spinner.
- **Restructure the action row.** Search, Nearby, and Go To currently share one row,
  with search on `flex: 1`. At 360dp that leaves search roughly 130dp — a cramped
  target for the primary entry point. Search moves to its own full-width row; Nearby
  and Go To become two equal-flex buttons beneath it. Bigger targets, and it survives
  narrow screens and large text.
- **Staggered entrance** for stop cards on first paint.

### Search (`src/features/search/`)

- Skeleton rows replace the full-screen `ActivityIndicator`.
- Favouriting gets a haptic and a scale pop, so the heart confirms itself.
- Existing empty and error states keep their copy and gain the new primitives.
- `useDeferredValue` and `keyboardShouldPersistTaps` are already right; leave them.

### Nearby map (`src/features/map/NearbyMapScreen.tsx`)

- Stop card replaced by `BottomSheet` + `StopSheet`. This screen **gains** arrival
  alerts, all-lines, and next-departure, which it currently lacks purely by accident of
  being the second copy.
- `accessibilityLabel` on the metro toggle, stamps toggle, and recenter button.
- `tabular-nums`, and the `′` prime glyph becomes `min`.

### Live map (`src/features/map/LiveMapScreen.tsx`)

- Same `BottomSheet` + `StopSheet`.
- Control clusters extracted to a shared `MapControls` component, since both maps
  currently duplicate them verbatim.
- Route-direction dropdown and schedule overlay become sheets with real transitions
  instead of unanimated conditional renders.
- `accessibilityLabel` on schedule, metro, stamps, and recenter.
- `tabular-nums`, prime glyph removed.

### Planner (`src/features/planner/`)

- **The panel becomes a real `BottomSheet`** with peek / half / full snap points. The
  handle starts telling the truth, and the map can be given the whole screen when the
  user is placing pins.
- **`Dimensions.get('window')` at module scope (line 51) becomes `useWindowDimensions()`.**
  Captured once at import, the current value never updates on rotation or foldable
  resize.
- **Destination entry gets a visible affordance.** Long-press-on-map is the only way to
  set a destination, and the instruction text exists precisely because the gesture is
  undiscoverable. A "Drop pin" button enters an explicit placement mode; long-press
  keeps working for users who know it.
- Skeleton result cards during the phased search. The phase label is good and stays.
- Result cards animate in as they arrive rather than appearing all at once.

### Settings (`src/components/SettingsModal.tsx`)

- Modal becomes a `BottomSheet`, consistent with every other transient surface.
- Accent picker shows a live preview of a line badge using the derived `onAccent`, so
  the contrast fix is visible at the moment of choosing.

## Cross-cutting responsive and accessibility

- **`maxFontSizeMultiplier`** on numeric and layout-critical text so large system text
  degrades instead of destroying card layouts. Font scaling stays enabled everywhere
  else.
- **`useWindowDimensions`** replaces module-scope `Dimensions.get`.
- **Wide screens** (tablet, landscape, unfolded): sheets and cards take a `maxWidth`
  and centre rather than stretching to full bleed.
- **Reduce-motion** honoured by every animation added in this pass.

## Testing

The project has no test infrastructure, and this pass is not the place to introduce
it — that is its own decision. Verification is therefore manual and explicit, per
phase:

1. `npx tsc --noEmit` clean.
2. App builds and boots on device after the reanimated step, before any UI work — and
   one throwaway worklet animation actually runs, since a missing Babel plugin
   compiles fine and only fails at runtime.
3. Per screen: cold start, offline, API-failure, and empty states all still reachable
   and correct.
4. TalkBack pass on Home and one map screen — drag reorder must have a working
   chevron fallback.
5. Large-text pass at maximum system font size on Home and Planner.
6. Rotation pass on Planner, which is the screen that currently assumes it cannot
   happen.

Each phase is independently shippable and independently revertable.

## Sequencing

| Phase | Content | Ships |
|---|---|---|
| 0 | reanimated + worklets + `GestureHandlerRootView` + prebuild + device check | — |
| 1 | Theme retune: type roles, `font.num`, `onAccent`, arrival palette, hairline | Yes |
| 2 | `src/ui/` primitives: motion, Pressable, Skeleton, BottomSheet, UndoBar | Yes |
| 3 | `StopSheet` + `MapControls`, applied to both maps | Yes |
| 4 | Home: drag reorder, undo, skeletons, action row | Yes |
| 5 | Search + Settings | Yes |
| 6 | Planner: sheet, dimensions fix, drop-pin affordance, skeletons | Yes |
| 7 | Cross-cutting responsive and a11y sweep | Yes |

Phase 0 is a hard gate. If reanimated destabilises the Android build, the whole motion
story changes and this spec needs revisiting before phases 2 onward.
