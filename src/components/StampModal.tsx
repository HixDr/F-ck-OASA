/**
 * Reusable stamp creation modal — used on all map screens.
 * Long-press a location → this modal lets the user name it and pick an emoji.
 */

import React from 'react';
import {
  View,
  Text,
  Modal,
  TextInput,
  TouchableOpacity,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { colors, spacing, radius, font, onAccent, withAlpha } from '../theme';
import { STAMP_EMOJIS } from '../data/stamps';

interface StampModalProps {
  visible: boolean;
  name: string;
  emoji: string;
  onChangeName: (name: string) => void;
  onChangeEmoji: (emoji: string) => void;
  onSave: () => void;
  onCancel: () => void;
  /** User's accent color. Defaults to the palette purple for callers that
   *  have not been wired to SettingsProvider yet. */
  accentColor?: string;
}

export default function StampModal({
  visible,
  name,
  emoji,
  onChangeName,
  onChangeEmoji,
  onSave,
  onCancel,
  accentColor = colors.primary,
}: StampModalProps) {
  const canSave = !!name.trim();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      {/* The name field autofocuses and the buttons sit below it, so on a
          short screen the keyboard used to cover Save entirely. */}
      <KeyboardAvoidingView
        style={ms.bg}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Backdrop as a sibling so a tap inside the card never dismisses and
            discards what the user typed. Matches AlertPickerModal — the two
            dialogs used to follow opposite rules. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onCancel}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View style={ms.card} accessibilityViewIsModal>
          <Text style={ms.title} accessibilityRole="header">Add Stamp</Text>
          <TextInput
            style={ms.input}
            placeholder="Name (e.g. Home)"
            placeholderTextColor={colors.textMuted}
            value={name}
            onChangeText={onChangeName}
            autoFocus
            maxLength={20}
            returnKeyType="done"
            onSubmitEditing={() => { if (canSave) onSave(); }}
            accessibilityLabel="Stamp name"
          />
          <View style={ms.emojiRow}>
            {STAMP_EMOJIS.map((e) => {
              const active = emoji === e;
              return (
                <TouchableOpacity
                  key={e}
                  style={[
                    ms.emojiBtn,
                    active && { borderColor: accentColor, backgroundColor: withAlpha(accentColor, 0.2) },
                  ]}
                  onPress={() => onChangeEmoji(e)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`Icon ${e}`}
                >
                  <Text style={ms.emojiText}>{e}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <View style={ms.btns}>
            <TouchableOpacity
              style={ms.cancelBtn}
              onPress={onCancel}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={ms.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[ms.saveBtn, { backgroundColor: accentColor }, !canSave && { opacity: 0.4 }]}
              disabled={!canSave}
              onPress={onSave}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
              accessibilityLabel="Save stamp"
            >
              <Text style={[ms.saveText, { color: onAccent(accentColor) }]}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
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
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: 'center',
    alignItems: 'center',
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
    minHeight: 44,
    justifyContent: 'center',
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
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  /** Color comes from `onAccent(accentColor)` inline. */
  saveText: {
    fontSize: font.size.sm,
    fontWeight: '700',
  },
});
