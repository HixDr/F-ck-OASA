/**
 * AlertPickerModal — modal for setting an arrival alert threshold.
 * Shared by LiveMapScreen and FavoriteStopCard.
 */

import React from 'react';
import {
  View,
  Text,
  Modal,
  Pressable as RNPressable,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font, onAccent, withAlpha } from '../theme';
import Pressable from '../ui/Pressable';

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
  /* The confirm button is filled with the user's accent, and the accent picker
     spans every hue at a fixed lightness — a hardcoded white label sits at
     ~2:1 on the yellows and greens it offers. */
  const confirmInk = onAccent(accentColor);

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
        {/* Bare RN Pressable: the shared one's press-scale and haptic are wrong
            on a full-screen dismiss target. */}
        <RNPressable
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
                <Pressable
                  key={min}
                  style={[
                    s.chip,
                    active && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.18) },
                  ]}
                  onPress={() => onChangeThreshold(String(min))}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`${min} minutes away`}
                >
                  <Text style={[s.chipNum, active && { color: colors.text }]}>{min}</Text>
                  <Text style={[s.chipUnit, active && { color: colors.text }]}>min away</Text>
                </Pressable>
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
            <Pressable
              style={s.cancelBtn}
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={s.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[s.confirmBtn, { backgroundColor: accentColor }, (!isValid || busy) && s.disabled]}
              disabled={!isValid || busy}
              onPress={onConfirm}
              accessibilityRole="button"
              accessibilityState={{ disabled: !isValid || busy, busy }}
              accessibilityLabel={`${confirmLabel} alert`}
            >
              {busy ? (
                <ActivityIndicator size="small" color={confirmInk} />
              ) : (
                <>
                  <Ionicons name="notifications" size={16} color={confirmInk} />
                  <Text style={[s.confirmText, { color: confirmInk }]}>
                    {errorMessage ? 'Try again' : confirmLabel}
                  </Text>
                </>
              )}
            </Pressable>
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
  /* Color comes from `onAccent(accentColor)` inline. */
  confirmText: {
    fontSize: font.size.sm,
    fontWeight: '700',
  },
});
