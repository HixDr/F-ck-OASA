# F*ck OASA

Real-time Athens bus tracker with live map, nearby stops, trip planner, and metro overlay.
Built with React Native + Expo, TypeScript, and react-native-maps.

## Features the official OASA app doesn't have

### Major
- **Trip planner** — direct and one-transfer bus itineraries between any two points, ranked by
  when you actually arrive. Ride times are measured from live vehicle positions where possible
  and fall back to distance estimates elsewhere; the results panel says which is which instead of
  quoting a confident wrong number
- **Full offline mode** — download all stops, routes, and schedules for use without internet
- **Arrival alerts** — get notified when a bus is within X minutes of your stop
- **Dark mode map** — full dark-themed Google Maps
- **Saved stops dashboard** — per-stop arrival board with line filtering and inline schedule

### Minor
- **Smooth bus animation** — buses glide along routes between API polls instead of jumping
- **Walking directions** — tap a stop to see walking time and route via OpenStreetMap
- **Metro & tram overlay** — see metro/tram lines on the map alongside bus routes
- **Custom map stamps** — long press to pin locations
- **Direction hints** — routes show "to [destination]" so you know which way the bus is going
- **Stale bus positions** — shows last-known bus locations for up to 1 hour when offline

## Architecture

```
app/                     Expo Router screens (thin re-export wrappers)
src/
  types/                 TypeScript declarations
  theme/                 Colors, fonts, spacing, Google Maps style
  data/                  Static data (metro polylines, stamps, user marker)
  utils/                 Pure helpers (schedule parsing, geo, color)
  services/
    api.ts               OASA telematics client (HTTPS first, HTTP failover)
    appState.ts          AppState → React Query focusManager bridge; single
                         place to subscribe to foreground/background
    network.ts           NetInfo → React Query onlineManager bridge
    storage.ts           AsyncStorage + file-backed dict caches
    location.ts          Permissions, smoothed position + heading stream
    notifications.ts     Arrival alerts, foreground service, audio
    offlineData.ts       Bulk download of stops/routes/schedules
    updater.ts           GitHub Releases self-updater
  hooks/                 Shared React hooks (linesMap, initialRegion, user location,
                         marker tracking)
  components/            Shared UI (ScheduleGrid, AlertPickerModal, UserLocationMarker, etc.)
  features/
    home/                HomeScreen + styles
    search/              SearchScreen
    planner/             PlannerScreen + routing engine (index, scan, extraction,
                         ride times, scoring)
    map/                 LiveMapScreen, NearbyMapScreen, bus interpolation, map utils
    settings/            SettingsProvider (icon style, preferences)
plugins/
  withAndroidOptimizations.js
                         Android build config that survives `expo prebuild`:
                         arm64-only, R8, release signing, network security
                         config, permission stripping
patches/                 patch-package patches (react-native-maps, react-native-background-actions)
```

## Supported devices

The release APK ships **arm64-v8a only**. This halves the download and covers every Android
phone sold since roughly 2017, but it means the APK will **not install** on:

- 32-bit `armeabi-v7a` devices (pre-2017 budget phones)
- `x86_64` emulators — including the default Android Studio AVD

To run on an emulator, build locally after removing the `reactNativeArchitectures` override in
`plugins/withAndroidOptimizations.js`.

## Dev

```bash
npm install
npx expo start --tunnel --clear
```

Scan the QR code with Expo Go on your phone.

`GOOGLE_MAPS_API_KEY` must be set (see below) — `app.config.ts` now fails loudly rather than
silently producing a blank grey map.

### Testing on a real phone from WSL2

See **[docs/device-testing-wsl2.md](docs/device-testing-wsl2.md)**. Read it before debugging adb
rather than after: three unrelated problems all present as "adb is hanging", including two adb
binaries fighting over one server — which looks exactly like the phone dropping its wireless
connection every few minutes.

### Keeping Expo packages in sync

