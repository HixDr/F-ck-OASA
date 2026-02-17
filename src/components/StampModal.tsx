/**
 * Reusable stamp creation modal — used on all map screens.
 * Long-press a location → this modal lets the user name it and pick an emoji.
 */

import React from 'react';
import { View, Text, Modal, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, spacing, radius, font } from '../theme';
import { STAMP_EMOJIS } from '../stamps';

interface StampModalProps {
  visible: boolean;
  name: string;
  emoji: string;
  onChangeName: (name: string) => void;
  onChangeEmoji: (emoji: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export default function StampModal({
  visible,
  name,
  emoji,
  onChangeName,
  onChangeEmoji,
  onSave,
  onCancel,
}: StampModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={ms.bg}>
        <View style={ms.card}>
          <Text style={ms.title}>Add Stamp</Text>
          <TextInput
            style={ms.input}
            placeholder="Name (e.g. Home)"
            placeholderTextColor={colors.textMuted}
            value={name}
            onChangeText={onChangeName}
            autoFocus
            maxLength={20}
          />
          <View style={ms.emojiRow}>
            {STAMP_EMOJIS.map((e) => (
              <TouchableOpacity
                key={e}
                style={[ms.emojiBtn, emoji === e && ms.emojiBtnActive]}
                onPress={() => onChangeEmoji(e)}
              >
                <Text style={ms.emojiText}>{e}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={ms.btns}>
            <TouchableOpacity style={ms.cancelBtn} onPress={onCancel}>
              <Text style={ms.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[ms.saveBtn, !name.trim() && { opacity: 0.4 }]}
              disabled={!name.trim()}
              onPress={onSave}
            >
              <Text style={ms.saveText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const ms = StyleSheet.create({
  bg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    width: 280,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: {
    color: colors.text,
    fontSize: font.size.lg,
    fontWeight: '700',
    marginBottom: spacing.md,
    textAlign: 'center',
  },
  input: {
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: font.size.sm,
    marginBottom: spacing.md,
  },
  emojiRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  emojiBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emojiBtnActive: {
    borderColor: colors.primary,
    backgroundColor: 'rgba(123,44,191,0.2)',
  },
  emojiText: {
    fontSize: 20,
  },
  btns: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  cancelText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontWeight: '600',
  },
  saveBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  saveText: {
    color: '#FFF',
    fontSize: font.size.sm,
    fontWeight: '700',
  },
});
