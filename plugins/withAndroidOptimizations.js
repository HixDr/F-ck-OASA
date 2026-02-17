/**
 * Expo config plugin — applies Android build optimizations and patches
 * that survive `npx expo prebuild --clean`.
 *
 * - arm64-only build (drops x86/armeabi, saves ~40MB)
 * - R8 minification enabled
 * - Resource shrinking enabled
 * - Cleartext HTTP allowed (OASA API uses plain HTTP)
 * - Foreground service permissions for react-native-background-actions
 * - Patches background-actions to declare mediaPlayback service type (API 34+)
 */

const { withGradleProperties, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withAndroidOptimizations(config) {
  // ─── Gradle properties: ABI split + R8 ──────────────────────
  config = withGradleProperties(config, (cfg) => {
    const props = cfg.modResults;
    const set = (key, value) => {
      const existing = props.find((p) => p.type === 'property' && p.key === key);
      if (existing) existing.value = value;
      else props.push({ type: 'property', key, value });
    };
    set('reactNativeArchitectures', 'arm64-v8a');
    set('android.enableMinifyInReleaseBuilds', 'true');
    set('android.enableShrinkResourcesInReleaseBuilds', 'true');
    return cfg;
  });

  // ─── AndroidManifest: cleartext + foreground service ─────────
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    // Enable cleartext HTTP (OASA API)
    const app = manifest.application?.[0];
    if (app) {
      app.$['android:usesCleartextTraffic'] = 'true';

      // Add foregroundServiceType to background-actions service
      if (!app.service) app.service = [];
      const bgService = app.service.find(
        (s) => s.$['android:name'] === 'com.asterinet.react.bgactions.RNBackgroundActionsTask',
      );
      if (bgService) {
        bgService.$['android:foregroundServiceType'] = 'mediaPlayback';
      } else {
        app.service.push({
          $: {
            'android:name': 'com.asterinet.react.bgactions.RNBackgroundActionsTask',
            'android:foregroundServiceType': 'mediaPlayback',
          },
        });
      }
    }

    // Add foreground service permissions
    if (!manifest['uses-permission']) manifest['uses-permission'] = [];
    const perms = manifest['uses-permission'];
    const addPerm = (name) => {
      if (!perms.find((p) => p.$['android:name'] === name)) {
        perms.push({ $: { 'android:name': name } });
      }
    };
    addPerm('android.permission.FOREGROUND_SERVICE');
    addPerm('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK');
    addPerm('android.permission.WAKE_LOCK');

    return cfg;
  });

  // ─── Dangerous mods: patch sources ────────────────────────────
  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const root = cfg.modRequest.projectRoot;

      // Patch react-native-background-actions to pass foreground service type on API 34+
      const bgActionsFile = path.resolve(
        root,
        'node_modules/react-native-background-actions/android/src/main/java/com/asterinet/react/bgactions/RNBackgroundActionsTask.java',
      );
      if (fs.existsSync(bgActionsFile)) {
        let source = fs.readFileSync(bgActionsFile, 'utf8');
        const oldCall = 'startForeground(SERVICE_NOTIFICATION_ID, notification);';
        const newCall = [
          'if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {',
          '            startForeground(SERVICE_NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);',
          '        } else {',
          '            startForeground(SERVICE_NOTIFICATION_ID, notification);',
          '        }',
        ].join('\n');
        if (source.includes(oldCall) && !source.includes('FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK')) {
          source = source.replace(oldCall, newCall);
          fs.writeFileSync(bgActionsFile, source, 'utf8');
        }
      }

      return cfg;
    },
  ]);

  return config;
}

module.exports = withAndroidOptimizations;
