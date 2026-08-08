/**
 * In-app update checker and installer.
 *
 * Compares the running app version against the latest GitHub Release.
 * When a newer version exists, downloads the APK in-app, verifies it, and
 * hands it to the Android package installer.
 *
 * Threat model note: the release APK is signed with the public AOSP debug
 * key, so Android's "same signing certificate" rule proves nothing about who
 * produced the file. HTTPS to github.com is the only real guarantee we get,
 * which is why the asset URL is allowlisted and the payload is checked
 * against a published digest whenever one exists.
 */

import { Alert, Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
// Transitive dependency (expo-notifications pulls it in) and therefore
// autolinked. It reports the *installed binary's* versionName, which is what
// an APK-based updater has to compare against.
import * as Application from 'expo-application';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { startActivityAsync, ActivityAction } from 'expo-intent-launcher';
import { fetchWithTimeout } from './api';

const REPO = 'HixDr/F-ck-OASA';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

const CHECK_TIMEOUT_MS = 10_000;
/** Abort the download if it makes no progress for this long. `downloadAsync`
 *  has no timeout of its own and OkHttp's read timeout is unbounded. */
const STALL_TIMEOUT_MS = 30_000;
/** Sanity ceiling — this app's APK is ~40 MB. */
const MAX_APK_BYTES = 200 * 1024 * 1024;

/** GitHub serves release assets from these hosts (api.github.com redirects to
 *  the object store). A `browser_download_url` pointing anywhere else did not
 *  come from a release we trust. */
const ALLOWED_ASSET_HOSTS = ['github.com', 'githubusercontent.com'];

const SKIPPED_KEY = '@oasa/updater/skippedVersion';
const LAST_CHECK_KEY = '@oasa/updater/lastCheckAt';
/** Cold starts are frequent; re-nagging on every one is why users turn this
 *  off entirely. */
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/* Intent flags — expo-intent-launcher takes a raw bitmask. */
const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

interface GHAsset {
  browser_download_url: string;
  name: string;
  size: number;
}

interface GHRelease {
  tag_name: string;
  body: string;
  assets: GHAsset[];
}

export interface UpdateProgress {
  phase: 'checking' | 'downloading' | 'verifying' | 'installing' | 'idle';
  progress: number; // 0–1
}

type ProgressCallback = (p: UpdateProgress) => void;

/**
 * How a check ended, for callers that have to say something afterwards.
 *
 * The boot-time check ignores this — it either prompts or stays quiet, and
 * silence is the correct output. An explicit "check for updates" cannot work
 * that way: every branch below used to resolve as an indistinguishable `void`,
 * and the progress callback is no help either because all of them report
 * `idle` on the way out. A Settings button therefore had no way to tell "you
 * are up to date" from "GitHub was unreachable", and both look like a button
 * that does nothing.
 */
export type UpdateCheckResult =
  /** No release newer than the installed build. */
  | 'up-to-date'
  /** A newer release exists. The user has already been prompted about it (or
   *  deliberately silenced it earlier) — the caller must not prompt again. */
  | 'update-available'
  /** Inside `CHECK_INTERVAL_MS` of the last check, so no request was made.
   *  Unreachable with `{ force: true }`. */
  | 'throttled'
  /** Not Android, or the running version is unknown: self-update is off. */
  | 'unsupported'
  /** GitHub was unreachable, or its latest release is not installable. */
  | 'failed';

const IDLE: UpdateProgress = { phase: 'idle', progress: 0 };

/* ── Version comparison ───────────────────────────────────────── */

interface ParsedVersion {
  nums: number[];
  /** Dot-separated prerelease identifiers, empty for a release build. */
  pre: string[];
}

/**
 * Parse a semver-ish tag. Accepts a leading `v`, any number of numeric parts,
 * an optional `-prerelease` and an optional `+build` (ignored, per semver).
 */
function parseVersion(raw: string): ParsedVersion | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (!m) return null;
  const nums = m[1].split('.').map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return { nums, pre: m[2] ? m[2].split('.') : [] };
}

