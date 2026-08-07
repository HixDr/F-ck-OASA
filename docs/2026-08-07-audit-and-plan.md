# F*ck OASA — Audit & Remediation Plan

Date: 2026-08-07 · Codebase idle since 2026-03-01 · 8,773 LOC TS/TSX
Stack: Expo SDK 54, RN 0.81.5, React 19.1, New Architecture ON, Hermes, react-native-maps 1.20.1

## Environment verified live (2026-08-07)

- `tsc --noEmit` passes clean.
- OASA telematics API **alive over HTTPS**: `getAllStops` → 9,382 stops (2.0 MB, ~1.0 s);
  `getStopArrivals` ~0.23 s; `webGetLinesWithMLInfo` → 472 lines.
- **`http://telematics.oasa.gr` is dead** — hangs, 12 s, zero bytes. `api.ts:24-28` still races it.
- Valhalla (`valhalla1.openstreetmap.de`) alive.
- 6 Expo packages behind their SDK-54 pinned versions.
- `go`/`come` convention checked against live data: line 1153 (`ΠΕΙΡΑΙΑΣ - ΑΕΡ/ΝΑΣ`) has
  `go` = idx 1, `come` = idx 0 → **`idx <= 0 ? 'come' : 'go'` is correct**. The real defects are
  the `findIndex → -1` fallback and **circular lines** (1151 `ΚΥΚΛΙΚΗ`: one route → idx 0 → `'come'`,
  but its schedule is `come: [], go: [18]`) → circular lines get zero schedule data.

---

## P0 — Ship-blockers

| # | Bug | Location |
|---|---|---|
| 0.1 | Boot gate has no `.catch()`; any rejection ⇒ permanent black spinner. GPS toggled off makes `watchPositionAsync` reject. | `app/_layout.tsx:165`, `services/location.ts:50,63,77` |
| 0.2 | `api<T>()` has no timeout/AbortController; RN's OkHttp read timeout is infinite. Combined with `retry: 2`, a half-open socket hangs a query forever. | `services/api.ts:76-81`, `+197`, `notifications.ts:123`, `updater.ts:57,120` |
| 0.3 | Dead HTTP base still probed; `_resolvedBase` locks for process lifetime. | `services/api.ts:24-28,35-65` |
| 0.4 | Bad payloads become empty success: `catch { return [] }`. Makes the offline fallback unreachable (it only runs in `catch`) **and poisons caches** — `[]` is truthy, so it is persisted as a valid schedule and preferred forever. | `services/api.ts:87-96`, `hooks/index.ts:185`, `offlineData.ts:140` |
| 0.5 | Arrival alert posts to the fallback channel — `channelId` is not a field of `NotificationContentInput`; it belongs on the trigger. The HIGH-importance `arrival` channel is created and never used. | `services/notifications.ts:153-161` vs `:38-43` |
| 0.6 | `pollingTask` awaits an unguarded `startSilentLoop()`; the library has no `.catch`, so a throw orphans the foreground service alive-but-not-polling, forever. | `services/notifications.ts:134-137` |
| 0.7 | `_hasNotifPermission` computed and never read → on Android 13+ denial, alerts silently cannot work. | `services/notifications.ts:29-34,204` |
| 0.8 | Dict caches: `create()` truncates then `write()` — non-atomic. A kill between them zeroes the file; `_offlineDownloaded` stays `'1'` so it **can never repopulate**. Integrity check probes only 1 of 5 files. | `services/storage.ts:227-285,74-80` |
| 0.9 | `clear()` / `setBulk()` races with an in-flight `load()` resurrect or clobber data. | `services/storage.ts:273-283` |

## P1 — Request storm & polling (biggest battery/perceived-speed win)

