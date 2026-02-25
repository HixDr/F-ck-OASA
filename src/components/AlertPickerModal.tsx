/**
 * AlertPickerModal — modal for setting an arrival alert threshold.
 * Shared by LiveMapScreen and FavoriteStopCard.
 */

import React from 'react';
import { View, Text, TextInput, Modal, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font } from '../theme';

interface Props {
  visible: boolean;
  title?: string;
  subtitle: string;
  threshold: string;
  onChangeThreshold: (value: string) => void;
  accentColor: string;
  onCancel: () => void;
  onConfirm: () => void;
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
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={onCancel}>
        <TouchableOpacity style={s.modal} activeOpacity={1} onPress={() => {}}>
          <Text style={s.title}>{title}</Text>
          <Text style={s.subtitle}>{subtitle}</Text>
          <View style={s.pickerRow}>
            <Text style={s.pickerLabel}>Alert when ≤</Text>
            <TextInput
              style={s.pickerInput}
              value={threshold}
              onChangeText={onChangeThreshold}
              keyboardType="number-pad"
              maxLength={2}
              placeholderTextColor={colors.textMuted}
              autoFocus
            />
            <Text style={s.pickerLabel}>min</Text>
          </View>
          <View style={s.btns}>
            <TouchableOpacity style={s.cancelBtn} onPress={onCancel}>
              <Text style={s.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.confirmBtn, { backgroundColor: accentColor }]}
              onPress={onConfirm}
            >
              <Ionicons name="notifications" size={16} color="#FFF" />
              <Text style={s.confirmText}>Start</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
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
    minWidth: 280,
    maxWidth: 340,
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
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: spacing.lg,
  },
  pickerLabel: {
    color: colors.textMuted,
    fontSize: font.size.md,
    fontWeight: '600',
  },
  pickerInput: {
    color: colors.text,
    fontSize: font.size.lg,
    fontWeight: '700',
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    minWidth: 52,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  btns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  cancelBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
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
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  confirmText: {
    color: '#FFF',
    fontSize: font.size.sm,
    fontWeight: '700',
  },
});
