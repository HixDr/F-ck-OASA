/**
 * AlertPickerModal — modal for setting an arrival alert threshold.
 * Shared by LiveMapScreen and FavoriteStopCard.
 */

import React from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font, withAlpha } from '../theme';

/** Offered thresholds, in minutes. These replaced a free-text number pad:
 *  it accepted "" (→ NaN → the Start button silently did nothing while the
 *  dialog stayed open) and it put a keyboard over the buttons. */
export const THRESHOLD_OPTIONS = [2, 5, 10, 15] as const;

interface Props {
  visible: boolean;
  title?: string;
  subtitle: string;
  threshold: string;
  onChangeThreshold: (value: string) => void;
  accentColor: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** Label for the confirm button — "Switch" when replacing an active alert. */
  confirmLabel?: string;
  /** Why the last attempt to arm the alert failed. Shown inline and keeps the
   *  dialog open, so a control that cannot work never looks like it worked. */
  errorMessage?: string | null;
  /** Arming is in flight. */
  busy?: boolean;
}

export default function AlertPickerModal({
  visible,
  title = 'Set Arrival Alert',
  subtitle,
  threshold,
  onChangeThreshold,
  accentColor,
  onCancel,
  onConfirm,
  confirmLabel = 'Start',
  errorMessage = null,
  busy = false,
}: Props) {
  const selected = Number.parseInt(threshold, 10);
  const isValid = Number.isFinite(selected) && selected > 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <View style={s.overlay}>
        {/* Backdrop is a sibling, not a wrapper: wrapping the dialog in a
            touchable made a stray tap inside it dismiss, and made a screen
            reader announce the whole dialog as a button. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={s.modal} accessibilityViewIsModal accessibilityLiveRegion="polite">
          <Text style={s.title} accessibilityRole="header">{title}</Text>
          <Text style={s.subtitle}>{subtitle}</Text>

          <Text style={s.pickerLabel}>Alert me when the bus is</Text>
          <View style={s.chipRow}>
            {THRESHOLD_OPTIONS.map((min) => {
              const active = selected === min;
              return (
                <TouchableOpacity
                  key={min}
                  style={[
                    s.chip,
                    active && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.18) },
                  ]}
                  activeOpacity={0.7}
                  onPress={() => onChangeThreshold(String(min))}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`${min} minutes away`}
                >
                  <Text style={[s.chipNum, active && { color: colors.text }]}>{min}</Text>
                  <Text style={[s.chipUnit, active && { color: colors.text }]}>min away</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {errorMessage && (
            <View style={s.errorRow} accessibilityLiveRegion="assertive">
              <Ionicons name="alert-circle" size={16} color={colors.danger} />
              <Text style={s.errorText}>{errorMessage}</Text>
            </View>
          )}

          <View style={s.btns}>
            <TouchableOpacity
              style={s.cancelBtn}
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={s.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.confirmBtn, { backgroundColor: accentColor }, (!isValid || busy) && s.disabled]}
              disabled={!isValid || busy}
              onPress={onConfirm}
              accessibilityRole="button"
              accessibilityState={{ disabled: !isValid || busy, busy }}
              accessibilityLabel={`${confirmLabel} alert`}
            >
              {busy ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <>
                  <Ionicons name="notifications" size={16} color="#FFF" />
                  <Text style={s.confirmText}>{errorMessage ? 'Try again' : confirmLabel}</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modal: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minWidth: 300,
    maxWidth: 360,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: {
    color: colors.text,
    fontSize: font.size.lg,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    marginBottom: spacing.md,
  },
  pickerLabel: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  chip: {
    flex: 1,
    minHeight: 56,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipNum: {
    color: colors.textMuted,
    fontSize: font.size.lg,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  chipUnit: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '600',
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.md,
    marginTop: -spacing.sm,
  },
  errorText: {
    flex: 1,
    color: colors.danger,
    fontSize: font.size.xs,
    fontWeight: '600',
  },
  btns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  cancelBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  cancelText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontWeight: '600',
  },
  confirmBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
  },
  disabled: { opacity: 0.4 },
  confirmText: {
    color: '#FFF',
    fontSize: font.size.sm,
    fontWeight: '700',
  },
});