/** Semver prerelease precedence. No prerelease outranks any prerelease. */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
      continue;
    }
    if (nx !== null) return -1; // numeric identifiers rank below alphanumeric
    if (ny !== null) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** <0, 0 or >0. Returns null when either side is unparseable. */
function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePrerelease(pa.pre, pb.pre);
}

/**
 * True when `remote` is strictly newer than `local`.
 *
 * The old implementation ran `Number()` over dot-split parts, so a tag like
 * `1.2.0-rc1` produced NaN — and because both `NaN > x` and `NaN < x` are
 * false, the loop fell straight through and reported "no update" forever.
 * Unparseable input now says so out loud instead of failing silently.
 */
function isNewer(remote: string, local: string): boolean {
  const cmp = compareVersions(remote, local);
  if (cmp === null) {
    console.warn(`[updater] cannot compare versions "${remote}" and "${local}" — skipping update`);
    return false;
  }
  return cmp > 0;
}

/* ── Release parsing / validation ─────────────────────────────── */

/** The GitHub response is untrusted JSON; `release.assets.find` on a missing
 *  `assets` threw a TypeError that the bare catch swallowed as "no update". */
function parseRelease(raw: unknown): GHRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.tag_name !== 'string' || !r.tag_name) return null;
  if (!Array.isArray(r.assets)) return null;

  const assets: GHAsset[] = [];
  for (const a of r.assets) {
    if (!a || typeof a !== 'object') continue;
    const asset = a as Record<string, unknown>;
    if (typeof asset.name !== 'string') continue;
    if (typeof asset.browser_download_url !== 'string') continue;
    assets.push({
      name: asset.name,
      browser_download_url: asset.browser_download_url,
      size: typeof asset.size === 'number' && Number.isFinite(asset.size) ? asset.size : 0,
    });
  }
  return { tag_name: r.tag_name, body: typeof r.body === 'string' ? r.body : '', assets };
}