| # | Bug | Location |
|---|---|---|
| 1.1 | 15 s poll returns a new array identity → schedule effect keyed on `[allLineGroups]` re-runs → uncached `getRoutes` **per line, every 15 s**. 3 stops × 8 lines ≈ 5,800 req/hour. **Confirmed by reading.** | `FavoriteStopCard.tsx:126-133,154,181` |
| 1.2 | Arrival polling hand-rolled in 3 places; `useArrivals` exists and is never imported. No dedup, no focus-pause, no AppState. `networkMode: 'always'` negates the NetInfo wiring. | `FavoriteStopCard.tsx:113`, `LiveMapScreen.tsx:359`, `NearbyMapScreen.tsx:187`, `hooks/index.ts:72`, `_layout.tsx:20-28` |
| 1.3 | Pull-to-refresh is a no-op: `refreshing` true→false in one sync scope (batched), and `loadFavorites` only re-reads storage. **Confirmed by reading.** | `HomeScreen.tsx:119-123` |
| 1.4 | Arrivals are withheld behind N cosmetic `getStops` calls for "to <dest>" labels — 10 requests before a single number appears. | `FavoriteStopCard.tsx:96-97`, `mapUtils.ts:90-94` |
| 1.5 | Valhalla POST on every GPS tick (~1 Hz), unconditionally — `location.ts:72` broadcasts even when the position did not change. No debounce/gate/abort; out-of-order responses flip `walkMin`. | `LiveMapScreen.tsx:145-155`, `NearbyMapScreen.tsx:75-83` |
| 1.6 | Hue slider: `setPrimaryColor` on every touch-move ⇒ ~60 full re-renders/s + 60 `AsyncStorage` writes/s. Context value not memoized. | `HomeScreen.tsx:288-295`, `SettingsProvider.tsx:55` |

## P2 — Map smoothness

| # | Bug | Location |
|---|---|---|
| 2.1 | RAF loop calls `setInterpolatedBuses` at 60 fps with **no equality check** — full 775-line re-render forever, even with parked buses. Also re-runs `Stack.Screen options` (new closures) 60×/s. | `LiveMapScreen.tsx:282-301,391-423` |
| 2.2 | `useRef(new BusInterpolator())` allocates a throwaway per render. | `LiveMapScreen.tsx:265` |
| 2.3 | `tracksViewChanges`: `selectedTracking` flips on **any** stop change → all N stop markers re-rasterize for 500 ms on every tap. User marker rotates via JS `transform`, forcing continuous recapture. | `LiveMapScreen.tsx:463,384`, `UserLocationMarker.tsx:43` |
| 2.4 | `snapToRoute` picks the **globally** nearest segment — no continuity window. Self-overlapping Athens routes make buses slide the full route length and back. | `busInterpolation.ts:92-116` |
| 2.5 | Planar math on raw degrees — longitude over-weighted ~27 % at 38°N. | `busInterpolation.ts:71-86` |
| 2.6 | No backwards-jump guard; no lower clamp on `elapsed` (clock rewind ⇒ extrapolates backwards); bearing → 0° at terminus; bearing computed 60×/s and never used (`rotation` is not set on the bus Marker). | `busInterpolation.ts:180-191,182,216,225`, `LiveMapScreen.tsx:488-496` |
| 2.7 | Interpolator fed `routePath` while the Polyline falls back to stops — when `getRouteDetails` returns `[]`, buses teleport every 10 s. | `LiveMapScreen.tsx:270-272` vs `:241-244` |
| 2.8 | No viewport culling; route polylines used raw (300–1500 pts). | `LiveMapScreen.tsx:441,458` |
| 2.9 | Stop-selection and route-detail races overwrite the wrong stop / wrong direction's polyline. | `LiveMapScreen.tsx:134-138,150,322-353`, `NearbyMapScreen.tsx:78-82,175-178` |
| 2.10 | `Date.now()` inside `useMemo` freezes the stale label and "next departure" permanently. | `LiveMapScreen.tsx:114-123,212-219` |
| 2.11 | `findIndex(...) ?? 0` — `??` does not catch `-1` ⇒ silently shows the opposite direction's schedule. | `LiveMapScreen.tsx:100` |
| 2.12 | Bus marker SVG captured on a bare 100 ms `setTimeout`, no retry — if it misses, **no bus markers all session**. | `LiveMapScreen.tsx:162-171` |
| 2.13 | No `AppState` handling anywhere; no focus-pausing. Location + magnetometer watchers start at boot and are never stopped (no `stopLocation()` exists). | app-wide, `location.ts:63-81` |
| 2.14 | Heading low-pass compares against the already-advanced `_heading`, so a slow turn never broadcasts and the beam can end up 90–180° wrong. `uiDelta` is wraparound-naive. | `location.ts:105-125` |