Several packages drifted behind their SDK 54 pins. `package.json` carries the expected ranges;
run this once to install them:

```bash
npx expo install --fix
```

## Google Maps key

The key lives in `.env` (gitignored, never committed) and is read by `app.config.ts`:

```
GOOGLE_MAPS_API_KEY=AIza...
```

CI reads it from the `GOOGLE_MAPS_API_KEY` repository secret.

It is embedded in the APK in plaintext — that is unavoidable for the Maps SDK, so the real
mitigation is a **key restriction**, not secrecy:

1. **Rotate the key.** Any key that existed while the app was signed with the public debug key
   should be considered exposed: the "restrict to package + SHA-1" control was worthless,
   because anyone could produce an APK with the same package name and the same signature.
2. In Google Cloud Console → *Credentials*, restrict the new key to **Android apps** with
   package name `com.itshix.fckoasa` and the SHA-1 of the **new** release keystore
   (see below for how to print it).
3. Restrict the key's **API targets** to *Maps SDK for Android* only.
4. Set a **Cloud Billing budget + quota cap** so a leaked key cannot run up a bill.

### Diagnosing a blank map

A blank map is always an authorization problem, never an app bug — and the symptom is
deceptive. The map *surface* renders normally (Google watermark, recenter control, and all app
overlays draw fine); only the tiles are missing, leaving a blank beige rectangle. It looks
exactly like a broken MapView or a dead network.

**Get the real reason from logcat — do not theorise from the blank screen:**

```bash
adb logcat -c && adb shell am force-stop com.itshix.fckoasa
# open the map in the app, then:
adb logcat -d | grep -A6 "Google Android Maps SDK"
```

**Then test the key itself before touching any code.** This takes 20 seconds and rules out
the most common cause outright:

```bash
curl -s "https://maps.googleapis.com/maps/api/geocode/json?address=Athens&key=$GOOGLE_MAPS_API_KEY" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status'),d.get('error_message',''))"
```

Read the message carefully — the two failure modes look identical on screen but need opposite fixes:

| Message | Meaning | Fix |
|---|---|---|
| `The provided API key is invalid.` | The key **does not exist**. Deleted, or the Cloud project was suspended / lost billing. | Create a new key. A restriction change will not help. |
| `This IP, site or mobile application is not authorized…` | The key exists but the **(package, SHA-1)** pair does not match its Android restriction. | Add the signing SHA-1 to the restriction. |

> **⚠️ The signing migration will trigger the second one.** The restriction matches on
> (package name, certificate SHA-1), so the moment you sign with the new release keystore the
> package still matches but the certificate does not. Add the new SHA-1 to the key restriction
> **before** shipping — a key can carry several fingerprints at once, so add the new one
> alongside the old and cut over safely.

