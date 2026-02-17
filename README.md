# F*ck OASA

Real-time Athens bus tracker with live map, nearby stops, and metro overlay.

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
