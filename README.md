# F*ck OASA

Real-time Athens bus tracker with live map, nearby stops, and metro overlay.

## Features the official OASA app doesn't have

### Major
- **Full offline mode** — download all stops, routes, and schedules for use without internet
- **Arrival alerts** — get notified when a bus is within X minutes of your stop
- **Dark mode map** — full dark-themed Google Maps
- **Saved stops dashboard** — per-stop arrival board with line filtering and inline schedule

# Minor
- **Smooth bus animation** — buses glide along routes between API polls instead of jumping
- **Walking directions** — tap a stop to see walking time and route via OpenStreetMap
- **Metro & tram overlay** — see metro/tram lines on the map alongside bus routes
- **Custom map stamps** — long press to pin locations
- **Direction hints** — routes show "to [destination]" so you know which way the bus is going
- **Stale bus positions** — shows last-known bus locations for up to 1 hour when offline

## Dev

```bash
npm install
npx expo start --tunnel --clear
```

Scan the QR code with Expo Go on your phone.

## Build APK

```bash
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

APK output: `android/app/build/outputs/apk/release/app-release.apk`

### Prerequisites

- Node.js 18+
- Java 17 (`sudo apt install openjdk-17-jdk`)
- Android SDK (`$ANDROID_HOME` set, platform-tools + build-tools installed)