function isAllowedAssetUrl(url: string): boolean {
  const m = /^https:\/\/([^/:?#]+)(?:[/?#]|$)/.exec(url);
  if (!m) return false;
  const host = m[1].toLowerCase();
  return ALLOWED_ASSET_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Reduce an asset name to a safe cache-directory basename. The name comes
 * straight from the release JSON, and `cacheDirectory + '../../databases/x.apk'`
 * writes outside the cache.
 */
function safeApkName(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  if (cleaned.length === 0 || cleaned.length > 128) return null;
  if (!cleaned.toLowerCase().endsWith('.apk')) return null;
  return cleaned;
}

/* ── SHA-256 ──────────────────────────────────────────────────────
 * Hand-rolled: the project has no crypto dependency and adding one is out of
 * scope for this change. If `expo-crypto` is ever added, delete all of this
 * and call `Crypto.digestStringAsync` — the native path is far faster.
 * Hashing ~40 MB in Hermes costs several seconds, which is acceptable because
 * it only runs when a release actually publishes a digest.
 */

const _K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Sha256 {
  private h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private w = new Uint32Array(64);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;

  update(bytes: Uint8Array): void {
    this.total += bytes.length;
    let i = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, bytes.length);
      this.buf.set(bytes.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen === 64) {
        this.block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    for (; i + 64 <= bytes.length; i += 64) this.block(bytes, i);
    if (i < bytes.length) {
      this.buf.set(bytes.subarray(i), 0);
      this.bufLen = bytes.length - i;
    }
  }

  digestHex(): string {
    const pad = new Uint8Array(this.bufLen < 56 ? 64 : 128);
    pad.set(this.buf.subarray(0, this.bufLen));
    pad[this.bufLen] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(this.total / 0x20000000) >>> 0);
    view.setUint32(pad.length - 4, (this.total * 8) >>> 0);
    for (let o = 0; o < pad.length; o += 64) this.block(pad, o);
    let out = '';
    for (let i = 0; i < 8; i++) out += this.h[i].toString(16).padStart(8, '0');
    return out;
  }

  private block(d: Uint8Array, o: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = o + i * 4;
      w[i] = (d[j] << 24) | (d[j + 1] << 16) | (d[j + 2] << 8) | d[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = this.h[0], b = this.h[1], c = this.h[2], d0 = this.h[3];
    let e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + _K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d0 + t1) | 0;
      d0 = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    this.h[0] += a; this.h[1] += b; this.h[2] += c; this.h[3] += d0;
    this.h[4] += e; this.h[5] += f; this.h[6] += g; this.h[7] += h;
  }
}

const _B64 = (() => {
  const table = new Int16Array(256).fill(-1);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i;
  return table;
})();

function base64ToBytes(b64: string): Uint8Array {
  const out = new Uint8Array((b64.length >> 2) * 3 + 3);
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const v = _B64[b64.charCodeAt(i)];
    if (v < 0) continue; // padding / whitespace
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

/** 512 KB per read. Each `await` also yields the JS thread so the UI keeps
 *  breathing while a 40 MB file is hashed. */
const HASH_CHUNK_BYTES = 512 * 1024;

async function sha256File(
  fileUri: string,
  size: number,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  const hash = new Sha256();
  for (let pos = 0; pos < size; pos += HASH_CHUNK_BYTES) {
    const length = Math.min(HASH_CHUNK_BYTES, size - pos);
    const b64 = await LegacyFileSystem.readAsStringAsync(fileUri, {
      encoding: LegacyFileSystem.EncodingType.Base64,
      position: pos,
      length,
    });
    hash.update(base64ToBytes(b64));
    onProgress?.((pos + length) / size);
  }
  return hash.digestHex();
}

/* ── Digest discovery ─────────────────────────────────────────── */

/** Pull a SHA-256 out of `sha256sum`-style text, preferring the line that
 *  names our asset. */
function extractSha256(text: string, apkName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const m = /\b([0-9a-fA-F]{64})\b/.exec(line);
    if (m && line.includes(apkName)) return m[1].toLowerCase();
  }
  // A release that ships a single APK often just pastes the bare digest.
  const only = /\b([0-9a-fA-F]{64})\b/.exec(text);
  return only ? only[1].toLowerCase() : null;
}

/** Companion `.sha256` / `SHA256SUMS` asset first, release notes second. */
async function findExpectedSha256(release: GHRelease, assetName: string): Promise<string | null> {
  const companion = release.assets.find((a) => {
    const n = a.name.toLowerCase();
    return n === `${assetName.toLowerCase()}.sha256`
      || n === 'sha256sums'
      || n === 'sha256sums.txt'
      || n === 'checksums.txt';
  });

  if (companion && isAllowedAssetUrl(companion.browser_download_url)) {
    try {
      const res = await fetchWithTimeout(companion.browser_download_url, {}, CHECK_TIMEOUT_MS);
      if (res.ok) {
        const text = await res.text();
        const digest = extractSha256(text, assetName);
        if (digest) return digest;
      }
    } catch (err) {
      console.warn('[updater] could not fetch the checksum asset:', err);
    }
  }

  return release.body ? extractSha256(release.body, assetName) : null;
}

/* ── Cache hygiene ────────────────────────────────────────────── */

/** A ~40 MB APK per update used to sit in the cache forever. The installer
 *  reads the current file asynchronously, so sweep on the *next* run rather
 *  than deleting it out from under the install. */
async function sweepCachedApks(keep?: string): Promise<void> {
  const dir = LegacyFileSystem.cacheDirectory;
  if (!dir) return;
  try {
    const names = await LegacyFileSystem.readDirectoryAsync(dir);
    await Promise.all(
      names
        .filter((n) => n.toLowerCase().endsWith('.apk') && n !== keep)
        .map((n) => LegacyFileSystem.deleteAsync(dir + n, { idempotent: true }).catch(() => {})),
    );
  } catch {
    // Cache cleanup is never worth failing an update over.
  }
}

/* ── Public API ───────────────────────────────────────────────── */

/** The installed binary's version. `expoConfig.version` is the JS bundle's
 *  idea of it and can be missing entirely.
 *
 *  Exported so the Settings row can label itself with the same number the
 *  comparison below actually uses — showing the bundle version next to a
 *  "you are up to date" that was decided on the native one invites a bug
 *  report nobody can reproduce. */
export function getCurrentVersion(): string | null {
  const native = Application.nativeApplicationVersion;
  if (native) return native;
  const fromConfig = Constants.expoConfig?.version;
  if (fromConfig) return fromConfig;
  console.warn('[updater] no app version available — self-update disabled');
  return null;
}

type UpdateChoice = 'install' | 'later' | 'skip';

function promptUpdate(remoteVersion: string, currentVersion: string): Promise<UpdateChoice> {
  return new Promise<UpdateChoice>((resolve) => {
    let settled = false;
    const done = (choice: UpdateChoice) => {
      if (settled) return;
      settled = true;
      resolve(choice);
    };
    Alert.alert(
      'Update Available',
      `Version ${remoteVersion} is available (you have ${currentVersion}).`,
      [
        { text: 'Skip this version', style: 'destructive', onPress: () => done('skip') },
        { text: 'Later', style: 'cancel', onPress: () => done('later') },
        { text: 'Install', onPress: () => done('install') },
      ],
      // An Android back-press dismisses the dialog without running any button
      // handler; without onDismiss the promise stayed pending forever.
      { cancelable: true, onDismiss: () => done('later') },
    );
  });
}

/**
 * Check GitHub Releases for a newer version and prompt the user.
 * If the user accepts, downloads the APK in-app, verifies it and triggers the
 * package installer.
 *
 * Throttled to one network check per `CHECK_INTERVAL_MS` and silent about any
 * version the user has skipped. Pass `{ force: true }` from an explicit
 * "check for updates" action: it lifts both, because someone who taps that
 * button is asking about the very version they told us to stop mentioning.
 *
 * Resolves with how the check ended — see `UpdateCheckResult`. Never rejects.
 */
/** In-flight APK download, so it can be cancelled from the UI. */
let _activeDownload: ReturnType<typeof LegacyFileSystem.createDownloadResumable> | null = null;
let _downloadCancelled = false;

/**
 * Abort an in-progress APK download and delete the partial file.
 *
 * Safe to call when nothing is downloading. Returns true if a transfer was
 * actually stopped, so the caller can distinguish "cancelled" from "already
 * finished" and avoid reporting a cancel that did nothing.
 */
export async function cancelUpdateDownload(): Promise<boolean> {
  const download = _activeDownload;
  if (!download) return false;
  _downloadCancelled = true;
  _activeDownload = null;
  try {
    await download.cancelAsync();
  } catch {
    // Already finished or already torn down — the flag above still makes the
    // download path discard whatever landed.
  }
  return true;
}

export async function checkForUpdate(
  onProgress?: ProgressCallback,
  opts: { force?: boolean } = {},
): Promise<UpdateCheckResult> {
  if (Platform.OS !== 'android') return 'unsupported';

  const currentVersion = getCurrentVersion();
  if (!currentVersion) return 'unsupported';

  // Left over from the previous update, whether it installed or not. Awaited
  // so it can never race the download this run may be about to start.
  await sweepCachedApks();

  try {
    if (!opts.force) {
      const lastRaw = await AsyncStorage.getItem(LAST_CHECK_KEY);
      const last = Number(lastRaw);
      if (Number.isFinite(last) && last > 0 && Date.now() - last < CHECK_INTERVAL_MS) {
        return 'throttled';
      }
    }
  } catch {
    // AsyncStorage unavailable — fall through and just check.
  }

  onProgress?.({ phase: 'checking', progress: 0 });

  try {
    const res = await fetchWithTimeout(
      API_URL,
      { headers: { Accept: 'application/vnd.github+json' } },
      CHECK_TIMEOUT_MS,
    );
    if (!res.ok) { onProgress?.(IDLE); return 'failed'; }

    const release = parseRelease(await res.json());
    if (!release) {
      console.warn('[updater] unexpected GitHub release payload');
      onProgress?.(IDLE);
      return 'failed';
    }

    AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now())).catch(() => {});

    const remoteVersion = release.tag_name.replace(/^v/, '');
    if (!isNewer(remoteVersion, currentVersion)) { onProgress?.(IDLE); return 'up-to-date'; }

    if (!opts.force) {
      const skipped = await AsyncStorage.getItem(SKIPPED_KEY).catch(() => null);
      const cmp = skipped ? compareVersions(remoteVersion, skipped) : null;
      if (cmp !== null && cmp <= 0) { onProgress?.(IDLE); return 'update-available'; }
    }

    /* Below here a newer release exists but cannot be installed. That is a
       failed check, not "up to date": telling the user they are current when
       we simply could not use what we found is the one answer that would send
       them looking in the wrong place. The warnings say which case it was. */
    const apk = release.assets.find((a) => a.name.toLowerCase().endsWith('.apk'));
    if (!apk) { onProgress?.(IDLE); return 'failed'; }

    if (!isAllowedAssetUrl(apk.browser_download_url)) {
      console.warn('[updater] refusing off-GitHub asset URL:', apk.browser_download_url);
      onProgress?.(IDLE);
      return 'failed';
    }
    const filename = safeApkName(apk.name);
    if (!filename) {
      console.warn('[updater] refusing unusable asset name:', apk.name);
      onProgress?.(IDLE);
      return 'failed';
    }
    if (apk.size > MAX_APK_BYTES) {
      console.warn('[updater] refusing implausibly large asset:', apk.size);
      onProgress?.(IDLE);
      return 'failed';
    }

    onProgress?.(IDLE);

    const choice = await promptUpdate(remoteVersion, currentVersion);
    if (choice === 'skip') {
      await AsyncStorage.setItem(SKIPPED_KEY, remoteVersion).catch(() => {});
      return 'update-available';
    }
    if (choice !== 'install') return 'update-available';

    const expectedSha256 = await findExpectedSha256(release, apk.name);
    await downloadAndInstall(apk.browser_download_url, filename, apk.size, expectedSha256, onProgress);
    // `downloadAndInstall` reports its own failures through Alert and never
    // throws, so there is nothing left here for the caller to announce.
    return 'update-available';
  } catch (err) {
    console.warn('[updater] update check failed:', err);
    onProgress?.(IDLE);
    return 'failed';
  }
}