## P3 — Startup & memory

| # | Bug | Location |
|---|---|---|
| 3.1 | Gate blocks on `initLocation()` (**OS permission dialog**) and `probeApiBase()` (2 × 150 KB, 5 s ceiling). First launch = bare spinner on black behind the dialog. | `_layout.tsx:163-174` |
| 3.2 | `initStorage` = 6 serialized `AsyncStorage.getItem` + 1 sync FS stat. | `storage.ts:35-82` |
| 3.3 | `warmPlannerCaches()` parses ~25 MB of JSON on the JS thread as HomeScreen mounts; ~100–200 MB resident for a feature that may never be opened. | `_layout.tsx:170`, `storage.ts:297-304` |
| 3.4 | `getAllCachedStops()` re-parses ~2 MB with no memoization — fires every ~110 m walked (query key rounds to 3 dp) and on every trip plan. | `storage.ts:444-453`, `hooks/index.ts:111`, `planner.ts:79` |
| 3.5 | `expo-file-system` 19 `File.write()`/`create()` are **synchronous** — every dict flush blocks the JS thread. | `storage.ts:250-252,457`, `offlineData.ts:126-183` |
| 3.6 | No `expo-splash-screen`; splash tears down before content exists. Routes required eagerly at Stack mount. | `_layout.tsx`, `app.config.ts:21-25` |
| 3.7 | `getCachedLines` bypasses its TTL when `_offlineDownloaded` — the line catalogue is **never refreshed again**. | `storage.ts:156`, `hooks/index.ts:156` |
| 3.8 | Offline download: progress counts settled (not successful); `setOfflineDataFlag(true)` fires even if every disk write failed; unbounded inner concurrency (~60–80 sockets); no cancellation; no wake lock. | `offlineData.ts:81-186` |

## P4 — Planner

**Verdict: keep, fix, and stop overclaiming.** See "Planner decision" below.

| # | Bug | Location |
|---|---|---|
| 4.1 | **Boarding rule minimizes the wrong quantity.** Should minimize `prevArrival(bi) − times[bi]`; minimizes `prevArrival(bi)`. Systematically boards too early on the route — sends the user to the wrong stop (worked example: 29 min error). | `raptorScan.ts:89-98`, dup at `tripExtraction.ts:222` |
| 4.2 | Pass 2 (the mechanism meant to catch 4.1) is disabled — `seenKeys.add(key)` runs unconditionally in Pass 1. | `tripExtraction.ts:190-191,259` |
| 4.3 | `walkToOriginMin` measured from the nearest origin stop, not the pin — hides up to ~13 min and inflates the ranking. | `tripExtraction.ts:87-101` |
| 4.4 | `Total` and `Arrive` on the same card use different formulas (waits excluded vs included); `arrivalMin` is a third quantity. | `planner.ts:149-166`, `PlannerScreen.tsx:571-578` |
| 4.5 | **Dual-sort comparator is intransitive** — a 3-min tie window is not an equivalence relation. Verified: 3 elements, 6 permutations → 4 different orderings. | `planner.ts:181-186` |
| 4.6 | `MAX_TRANSFER_WAIT_MIN = 30` deletes all multi-leg results off-peak → "No bus routes found" every evening. | `scoring.ts:326,510-513` |
| 4.7 | Midnight wrap yields **negative** waits (`afterMin` can exceed 1440) which run the clock backwards. | `scoring.ts:341-357` |
| 4.8 | Circular lines resolve to `'come'` and find no schedule (see live-data note above). `-1 → 'come'` fallback. | `scoring.ts:38,168,411`, `FavoriteStopCard.tsx:160` |
| 4.9 | Stop order never validated — `RouteStopOrder` exists and is unused; array index is assumed to be route position. | `raptorIndex.ts:69` |
| 4.10 | `MAX_ROUNDS = 3` is a lie: only routes touching origin/destination candidates are indexed, so a 3-leg middle route is absent. It is a 2-leg planner burning CPU on round 3. | `constants.ts:13`, `raptorIndex.ts:45-55` |
| **PERF** | **Pass 3 is 80–95 % of runtime.** 5-deep loop nest (0.5–2 M tuples); `seenKeys.add` sits *after* the cutoff `continue`, so failing pairs are never memoized and redo the full origin scan every time. Est. **6–30 s on Hermes**. | `tripExtraction.ts:268-345` |
| **PERF** | Index rebuilt from scratch every search — transfer graph alone is 290k–560k objects (~25–50 MB), and it depends only on the route set, not the pins. `stopInfo` built for all 9,000 stops regardless of scope. | `planner.ts:95`, `raptorIndex.ts:33-39,110-158` |
| **UX** | No cancellation (`genRef` discards the result; the work runs on). Blank panel when GPS has no fix. One marker per intermediate stop (~120 native views). | `PlannerScreen.tsx:125-138,106,213-228` |

