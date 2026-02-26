/**
 * In-app update checker and installer.
 *
 * Compares the running app version against the latest GitHub Release.
 * When a newer version exists, downloads the APK in-app and triggers
 * the Android package installer directly.
 */

import { Alert, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { startActivityAsync } from 'expo-intent-launcher';

const REPO = 'HixDr/F-ck-OASA';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

interface GHRelease {
  tag_name: string;
  html_url: string;
  assets: Array<{ browser_download_url: string; name: string }>;
}

/** Compare two semver-ish version strings (e.g. "1.2.3" > "1.2.0"). */
function isNewer(remote: string, local: string): boolean {
  const r = remote.replace(/^v/, '').split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] ?? 0;
    const lv = l[i] ?? 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

export interface UpdateProgress {
  phase: 'checking' | 'downloading' | 'installing' | 'idle';
  progress: number; // 0–1
}

type ProgressCallback = (p: UpdateProgress) => void;

/**
 * Check GitHub Releases for a newer version and prompt the user.
 * If user accepts, downloads the APK in-app and triggers the package installer.
 * @param onProgress optional callback for UI progress tracking.
 */
export async function checkForUpdate(onProgress?: ProgressCallback): Promise<void> {
  if (Platform.OS !== 'android') return;

  const currentVersion = Constants.expoConfig?.version;
  if (!currentVersion) return;

  onProgress?.({ phase: 'checking', progress: 0 });

  try {
    const res = await fetch(API_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) { onProgress?.({ phase: 'idle', progress: 0 }); return; }

    const release: GHRelease = await res.json();
    const remoteVersion = release.tag_name?.replace(/^v/, '');
    if (!remoteVersion || !isNewer(remoteVersion, currentVersion)) {
      onProgress?.({ phase: 'idle', progress: 0 });
      return;
    }

    // Find the APK asset
    const apk = release.assets.find((a) => a.name.endsWith('.apk'));
    if (!apk) { onProgress?.({ phase: 'idle', progress: 0 }); return; }

    onProgress?.({ phase: 'idle', progress: 0 });

    // Prompt user
    return new Promise<void>((resolve) => {
      Alert.alert(
        'Update Available',
        `Version ${remoteVersion} is available (you have ${currentVersion}).`,
        [
          { text: 'Later', style: 'cancel', onPress: () => resolve() },
          {
            text: 'Install',
            onPress: () => {
              downloadAndInstall(apk.browser_download_url, apk.name, onProgress)
                .finally(resolve);
            },
          },
        ],
      );
    });
  } catch {
    onProgress?.({ phase: 'idle', progress: 0 });
  }
}

/** Download APK to cache and launch the Android package installer. */
async function downloadAndInstall(
  url: string,
  filename: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  try {
    onProgress?.({ phase: 'downloading', progress: 0 });

    const fileUri = LegacyFileSystem.cacheDirectory + filename;

    const download = LegacyFileSystem.createDownloadResumable(
      url,
      fileUri,
      { headers: { Accept: 'application/vnd.android.package-archive' } },
      ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
        const p = totalBytesExpectedToWrite > 0
          ? totalBytesWritten / totalBytesExpectedToWrite
          : 0;
        onProgress?.({ phase: 'downloading', progress: p });
      },
    );

    const result = await download.downloadAsync();
    if (!result || !result.uri) {
      throw new Error('Download failed');
    }

    onProgress?.({ phase: 'installing', progress: 1 });

    // Convert file:// URI to content:// URI (required for Android 7+ FileProvider)
    const contentUri = await LegacyFileSystem.getContentUriAsync(result.uri);

    // Launch Android package installer via ACTION_VIEW intent
    await startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: 'application/vnd.android.package-archive',
      flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    });

    onProgress?.({ phase: 'idle', progress: 0 });
  } catch (err) {
    console.error('[updater] Download/install failed:', err);
    onProgress?.({ phase: 'idle', progress: 0 });
    Alert.alert('Update Failed', 'Could not download or install the update. Try again later.');
  }
}