*(Observed 2026-08-07: the committed key returned `The provided API key is invalid` — it had
lapsed during the project's idle period, so every build had a blank map regardless of signing.)*

## Release signing

> **The previous release APKs were signed with the public AOSP debug keystore** that ships inside
> every copy of React Native (`CN=Android Debug`, alias `androiddebugkey`, password `android`).
> Anyone could build a signature-compatible "update" for them. The build now refuses to produce a
> release APK unless real signing material is supplied.

### 1. Generate the keystore (once, on your machine)

```bash
keytool -genkeypair -v \
  -keystore oasa-release.keystore \
  -storetype PKCS12 \
  -alias oasa-release \
  -keyalg RSA -keysize 4096 \
  -validity 10000 \
  -dname "CN=F*ck OASA, OU=Mobile, O=itshix, L=Athens, C=GR"
```

`keytool` prompts for the store password — do not pass `-storepass` on the command line, it ends
up in your shell history. For a PKCS12 keystore the key password **is** the store password, so
`OASA_KEY_PASSWORD` and `OASA_KEYSTORE_PASSWORD` are the same value.

**Back the keystore up somewhere you will still have in ten years.** Losing it means you can
never ship an update that existing installs will accept — the same uninstall/reinstall break
described below, but forever, every time.

### 2. Print the SHA-1 for the Maps key restriction

```bash
keytool -list -v -keystore oasa-release.keystore -alias oasa-release | grep -E 'SHA1|SHA256'
```

### 3. Upload the secrets

```bash
base64 -w0 oasa-release.keystore > oasa-release.keystore.b64

gh secret set KEYSTORE_BASE64 < oasa-release.keystore.b64
gh secret set OASA_KEY_ALIAS --body oasa-release
gh secret set OASA_KEYSTORE_PASSWORD    # prompts, input hidden
gh secret set OASA_KEY_PASSWORD         # prompts, same value as above

rm oasa-release.keystore.b64
```

`.gitignore` covers `*.keystore`, `*.keystore.b64` and `keystore.properties`, but the keystore
still does not belong in the repo.

### 4. Signing a release locally

```bash
export OASA_KEYSTORE_PATH="$PWD/oasa-release.keystore"
export OASA_KEYSTORE_PASSWORD='…'
export OASA_KEY_ALIAS=oasa-release
export OASA_KEY_PASSWORD='…'

npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

Without those variables `assembleRelease` fails with an explicit error instead of falling back to
the debug key. `assembleDebug` is unaffected and still uses the debug keystore.

`OASA_KEYSTORE_PATH` defaults to `oasa-release.keystore` relative to `android/app/`, so an
absolute path is the safer option — `expo prebuild --clean` deletes `android/`.

## Build APK

```bash
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

APK output: `android/app/build/outputs/apk/release/app-release.apk`

CI (`.github/workflows/build-release.yml`) does the same on every push to `main`, then verifies
the signing certificate is not the AOSP debug key, publishes the APK to a GitHub Release tagged
`v<version>` and uploads a `…apk.sha256` alongside it.

**Publishing the digest is a required release step.** The in-app updater looks for a companion
`<apk-name>.apk.sha256`, `SHA256SUMS` or `checksums.txt` asset (or a bare 64-hex token in the
release body) and verifies the download against it. When none is present it falls back to a
size-only check and logs a warning — which is not a real integrity gate. If you ever publish a
release by hand, attach the checksum:

```bash
sha256sum fck-oasa-v1.2.3.apk > fck-oasa-v1.2.3.apk.sha256
```

### Prerequisites

- Node.js 18+
- Java 17 (`sudo apt install openjdk-17-jdk`)
- Android SDK (`$ANDROID_HOME` set, platform-tools + build-tools installed)

## Migration notice — the signing key change

The first release built with the real keystore has a **different signing certificate** from every
previous build. Android refuses to install an APK over an existing app with a different
certificate, so this is a one-time breaking upgrade. Paste something like this into the release
notes:

> ### ⚠️ This update requires a reinstall
>
> This build is signed with a proper release key. Every version before it was signed with React
> Native's public debug key, which meant anyone could have published a fake "update" for it.
>
> Android will not install this on top of the old app — you have to **uninstall the old version
> first**. Uninstalling clears the app's local data: saved stops, downloaded offline data,
> accent colour and other preferences.
>
> **Before you uninstall:** open the ⚙ Settings sheet → *Export*, and send the backup somewhere
> you can get at it afterwards (email it to yourself, drop it in Keep/Notes — anything that
> survives the uninstall). After installing this version, open the same sheet → *Restore*, paste
> the backup in, and your saved stops, lines and stamps come back. Offline data has to be
> downloaded again.
>
> The in-app updater cannot do this for you — a signature change is exactly the case Android is
> designed to block. After this one, updates go back to being seamless.

The Export/Restore pane lives in `src/components/SettingsModal.tsx` and is wired to
`exportUserData` / `importUserData` in `src/services/storage.ts`. **Ship a build containing that
pane, and give people time to install it, before publishing the re-signed release** — otherwise
the notice above tells users to use a button their current app does not have.