Total realistic wall clock today: **~8–35 s of fully blocked JS thread** in central Athens.

## P5 — UX

- **Information hierarchy is inverted.** The arrival minutes — the app's entire reason to exist — are `font.size.xs` = **11 px** in a badge at the end of a 5-element row, under a 28 px wordmark. `FavoriteStopCard.styles.ts:67-71`, `HomeScreen.styles.ts:24-28`
- **Zero accessibility in the whole app** — 0 occurrences of `accessibilityLabel`/`Role`/`Hint`. `{min}'` is announced as "4 feet". Multiple sub-44 pt targets.
- **Zero haptics.** The only way to delete a saved stop is a long-press advertised in 10 px at 50 % opacity.
- **Greek accent-insensitive search missing** — typing `αθηνα` returns nothing for `Αθήνα`. Filter also allocates ~1,400 lowercased strings per keystroke, undebounced. `SearchScreen.tsx:30-39`
- No freshness signal; numbers freeze silently for 15 s and on failure forever.
- Network failure renders as "No lines found" / "no service", with no retry anywhere.
- Home list is a `FlatList` with `data={[]}` and everything in `ListHeaderComponent` — zero virtualization; every card fires ~10 requests on mount. `HomeScreen.tsx:199-243`
- Modals: `autoFocus` number-pad covers the Cancel/Start buttons; no `KeyboardAvoidingView`; inconsistent dismiss rules.
- Update overlay is modal, uncancellable, and re-nags on every launch.
- Offline banner is a sibling above `<Stack/>` → every Wi-Fi/cellular handoff shifts the whole app down ~26 px, unanimated.
- Hardcoded `paddingTop: 56` renders under the Dynamic Island.
- Accent color only half-wired (title, spinners, StampModal stay hardcoded).
- `ScheduleGrid` re-scrolls to "next" on every layout pass; allocates a `Date` per cell.

## P6 — Security / build

