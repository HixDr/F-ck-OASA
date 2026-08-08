/**
 * SettingsModal — icon style, accent color, offline data and favourites backup.
 *
 * Extracted from HomeScreen so the settings UI (and the accent drag inside it)
 * cannot re-render the saved-stop list behind it.
 *
 * Presented as the shared `BottomSheet` rather than the centred card it used to
 * be: every transient surface in the app is now the same object, dragged and
 * dismissed the same way, instead of each screen inventing its own.
 *
 * The RN `Modal` survives, but only as a portal. It is what puts the sheet over
 * the status bar and above whatever HomeScreen is rendering, and its
 * `onRequestClose` is the Android back button. On Android a Modal is a separate
 * native view hierarchy, which the app-root `GestureHandlerRootView` does not
 * reach into — hence the second root below. Without it the sheet would draw a
 * drag handle it could not honour.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  Modal,
  Share,
  ScrollView,
  TextInput,
  Pressable as RNPressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  StyleSheet,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font, onAccent, withAlpha } from '../theme';
import BottomSheet, { type BottomSheetHandle } from '../ui/BottomSheet';
import Pressable from '../ui/Pressable';
import { exportUserData, importUserData } from '../services/storage';
import {
  checkForUpdate,
  cancelUpdateDownload,
  getCurrentVersion,
  type UpdateProgress,
  type UpdateCheckResult,
} from '../services/updater';
import { hapticSuccess, hapticError } from '../services/haptics';
import { USER_MARKER_BASE64 } from '../data/userMarker';
import AccentPicker from './AccentPicker';
import type { OfflineProgress } from '../services/offlineData';

/** Resting height, and the height the restore form needs above a keyboard. */
const SNAP_POINTS = [0.62, 0.94];

/**
 * What the update row says while `checkForUpdate` is still running.
 *
 * `idle` is not the absence of work: the updater reports it just before it
 * raises its own "Update Available" dialog and again before each early exit,
 * so a check that is still in flight legitimately sits at `idle`. The row is
 * driven by whether the promise has settled, not by this phase — which is why
 * `idle` and `checking` share a label.
 */
function updateBusyLabel(p: UpdateProgress | null): string {
  if (!p) return 'Checking…';
  const pct = Math.round(p.progress * 100);
  switch (p.phase) {
    case 'downloading': return `Downloading ${pct}%`;
    case 'verifying': return `Verifying ${pct}%`;
    case 'installing': return 'Opening installer…';
    default: return 'Checking…';
  }
}

/**
 * What the update row says once the check has settled.
 *
 * Every outcome gets a sentence, including the boring one — a button that
 * leaves the screen exactly as it found it reads as broken, and "no update"
 * is the outcome it will produce almost every time.
 *
 * `update-available` says nothing about the version: the updater has just
 * shown its own dialog naming it, and repeating that here would be the second
 * time in two seconds. The line exists to explain why the dialog is gone.
 */
function updateNoticeFor(result: UpdateCheckResult): { text: string; tone: 'muted' | 'accent' | 'error' } {
  switch (result) {
    case 'up-to-date':
      return { text: "You're on the latest version.", tone: 'muted' };
    case 'update-available':
      return { text: 'An update is available — check again to install it.', tone: 'accent' };
    case 'unsupported':
      return { text: 'Self-update is not available on this build.', tone: 'error' };
    // `throttled` cannot land here: the check below always forces.
    default:
      return { text: "Couldn't reach GitHub. Check your connection and try again.", tone: 'error' };
  }
}

interface Props {
  visible: boolean;
  onClose: () => void;
  primaryColor: string;
  setPrimaryColor: (hex: string) => void;
  iconStyle: string;
  setIconStyle: (style: string) => void;
  offlineAvailable: boolean;
  offlineTs: number | null;
  downloading: boolean;
  progress: OfflineProgress | null;
  onDownload: () => void;
  onClear: () => void;
  /** Favourites were replaced by an import — the caller must reload them. */
  onDataRestored: () => void;
}

