import { ExpoConfig, ConfigContext } from "expo/config";

// Single source of truth: version from package.json
const { version } = require('./package.json');

// Auto-compute Android versionCode from semver: 1.2.3 → 10203
const versionCode = version
  .split('.')
  .reduce((acc: number, part: string, i: number) => acc + Number(part) * Math.pow(100, 2 - i), 0);

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "F*ck OASA",
  slug: "fck-oasa",
  version,
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "dark",
  newArchEnabled: true,
  scheme: "fck-oasa",
  splash: {
    image: "./assets/splash-icon.png",
    resizeMode: "contain",
    backgroundColor: "#000000",
  },
  ios: {
    supportsTablet: false,
    bundleIdentifier: "com.itshix.fckoasa",
  },
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#000000",
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    permissions: [
      "ACCESS_FINE_LOCATION",
      "ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.POST_NOTIFICATIONS",
    ],
    versionCode,
    package: "com.itshix.fckoasa",
    config: {
      googleMaps: {
        apiKey: process.env.GOOGLE_MAPS_API_KEY ?? "",
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
    eas: {
      projectId: "4fab4ff0-2a2e-4acb-ba11-d827c6c0ad26",
    },
  },
});