| # | Issue | Location |
|---|---|---|
| 6.1 | **Release APKs are signed with the public AOSP debug key.** Verified: `CN=Android Debug`, `SHA1 5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`, password `android`. CI publishes these to GitHub Releases. | `android/app/build.gradle:112-115` |
| 6.2 | 6.1 **breaks the self-updater's trust model** — the only integrity check is Android's same-certificate rule, and that certificate is public. With `REQUEST_INSTALL_PACKAGES` granted, a tampered APK is arbitrary code execution. No checksum, no host allowlist. | `services/updater.ts:85-135` |
| 6.3 | 6.1 also defeats Google Maps key restriction (SHA-1 + package name are both public). Key was **never committed** (verified `git log --all -S`) but is plaintext in the APK. Rotate + set a billing cap. | `.env`, `app.config.ts:44-49` |
| 6.4 | `usesCleartextTraffic="true"` applies to **every** host. Scope it to `telematics.oasa.gr` via `networkSecurityConfig`. | `plugins/withAndroidOptimizations.js:39` |
| 6.5 | Manifest requests `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `READ/WRITE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW` transitively (expo-av, expo-file-system). A bus tracker asking for the microphone is a Play-review flag. | generated manifest |
| 6.6 | `versionCode = Σ part × 100^(2-i)` — any component ≥ 100 collides; a 4-part version yields a **fractional** versionCode and fails the build. | `app.config.ts:6-9` |
| 6.7 | Updater: not semver (any `-rc1` tag silently disables updates); server-controlled filename used as a path component; deprecated `INSTALL_PACKAGE` intent; downloaded APK never deleted. | `services/updater.ts:24-34,106,132-152` |
| 6.8 | `firebase-debug.log` untracked and not gitignored. Dead `eas.json` conflicts with the local `versionCode`. arm64-only APK is undocumented. | repo root |

---

## Live ride times ARE available (corrects an earlier claim in this doc)

Verified 2026-08-07 by scanning every stop of route 5044 and matching `veh_code`:

```
veh 12242:  #14=1'  #15=2'  #16=3'  #17=5'  #18=7'  #19=8'  #20=10' #21=11' #22=13'
            #23=19' #24=20' #25=21' ... #40=38' #41=39' #42=40'
