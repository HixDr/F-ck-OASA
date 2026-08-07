/**
 * SettingsModal — icon style, accent color, offline data and favourites backup.
 *
 * Extracted from HomeScreen so the settings UI (and the accent drag inside it)
 * cannot re-render the saved-stop list behind it.
 */

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Image,
  Modal,
  Share,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font, withAlpha } from '../theme';
import { exportUserData, importUserData } from '../services/storage';
import { hapticSuccess, hapticError } from '../services/haptics';
import { USER_MARKER_BASE64 } from '../data/userMarker';
import AccentPicker from './AccentPicker';
import type { OfflineProgress } from '../services/offlineData';

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

  const errorMessage = !downloading && progress?.phase === 'error' ? progress.message : null;

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
    setImporting(false);
    hapticSuccess();
    onDataRestored();
    const { favorites, stops, stamps } = result.imported;
    Alert.alert(
      'Restored',
      favorites + stops + stamps === 0
        ? 'Everything in that backup was already saved here.'
        : `Added ${stops} stop${stops === 1 ? '' : 's'}, ${favorites} line${favorites === 1 ? '' : 's'} and ${stamps} stamp${stamps === 1 ? '' : 's'}.`,
    );
  }, [pasted, onDataRestored]);

  const close = useCallback(() => {
    setImporting(false);
    onClose();
  }, [onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={close}
    >
      <KeyboardAvoidingView style={s.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close settings"
        />
        <View style={s.card} accessibilityViewIsModal>
          {importing ? (
            <>
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
                <TouchableOpacity
                  style={s.secondaryBtn}
                  onPress={() => setImporting(false)}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel restore"
                >
                  <Text style={s.secondaryText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.primaryBtn, { backgroundColor: primaryColor }, (!pasted.trim() || busy) && s.disabled]}
                  disabled={!pasted.trim() || busy}
                  onPress={handleImport}
                  accessibilityRole="button"
                  accessibilityLabel="Restore from backup"
                >
                  {busy
                    ? <ActivityIndicator size="small" color="#FFF" />
                    : <Text style={s.primaryText}>Restore</Text>}
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={s.title} accessibilityRole="header">Settings</Text>

              {/* Icon style */}
              <Text style={s.label}>Location Icon</Text>
              <View style={s.iconRow}>
                <TouchableOpacity
                  style={[s.iconOption, iconStyle === 'cat' && { borderColor: primaryColor }]}
                  onPress={() => setIconStyle('cat')}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: iconStyle === 'cat' }}
                  accessibilityLabel="Cat location icon"
                >
                  <Image source={{ uri: USER_MARKER_BASE64 }} style={{ width: 28, height: 28 }} />
                  <Text style={s.iconOptionText}>Cat</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.iconOption, iconStyle === 'pin' && { borderColor: primaryColor }]}
                  onPress={() => setIconStyle('pin')}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: iconStyle === 'pin' }}
                  accessibilityLabel="Dot location icon"
                >
                  <View style={s.dotIcon} />
                  <Text style={s.iconOptionText}>Dot</Text>
                </TouchableOpacity>
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
                  <Text style={s.status}>
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
                  <TouchableOpacity
                    style={s.inlineBtn}
                    onPress={onDownload}
                    accessibilityRole="button"
                    accessibilityLabel="Update offline data"
                  >
                    <Ionicons name="refresh" size={16} color={primaryColor} />
                    <Text style={[s.inlineBtnText, { color: primaryColor }]}>Update</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.inlineBtn}
                    onPress={onClear}
                    accessibilityRole="button"
                    accessibilityLabel="Clear offline data"
                  >
                    <Ionicons name="trash-outline" size={16} color={colors.danger} />
                    <Text style={[s.inlineBtnText, { color: colors.danger }]}>Clear</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  style={[s.outlineBtn, { borderColor: primaryColor }]}
                  onPress={onDownload}
                  accessibilityRole="button"
                  accessibilityLabel={errorMessage ? 'Retry offline download' : 'Download data for offline use'}
                >
                  <Ionicons name={errorMessage ? 'refresh' : 'cloud-download-outline'} size={18} color={primaryColor} />
                  <Text style={[s.outlineBtnText, { color: primaryColor }]}>
                    {errorMessage ? 'Retry download' : 'Download for offline use'}
                  </Text>
                </TouchableOpacity>
              )}

              {/* Backup — must exist before the signing key changes, because a
                  reinstall wipes AsyncStorage and takes every saved stop with it. */}
              <Text style={[s.label, { marginTop: spacing.md }]}>Favourites Backup</Text>
              <Text style={s.hint}>
                Reinstalling the app erases your saved stops and lines. Export a copy first.
              </Text>
              <View style={s.rowBtns}>
                <TouchableOpacity
                  style={[s.outlineBtn, { flex: 1, borderColor: primaryColor }]}
                  onPress={handleExport}
                  accessibilityRole="button"
                  accessibilityLabel="Export favourites"
                >
                  <Ionicons name="share-outline" size={18} color={primaryColor} />
                  <Text style={[s.outlineBtnText, { color: primaryColor }]}>Export</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.outlineBtn, { flex: 1, borderColor: colors.border }]}
                  onPress={() => setImporting(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Restore favourites from a backup"
                >
                  <Ionicons name="download-outline" size={18} color={colors.text} />
                  <Text style={[s.outlineBtnText, { color: colors.text }]}>Restore</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[s.primaryBtn, { backgroundColor: primaryColor, marginTop: spacing.lg }]}
                onPress={close}
                accessibilityRole="button"
                accessibilityLabel="Close settings"
              >
                <Text style={s.primaryText}>Done</Text>
              </TouchableOpacity>
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.lg,
    width: '86%',
    maxHeight: '85%',
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: {
    color: colors.text,
    fontSize: font.size.lg,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  label: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  hint: {
    color: colors.textMuted,
    fontSize: font.size.xs,
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
    fontSize: font.size.xs,
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
    fontSize: font.size.xs,
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
    fontSize: font.size.xs,
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
    fontSize: font.size.sm,
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
    fontSize: font.size.xs,
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
  primaryText: {
    color: '#FFF',
    fontSize: font.size.md,
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
    fontSize: font.size.md,
    fontWeight: '600',
  },
  disabled: { opacity: 0.4 },
});
