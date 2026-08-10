import { ExpoConfig, ConfigContext } from "expo/config";

// Single source of truth: version from package.json
const { version } = require('./package.json');

/**
 * Android versionCode, derived from the semver in package.json.
 *
 * The old formula was `Σ part × 100^(2-i)`, which broke in two ways: any
 * component ≥ 100 collided with the next one up (`1.0.100` and `1.1.0` both
 * produced 10100), and a four-part version added `Math.pow(100, -1)` → a
 * fractional versionCode that fails the Android build outright.
 *
 * `major × 1e6 + minor × 1e3 + patch` gives each component a full thousand and
 * still leaves headroom under Google's 2 100 000 000 ceiling. It is also
 * strictly larger than anything the old formula could produce for a 1.x
 * release (max 19 999), so codes stay monotonic across the switch.
 */
const MAX_VERSION_CODE = 2_100_000_000;

function computeVersionCode(raw: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (!m) {
    throw new Error(
      `[app.config] package.json version "${raw}" must be exactly MAJOR.MINOR.PATCH. ` +
        'Pre-release tags and four-part versions cannot be mapped to a monotonic ' +
        'Android versionCode.',
    );
  }
  const [major, minor, patch] = m.slice(1).map(Number);
  if (minor > 999 || patch > 999) {
    throw new Error(
      `[app.config] version "${raw}" has a component ≥ 1000; minor and patch must ` +
        'stay below 1000 or versionCodes start colliding.',
    );
  }
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (code > MAX_VERSION_CODE) {
    throw new Error(
      `[app.config] versionCode ${code} exceeds the Android maximum of ${MAX_VERSION_CODE}.`,
    );
  }
  return code;
}

const versionCode = computeVersionCode(version);

/**
 * Missing key used to fall back to `""`, which builds fine and then shows a
 * grey rectangle where the map should be — with nothing in the logs to explain
 * it. Fail at config time instead, where the message can say what to do.
 */
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
if (!googleMapsApiKey) {
  throw new Error(
    '[app.config] GOOGLE_MAPS_API_KEY is not set. Every map screen renders blank ' +
      'without it. Put it in .env (gitignored) for local builds, or set the ' +
      'GOOGLE_MAPS_API_KEY repository secret for CI. See README → "Google Maps key".',
  );
}

/**
 * Cloud-based map style ID.
 *
 * The new Google Maps renderer (maps_core) ignores the legacy JSON
 * `customMapStyle` prop, which is why the dark theme silently stopped applying
 * and the app started drawing a stark white map inside an OLED-black UI. Cloud
 * styling is the supported replacement: the style lives against this Map ID in
 * the Cloud Console rather than in the bundle.
 *
 * Not a secret — a Map ID is a public identifier and is visible in tile
 * requests — so it has a committed default and does not gate the build the way
 * the API key does. Override per-environment with GOOGLE_MAPS_MAP_ID.
 */
const googleMapsMapId = process.env.GOOGLE_MAPS_MAP_ID || 'e5d6168c8f0f60a4fe8c9747';

/**
 * Optional application-id suffix, for a build that installs *alongside* the
 * real app instead of replacing it.
 *
 * `OASA_APP_ID_SUFFIX=.dev npx expo prebuild && ./gradlew assembleDebug` gives a
 * separate app with its own data, so a debug build can be put on the same phone
 * as the installed release without the signature clash (different key) or the
 * data loss (same package). That matters more than it sounds: a release build is
 * bridgeless, and **nothing it logs reaches logcat** — `console.log` under
 * `ReactNativeJS` produces no output at all — so a shipped APK cannot be
 * diagnosed from its own diagnostics, and the alternative to this suffix is
 * uninstalling the user's app to get at a debuggable one.
 *
 * The Maps key is restricted to the real package, so a suffixed build shows a
 * blank basemap. Everything drawn *over* the map — markers, polylines, controls
 * — and every gesture still behaves normally, which is enough for anything but
 * judging the tiles.
 *
 * Unset in CI, so releases are unaffected.
 */
const appIdSuffix = process.env.OASA_APP_ID_SUFFIX ?? '';
const applicationId = `com.itshix.fckoasa${appIdSuffix}`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: appIdSuffix ? `F*ck OASA ${appIdSuffix.replace(/^\./, '')}` : "F*ck OASA",
  slug: "fck-oasa",
  version,
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "dark",
  newArchEnabled: true,
  scheme: "fck-oasa",
  // Generates the Android launch theme. Note there is no `expo-splash-screen`
  // dependency, so nothing holds the splash open past the first React frame —
  // app/_layout.tsx paints its own branded loading view to cover the gap.
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#000000",
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: applicationId,
  },
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#000000",
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    // Fully-qualified names only — the bare `ACCESS_*` spellings that used to
    // sit alongside them expand to the same permission and just made the list
    // look like it requested six things instead of four.
    // Permissions pulled in transitively by expo-av / expo-file-system are
    // stripped in plugins/withAndroidOptimizations.js (BLOCKED_PERMISSIONS).
    permissions: [
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.REQUEST_INSTALL_PACKAGES",
    ],
    versionCode,
    package: applicationId,
    config: {
      googleMaps: {
        apiKey: googleMapsApiKey,
      },
    },
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-router",
    [
      "expo-location",
      {
        locationWhenInUsePermission: "Used to find nearby bus stops.",
      },
    ],
    "expo-font",
    [
      "expo-notifications",
      {
        icon: "./assets/notif-icon.png",
        color: "#F59E0B",
      },
    ],
    "./plugins/withAndroidOptimizations",
  ],
  extra: {
    router: {},
    googleMapsMapId,
    eas: {
      projectId: "4fab4ff0-2a2e-4acb-ba11-d827c6c0ad26",
    },
  },
});