```

`getStopArrivals` publishes a **complete live predicted arrival profile per vehicle across its
entire route**, monotonically increasing in `RouteStopOrder`. Measured horizon: **≥ 40 minutes**.

**Consequence for the planner:** ride time for a leg is obtainable exactly, live and traffic-aware,
for **one extra API call** — the board stop is already queried for the wait time, so also query the
alight stop and match `veh_code`:

```
rideMin = btime2(alightStop, veh) − btime2(boardStop, veh)
```

This replaces `haversine ÷ 16 km/h` (`raptorIndex.ts:86-92`), the single worst component of the
engine, and makes the displayed board/alight clock times honest for near-term trips.

Limits that remain:
- No **static** timetable at intermediate stops → cannot plan a trip at an arbitrary future time.
- Outside the ~40 min horizon (and for a leg 2 whose vehicle is not yet dispatched) you must fall
  back to an estimate. Mitigation: cache observed `(routeCode, stopA→stopB, hourOfDay)` ride times
  as they are seen and use the median as the fallback — the table self-populates with use and
  degrades gracefully.
- Circular routes report the same `StopCode` at first and last position with identical `btime2`
  (confirmed on 5044 and 2484) — must be special-cased. Same root cause as bug 4.8.

Use haversine only as the cold-start fallback, never as the primary estimate.

## Planner decision

**Keep it — but delete Pass 3, cache the index, fix the ranking bugs, and drive leg times from
live arrival profiles instead of haversine.**

The case for deleting is real: it is the app's weakest surface, it can send you to the wrong bus stop, and it freezes the thread for up to half a minute. But the fix set is smaller than it looks, because the cost and the errors are concentrated:

- **Pass 3 is 80–95 % of runtime** and largely duplicates a Pass 2 that is currently disabled by a one-line bug. Deleting Pass 3 and caching the pin-independent index (the transfer graph does not depend on the pins) takes the search from ~8–35 s to roughly 1–2 s.
- The ranking defects — 4.1, 4.3, 4.4, 4.5 — are each a few lines.

Per the section above, the accuracy ceiling is **much higher than a first read of the API suggests**.
For "leave now" trips inside the ~40 min horizon the planner can show measured, traffic-aware times
and honest board/alight clocks. Outside that horizon it degrades to the empirical cache, then to
haversine — and the UI must say which of the three it is rather than printing every case to the
minute with equal confidence.

Alternatives weighed and rejected:
- **Google Directions transit** — needs billing plus a key-hiding proxy (mandatory, since 6.1 makes
  the key unprotectable), kills offline planning, and — critically — it plans against the *static*
  GTFS timetable, so it does **not** know that the 040 is currently 11 minutes late. The live
  profile above is strictly better information for a "leave now" trip.
- **Self-hosted OTP2** — real timetables, but a VM and a GTFS pipeline to maintain for a hobby app,
  and a single point of failure. Same staleness caveat versus live data.

Both are better at *future* trip planning and worse at the thing this app is actually for. Keeping
the planner also preserves the README's headline feature, and deleting it later stays cheap.

## Sequencing

P0 → P1 → P2 → P3 → P4 → P5, with P6 interleaved (it is mostly config).
P1 and P2 are where the "feels slow and janky" complaint actually lives.

---

# Outcome (2026-08-07)

Executed as six parallel workstreams over disjoint file sets, plus a shared
foundation landed first. Branch `revive/audit-fixes`, 4 commits.

## Verified

- `npx tsc --noEmit` — **0 errors** across 50 changed files.
- `expo prebuild --platform android --clean` — succeeds.
- **Release manifest audited from the merged output**: `RECORD_AUDIO`,
  `MODIFY_AUDIO_SETTINGS`, `READ/WRITE_EXTERNAL_STORAGE` and
  `SYSTEM_ALERT_WINDOW` are all gone; `usesCleartextTraffic` is absent;
  `networkSecurityConfig` is scoped to `telematics.oasa.gr`. The debug variant
  keeps cleartext and the overlay permission so Metro and the dev menu work.
- **The manifest-merger concern about the debug `tools:replace` did not
  materialise** — `processDebugMainManifest` and `processReleaseMainManifest`
  both succeed.
- **Signing guard fires**: `packageRelease` without credentials fails with
  "Refusing to fall back to the public AOSP debug key."
- **Full release build succeeds with credentials** — verified with a throwaway
  keystore generated outside the repo and deleted afterwards. 27 MB APK,
  `apksigner` confirms the supplied cert (not `CN=Android Debug`), v2+v3.
- No keystore, secret, or `.env` is tracked by git.

## NOT verified

**Nothing has been run on a device or emulator.** The Android toolchain here
builds, but WSL2 has no usable emulator, so there is no runtime confirmation
of: the bus-animation rewrite (`setNativeProps` path), map smoothness, the
planner's live-hydration timings, haptics, the splash handoff, or the alert
foreground service. Those need a sideload.

Known runtime watch-items:
- The `MarkerAnimated` → `setNativeProps` path emits a one-time deprecation
  warning per instance on Fabric. Expected, noisy in dev.
- First debug build after the permission changes is worth an eye.

## Deferred

- **3-leg trips.** The planner is honestly a 2-leg planner (`MAX_ROUNDS = 2`);
  indexing enough of the network for a real round 3 is a larger change.
- **Two concurrent arrival alerts.** Still one global watch; the collision is
  now reported to the user instead of being silent.
- **Schedule-grid virtualization.** ~150 cells in a nested ScrollView; a wrap
  layout cannot be virtualized with the available primitives. Cells are
  memoized instead.
- **`canRequestPackageInstalls()` pre-check** — unreachable from JS with the
  current dependency set.

## Owner actions required

1. Generate the release keystore and set the GitHub secrets (exact commands in
   README → "Release signing"). **This is a breaking change**: users must
   uninstall/reinstall.
2. **Ship a build containing the Settings → Export/Restore pane BEFORE the
   re-signed release**, or the migration notice references a button users do
   not have yet.
3. Rotate the Google Maps key, restrict it to the new signing SHA-1, and set a
   billing quota cap.
4. Publish `<apk>.apk.sha256` with each release (the workflow now does this) —
   without a digest the updater's integrity check degrades to size-only.