/* ── Download / verify / install ──────────────────────────────── */

/**
 * Integrity check for the downloaded APK.
 *
 * Size is always checked against what GitHub reports for the asset. The digest
 * is only checked when the release publishes one; when it does not, this logs
 * loudly and allows the install, because refusing every update would break
 * self-updating for every existing user. Publish a `<asset>.apk.sha256`
 * companion asset (or paste the digest into the release notes) to turn the
 * real check on.
 */
async function verifyApk(
  fileUri: string,
  expectedSize: number,
  expectedSha256: string | null,
  onProgress?: ProgressCallback,
): Promise<string | null> {
  const info = await LegacyFileSystem.getInfoAsync(fileUri);
  if (!info.exists || info.isDirectory) return 'The downloaded file is missing.';
  if (info.size === 0) return 'The downloaded file is empty.';
  if (expectedSize > 0 && info.size !== expectedSize) {
    return `Size mismatch — expected ${expectedSize} bytes, got ${info.size}.`;
  }

  if (!expectedSha256) {
    console.warn(
      '[updater] SECURITY: release publishes no SHA-256 for this APK — installing an ' +
      'unverified binary. Attach a .sha256 asset or put the digest in the release notes.',
    );
    return null;
  }

  onProgress?.({ phase: 'verifying', progress: 0 });
  const actual = await sha256File(fileUri, info.size, (f) =>
    onProgress?.({ phase: 'verifying', progress: f }),
  );
  if (actual !== expectedSha256) {
    console.error(`[updater] digest mismatch: expected ${expectedSha256}, got ${actual}`);
    return 'The downloaded file does not match the published checksum.';
  }
  return null;
}