export default function SettingsModal({
  visible,
  onClose,
  primaryColor,
  setPrimaryColor,
  iconStyle,
  setIconStyle,
  offlineAvailable,
  offlineTs,
  downloading,
  progress,
  onDownload,
  onClear,
  onDataRestored,
}: Props) {
  const [importing, setImporting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  /* Update-check state is local, and has to be: the shared `UpdateOverlay`
     lives in the root layout and is fed by a `setUpdateProgress` this
     component has no access to. See the comment on `handleCheckUpdate`. */
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const sheetRef = useRef<BottomSheetHandle>(null);
  const insets = useSafeAreaInsets();

  /* Read once: it is a native constant, and re-reading it on every keystroke
     in the restore field would log a warning per render on builds that have
     no version. */
  const appVersion = useMemo(() => getCurrentVersion(), []);

  const errorMessage = !downloading && progress?.phase === 'error' ? progress.message : null;

  /* Filled buttons take the accent as a background, so their label cannot be a
     hardcoded white — see `onAccent`. */
  const accentInk = onAccent(primaryColor);

  const handleExport = useCallback(async () => {
    try {
      const json = await exportUserData();
      await Share.share({ message: json, title: 'F*ck OASA — favourites backup' });
      hapticSuccess();
    } catch {
      hapticError();
      Alert.alert('Export failed', 'Could not produce a backup file.');
    }
  }, []);

  /* The restore form is a tall text field that has to clear a keyboard, so it
     takes the sheet to its upper snap and hands it back on the way out. */
  const openImport = useCallback(() => {
    setImporting(true);
    sheetRef.current?.snapTo(SNAP_POINTS.length - 1);
  }, []);

  const closeImport = useCallback(() => {
    setImporting(false);
    sheetRef.current?.snapTo(0);
  }, []);

  const handleImport = useCallback(async () => {
    const text = pasted.trim();
    if (!text) return;
    setBusy(true);
    // `importUserData` never throws — it reports refusals so they can be shown.
    const result = await importUserData(text);
    setBusy(false);
    if (!result.ok) {
      hapticError();
      Alert.alert('Restore failed', result.error ?? "That doesn't look like a backup.");
      return;
    }
    setPasted('');
    closeImport();
    hapticSuccess();
    onDataRestored();
    const { favorites, stops, stamps } = result.imported;
    Alert.alert(
      'Restored',
      favorites + stops + stamps === 0
        ? 'Everything in that backup was already saved here.'
        : `Added ${stops} stop${stops === 1 ? '' : 's'}, ${favorites} line${favorites === 1 ? '' : 's'} and ${stamps} stamp${stamps === 1 ? '' : 's'}.`,
    );
  }, [pasted, onDataRestored, closeImport]);

  /**
   * Ask GitHub Releases for a newer build, right now.
   *
   * `force` lifts two separate silences, and both are the point of the button.
   * The six-hour throttle means a release that shipped five minutes ago is
   * invisible until this evening; and the skip list means a version the user
   * once dismissed stays unmentioned forever. Someone tapping "check for
   * updates" is asking about exactly that version, so `checkForUpdate` reads
   * past `SKIPPED_KEY` rather than this component clearing it — the stored
   * skip still governs the automatic checks, which is what the user asked for
   * when they set it. Choosing "Later" here leaves it in place; installing
   * makes it irrelevant.
   *
   * `checkForUpdate` owns the whole conversation from here — the prompt, the
   * download, the digest check, the installer. All this does is drive the row
   * and report the outcome, which cannot be inferred from the progress it
   * emits (every path ends on `idle`).
   */
  const handleCheckUpdate = useCallback(async () => {
    if (updateBusy) return;
    setUpdateResult(null);
    setUpdateProgress(null);
    setUpdateBusy(true);
    // Documented never to reject, but this is the one control whose entire job
    // is to answer — a rejection must still produce a sentence, not a dead row.
    const result = await checkForUpdate(setUpdateProgress, { force: true })
      .catch((): UpdateCheckResult => 'failed');
    setUpdateBusy(false);
    setUpdateProgress(null);
    setUpdateResult(result);
    if (result === 'up-to-date' || result === 'update-available') hapticSuccess();
    else hapticError();
  }, [updateBusy]);

  const close = useCallback(() => {
    setImporting(false);
    // A verdict is about the moment it was asked for. Leaving "You're on the
    // latest version" on screen for the next time settings opens would make it
    // a claim about then, which nothing has checked.
    setUpdateResult(null);
    onClose();
  }, [onClose]);

  /* Only the byte-counting phases have a denominator to draw a bar from;
     `checking` and the installer hand-off get the spinner instead — the same
     split the offline-download row above makes. */
  const updateDeterminate =
    updateProgress?.phase === 'downloading' || updateProgress?.phase === 'verifying';
  const updatePct = Math.max(0, Math.min(100, Math.round((updateProgress?.progress ?? 0) * 100)));
  const updateNotice = !updateBusy && updateResult ? updateNoticeFor(updateResult) : null;
  const updateNoticeColor =
    updateNotice?.tone === 'accent' ? primaryColor
      : updateNotice?.tone === 'error' ? colors.danger
        : colors.textMuted;

  const pad = { paddingBottom: insets.bottom + spacing.lg };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={close}
    >
      <GestureHandlerRootView style={s.root}>
        <KeyboardAvoidingView style={s.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {/* Tap-outside-to-close. Bare RN Pressable on purpose: the shared one
              adds a press-scale and a haptic, neither of which belongs on a
              full-screen dismiss target. */}
          <RNPressable
            style={StyleSheet.absoluteFill}
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Close settings"
          />
          <BottomSheet
            ref={sheetRef}
            snapPoints={SNAP_POINTS}
            initialSnap={0}
            onDismiss={close}
            backdrop
          >
            {/* No `accessibilityViewIsModal` here any more. The RN Modal above
                is a real modal window, so VoiceOver is already scoped to it;
                repeating the flag on this subtree only hid its own siblings —
                the sheet's "Resize panel" handle and the backdrop's "Close
                settings" target. */}
            <View style={s.sheetBody}>
              {importing ? (
                <ScrollView
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={pad}
                >
                  <Text style={s.title} accessibilityRole="header">Restore favourites</Text>
                  <Text style={s.hint}>
                    Paste the backup you exported earlier. It is merged with what you already have —
                    nothing currently saved is removed.
                  </Text>
                  <TextInput
                    style={s.pasteInput}
                    value={pasted}
                    onChangeText={setPasted}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder='{"favorites":[…],"stops":[…]}'
                    placeholderTextColor={colors.textMuted}
                    accessibilityLabel="Backup contents"
                  />
                  <View style={s.rowBtns}>
                    <Pressable
                      style={s.secondaryBtn}
                      onPress={closeImport}
                      accessibilityRole="button"
                      accessibilityLabel="Cancel restore"
                    >
                      <Text style={s.secondaryText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      style={[s.primaryBtn, { backgroundColor: primaryColor }]}
                      disabled={!pasted.trim() || busy}
                      onPress={handleImport}
                      accessibilityRole="button"
                      accessibilityLabel="Restore from backup"
                    >
                      {busy
                        ? <ActivityIndicator size="small" color={accentInk} />
                        : <Text style={[s.primaryText, { color: accentInk }]}>Restore</Text>}
                    </Pressable>
                  </View>
                </ScrollView>
              ) : (
                <ScrollView
                  showsVerticalScrollIndicator={false}
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={pad}
                >
                  <Text style={s.title} accessibilityRole="header">Settings</Text>

                  {/* Icon style */}
                  <Text style={s.label}>Location Icon</Text>
                  <View style={s.iconRow}>
                    <Pressable
                      style={[s.iconOption, iconStyle === 'cat' && { borderColor: primaryColor }]}
                      onPress={() => setIconStyle('cat')}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: iconStyle === 'cat' }}
                      accessibilityLabel="Cat location icon"
                    >
                      <Image source={{ uri: USER_MARKER_BASE64 }} style={{ width: 28, height: 28 }} />
                      <Text style={s.iconOptionText}>Cat</Text>
                    </Pressable>
                    <Pressable
                      style={[s.iconOption, iconStyle === 'pin' && { borderColor: primaryColor }]}
                      onPress={() => setIconStyle('pin')}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: iconStyle === 'pin' }}
                      accessibilityLabel="Dot location icon"
                    >
                      <View style={s.dotIcon} />
                      <Text style={s.iconOptionText}>Dot</Text>
                    </Pressable>
                  </View>

                  {/* Accent color */}
                  <Text style={[s.label, { marginTop: spacing.md }]}>Accent Color</Text>
                  <AccentPicker value={primaryColor} onCommit={setPrimaryColor} />

                  {/* Offline data */}
                  <Text style={[s.label, { marginTop: spacing.md }]}>Offline Data</Text>
                  {/* A failed re-download is an extra line, never a replacement for
                      the "Downloaded … / Clear" row — that swap left users with a
                      bare Retry button and no way to clear what they already had. */}
                  {errorMessage && (
                    <Text style={[s.status, { color: colors.danger, marginBottom: spacing.xs }]}>
                      {errorMessage}
                    </Text>
                  )}
                  {downloading ? (
                    <View style={s.offlineRow}>
                      {/* Tabular figures: `Routes 9/226` → `Routes 10/226` must not
                          shove the progress bar sideways once a digit is added. */}
                      <Text style={[s.status, s.num]}>
                        {!progress && 'Starting…'}
                        {progress?.phase === 'lines' && 'Fetching lines…'}
                        {progress?.phase === 'stops' && 'Fetching all stops…'}
                        {progress?.phase === 'routes' && `Routes ${progress.current}/${progress.total}`}
                        {progress?.phase === 'schedules' && `Schedules ${progress.current}/${progress.total}`}
                        {progress?.phase === 'done' && 'Saving…'}
                      </Text>
                      {progress && progress.total > 0 ? (
                        <View style={s.progressBg}>
                          <View
                            style={[
                              s.progressFill,
                              {
                                width: `${Math.round((progress.current / progress.total) * 100)}%`,
                                backgroundColor: primaryColor,
                              },
                            ]}
                          />
                        </View>
                      ) : (
                        <ActivityIndicator size="small" color={primaryColor} />
                      )}
                    </View>
                  ) : offlineAvailable ? (
                    <View style={s.offlineRow}>
                      <Text style={s.status}>
                        Downloaded {offlineTs ? new Date(offlineTs).toLocaleDateString() : ''}
                      </Text>
                      <Pressable
                        style={s.inlineBtn}
                        onPress={onDownload}
                        accessibilityRole="button"
                        accessibilityLabel="Update offline data"
                      >
                        <Ionicons name="refresh" size={16} color={primaryColor} />
                        <Text style={[s.inlineBtnText, { color: primaryColor }]}>Update</Text>
                      </Pressable>
                      <Pressable
                        style={s.inlineBtn}
                        onPress={onClear}
                        accessibilityRole="button"
                        accessibilityLabel="Clear offline data"
                      >
                        <Ionicons name="trash-outline" size={16} color={colors.danger} />
                        <Text style={[s.inlineBtnText, { color: colors.danger }]}>Clear</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <Pressable
                      style={[s.outlineBtn, { borderColor: primaryColor }]}
                      onPress={onDownload}
                      accessibilityRole="button"
                      accessibilityLabel={errorMessage ? 'Retry offline download' : 'Download data for offline use'}
                    >
                      <Ionicons name={errorMessage ? 'refresh' : 'cloud-download-outline'} size={18} color={primaryColor} />
                      <Text style={[s.outlineBtnText, { color: primaryColor }]}>
                        {errorMessage ? 'Retry download' : 'Download for offline use'}
                      </Text>
                    </Pressable>
                  )}

                  {/* Backup — must exist before the signing key changes, because a
                      reinstall wipes AsyncStorage and takes every saved stop with it. */}
                  <Text style={[s.label, { marginTop: spacing.md }]}>Favourites Backup</Text>
                  <Text style={s.hint}>
                    Reinstalling the app erases your saved stops and lines. Export a copy first.
                  </Text>
                  <View style={s.rowBtns}>
                    <Pressable
                      style={[s.outlineBtn, { flex: 1, borderColor: primaryColor }]}
                      onPress={handleExport}
                      accessibilityRole="button"
                      accessibilityLabel="Export favourites"
                    >
                      <Ionicons name="share-outline" size={18} color={primaryColor} />
                      <Text style={[s.outlineBtnText, { color: primaryColor }]}>Export</Text>
                    </Pressable>
                    <Pressable
                      style={[s.outlineBtn, { flex: 1, borderColor: colors.border }]}
                      onPress={openImport}
                      accessibilityRole="button"
                      accessibilityLabel="Restore favourites from a backup"
                    >
                      <Ionicons name="download-outline" size={18} color={colors.text} />
                      <Text style={[s.outlineBtnText, { color: colors.text }]}>Restore</Text>
                    </Pressable>
                  </View>

                  {/* App version + an explicit update check.
                      Android-only, because that is the only platform the
                      updater can act on — the app ships as an APK from GitHub
                      Releases and `checkForUpdate` returns immediately
                      anywhere else. A row that could never do anything is
                      worse than no row, so iOS does not get one. */}
                  {Platform.OS === 'android' && (
                    <>
                      <Text style={[s.label, { marginTop: spacing.md }]}>App Version</Text>
                      {updateBusy ? (
                        <View style={s.offlineRow}>
                          <Text style={[s.status, s.num]}>{updateBusyLabel(updateProgress)}</Text>
                          {updateDeterminate ? (
                            <View style={s.progressBg}>
                              <View
                                style={[
                                  s.progressFill,
                                  { width: `${updatePct}%`, backgroundColor: primaryColor },
                                ]}
                              />
                            </View>
                          ) : (
                            <ActivityIndicator size="small" color={primaryColor} />
                          )}
                          {/* The root layout's overlay — the one that normally
                              carries this cancel — is a sibling of the app's
                              screens, and this sheet lives in its own native
                              Modal window on top of them. It cannot reach the
                              user while settings is open, so the escape hatch
                              from a ~40MB transfer on mobile data has to exist
                              here too. */}
                          {updateProgress?.phase === 'downloading' && (
                            <Pressable
                              style={s.inlineBtn}
                              onPress={() => { cancelUpdateDownload().catch(() => {}); }}
                              accessibilityRole="button"
                              accessibilityLabel="Cancel this update download"
                            >
                              <Text style={[s.inlineBtnText, { color: colors.danger }]}>Cancel</Text>
                            </Pressable>
                          )}
                        </View>
                      ) : (
                        <View style={s.offlineRow}>
                          <Text style={[s.status, s.num]}>
                            {appVersion ? `Version ${appVersion}` : 'Version unknown'}
                          </Text>
                          <Pressable
                            style={s.inlineBtn}
                            onPress={handleCheckUpdate}
                            accessibilityRole="button"
                            accessibilityLabel="Check for updates"
                          >
                            <Ionicons name="refresh" size={16} color={primaryColor} />
                            <Text style={[s.inlineBtnText, { color: primaryColor }]}>
                              Check for updates
                            </Text>
                          </Pressable>
                        </View>
                      )}
                      {updateNotice && (
                        <Text
                          style={[s.status, { color: updateNoticeColor, marginTop: spacing.xs }]}
                          accessibilityLiveRegion="polite"
                        >
                          {updateNotice.text}
                        </Text>
                      )}
                    </>
                  )}

                  <Pressable
                    style={[s.primaryBtn, { backgroundColor: primaryColor, marginTop: spacing.lg }]}
                    onPress={close}
                    accessibilityRole="button"
                    accessibilityLabel="Close settings"
                  >
                    <Text style={[s.primaryText, { color: accentInk }]}>Done</Text>
                  </Pressable>
                </ScrollView>
              )}
            </View>
          </BottomSheet>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const s = StyleSheet.create({
  /* `font.num` is declared `as const` in the theme, which RN's `TextStyle`
     rejects — it wants a mutable `FontVariant[]`. Copying the value keeps the
     theme as its single source without arguing with the type. */
  num: font.num,
  root: { flex: 1 },
  /* No dim of its own — the sheet's own backdrop fades in step with its
     height, so a dismissing drag darkens and lightens with the finger. */
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetBody: {
    flex: 1,
    paddingHorizontal: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: font.size.title,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  label: {
    color: colors.textMuted,
    fontSize: font.size.label,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  hint: {
    color: colors.textMuted,
    fontSize: font.size.micro,
    marginBottom: spacing.sm,
    opacity: 0.8,
  },
  iconRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  iconOption: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.border,
    gap: 4,
    minWidth: 72,
    minHeight: 64,
  },
  iconOptionText: {
    color: colors.textMuted,
    fontSize: font.size.micro,
    fontWeight: '600',
  },
  dotIcon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#4285F4',
    borderWidth: 2,
    borderColor: '#FFF',
  },
  offlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  status: {
    color: colors.textMuted,
    fontSize: font.size.micro,
    flex: 1,
  },
  inlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 40,
    paddingHorizontal: spacing.xs,
  },
  inlineBtnText: {
    fontSize: font.size.micro,
    fontWeight: '700',
  },
  outlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  outlineBtnText: {
    fontSize: font.size.label,
    fontWeight: '600',
  },
  progressBg: {
    flex: 1,
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  rowBtns: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  pasteInput: {
    backgroundColor: colors.card,
    color: colors.text,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    fontSize: font.size.micro,
    minHeight: 120,
    maxHeight: 200,
    textAlignVertical: 'top',
    marginBottom: spacing.md,
  },
  primaryBtn: {
    flex: 1,
    borderRadius: radius.md,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /* Colour is `onAccent(primaryColor)` at render time: this label sits on the
     user's accent, and white is only right for about half the hue wheel. */
  primaryText: {
    fontSize: font.size.body,
    fontWeight: '700',
  },
  secondaryBtn: {
    flex: 1,
    borderRadius: radius.md,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: withAlpha('#FFFFFF', 0.04),
  },
  secondaryText: {
    color: colors.textMuted,
    fontSize: font.size.body,
    fontWeight: '600',
  },
});
