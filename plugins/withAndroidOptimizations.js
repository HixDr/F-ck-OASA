/**
 * Expo config plugin — applies Android build optimizations that
 * survive `npx expo prebuild --clean`.
 *
 * - arm64-only build (drops x86/armeabi, saves ~40MB)
 * - R8 minification enabled
 * - Resource shrinking enabled
 * - Cleartext HTTP allowed (OASA API uses plain HTTP)
 */

const { withGradleProperties, withAndroidManifest } = require('expo/config-plugins');

function withAndroidOptimizations(config) {
  // Gradle properties: ABI split + R8
  config = withGradleProperties(config, (cfg) => {
    const props = cfg.modResults;

    const set = (key, value) => {
      const existing = props.find((p) => p.type === 'property' && p.key === key);
      if (existing) {
        existing.value = value;
      } else {
        props.push({ type: 'property', key, value });
      }
    };

    set('reactNativeArchitectures', 'arm64-v8a');
    set('android.enableMinifyInReleaseBuilds', 'true');
    set('android.enableShrinkResourcesInReleaseBuilds', 'true');

    return cfg;
  });

  // AndroidManifest: enable cleartext HTTP traffic
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) {
      app.$['android:usesCleartextTraffic'] = 'true';
    }
    return cfg;
  });

  return config;
}

module.exports = withAndroidOptimizations;