/** Download APK to cache, verify it, and launch the Android package installer. */
async function downloadAndInstall(
  url: string,
  filename: string,
  expectedSize: number,
  expectedSha256: string | null,
  onProgress?: ProgressCallback,
): Promise<void> {
  const dir = LegacyFileSystem.cacheDirectory;
  if (!dir) {
    Alert.alert('Update Failed', 'No writable cache directory is available.');
    return;
  }
  const fileUri = dir + filename;

  // Start from a clean slate: a truncated file from a previous attempt would
  // make createDownloadResumable append rather than restart.
  await sweepCachedApks();

  try {
    onProgress?.({ phase: 'downloading', progress: 0 });

    let lastProgressAt = Date.now();
    let stalled = false;

    const download = LegacyFileSystem.createDownloadResumable(
      url,
      fileUri,
      { headers: { Accept: 'application/vnd.android.package-archive' } },
      ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
        lastProgressAt = Date.now();
        const p = totalBytesExpectedToWrite > 0
          ? totalBytesWritten / totalBytesExpectedToWrite
          : 0;
        onProgress?.({ phase: 'downloading', progress: p });
      },
    );

    // Publish the handle so the UI's "Later" can actually stop the transfer.
    // Dismissing the overlay used to only hide it — a user on mobile data kept
    // paying for a ~40 MB download they had explicitly declined.
    _activeDownload = download;

    const watchdog = setInterval(() => {
      if (Date.now() - lastProgressAt < STALL_TIMEOUT_MS) return;
      stalled = true;
      download.cancelAsync().catch(() => {});
    }, 5_000);

    let result;
    try {
      result = await download.downloadAsync();
    } finally {
      clearInterval(watchdog);
      _activeDownload = null;
    }
    if (_downloadCancelled) {
      _downloadCancelled = false;
      await LegacyFileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
      onProgress?.(IDLE);
      return;
    }
    if (stalled) throw new Error('Download stalled');
    if (!result || !result.uri) throw new Error('Download failed');

    const problem = await verifyApk(result.uri, expectedSize, expectedSha256, onProgress);
    if (problem) {
      await LegacyFileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => {});
      onProgress?.(IDLE);
      Alert.alert('Update Blocked', `${problem} The update was not installed.`);
      return;
    }

    onProgress?.({ phase: 'installing', progress: 1 });

    // Convert file:// URI to content:// URI (required for Android 7+ FileProvider)
    const contentUri = await LegacyFileSystem.getContentUriAsync(result.uri);

    try {
      // ACTION_VIEW with the package-archive MIME type. INSTALL_PACKAGE has
      // been deprecated since API 29 and is refused outright on newer
      // releases; the read-permission grant is what lets the installer
      // process actually open our content URI.
      await startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        type: 'application/vnd.android.package-archive',
        flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
      });
    } catch (installErr) {
      console.warn('[updater] install intent failed:', installErr);
      Alert.alert(
        'Allow Installation',
        'Android would not open the installer. Enable "Install unknown apps" for this app, then try updating again.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => { void openUnknownSourcesSettings(); } },
        ],
      );
    }

    onProgress?.(IDLE);
  } catch (err) {
    console.error('[updater] download/install failed:', err);
    await LegacyFileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
    onProgress?.(IDLE);
    Alert.alert('Update Failed', 'Could not download or install the update. Try again later.');
  }
}

/**
 * Open the per-app "install unknown apps" toggle.
 *
 * The old code sent the user to `Linking.openSettings()` (the app details
 * page) for *every* startActivity failure, which is not where that switch
 * lives. `PackageManager.canRequestPackageInstalls()` is not reachable from
 * JS here — expo-intent-launcher only starts activities — so the settings
 * screen is offered rather than pre-checked.
 */
async function openUnknownSourcesSettings(): Promise<void> {
  const pkg = Application.applicationId;
  try {
    await startActivityAsync(
      ActivityAction.MANAGE_UNKNOWN_APP_SOURCES,
      pkg ? { data: `package:${pkg}` } : undefined,
    );
    return;
  } catch (err) {
    console.warn('[updater] MANAGE_UNKNOWN_APP_SOURCES unavailable:', err);
  }
  Linking.openSettings().catch(() => {});
}
