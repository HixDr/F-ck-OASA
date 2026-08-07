/**
 * UndoBar — act-then-undo, replacing confirmation dialogs.
 *
 * Removing a saved stop used to raise a modal `Alert.alert` and block until the
 * user answered. That is the wrong trade for a reversible, low-stakes action
 * performed while walking: it costs everyone a decision to protect against a
 * mistake that takes one tap to reverse.
 *
 * The action is applied immediately. This bar offers a window to take it back.
 *
 * Deliberately imperative (`showUndo(...)` from anywhere) rather than a hook:
 * callers are event handlers deep inside memoized list rows, and threading a
 * context callback through every one of them would be noise.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, font, radius, spacing, HIT_SIZE } from '../theme';
import Pressable from './Pressable';

/** How long the user has to take it back. */
const UNDO_MS = 5000;

export interface UndoRequest {
  /** e.g. `Removed "Syntagma"`. Kept short — this is a glance, not a paragraph. */
  message: string;
  /** Put the world back. Must be safe to call exactly once. */
  onUndo: () => void;
  /**
   * Called when the window closes without an undo. Optional: most callers have
   * already written the change and need no commit step.
   */
  onCommit?: () => void;
}

type Listener = (req: UndoRequest | null) => void;
let listener: Listener | null = null;
let queued: UndoRequest | null = null;

/**
 * Show an undo bar. Safe to call before `UndoHost` mounts — the request is
 * held and delivered when it does.
 */
export function showUndo(req: UndoRequest): void {
  if (listener) listener(req);
  else queued = req;
}

/** Dismiss any visible bar, committing it. */
export function hideUndo(): void {
  listener?.(null);
}

/**
 * Renders the bar. Mounted once, as an overlay, in the root layout.
 */
export function UndoHost() {
  const insets = useSafeAreaInsets();
  const [req, setReq] = useState<UndoRequest | null>(queued);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* The pending request is mirrored so the timeout can commit the right one
     without capturing a stale `req` from the render it was scheduled in. */
  const pending = useRef<UndoRequest | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  /** Close without undoing — the action stands. */
  const commit = useCallback(() => {
    clearTimer();
    const r = pending.current;
    pending.current = null;
    setReq(null);
    r?.onCommit?.();
  }, [clearTimer]);

  useEffect(() => {
    listener = (next) => {
      clearTimer();
      /* A second removal while a bar is up commits the first rather than
         dropping it: its onCommit must still run, and silently discarding an
         undo the user could still see would be worse than replacing it. */
      const prev = pending.current;
      if (prev && next) prev.onCommit?.();
      pending.current = next;
      setReq(next);
    };
    queued = null;
    return () => { listener = null; };
  }, [clearTimer]);

  useEffect(() => {
    if (!req) return;
    timer.current = setTimeout(commit, UNDO_MS);
    return clearTimer;
  }, [req, commit, clearTimer]);

  const undo = useCallback(() => {
    clearTimer();
    const r = pending.current;
    pending.current = null;
    setReq(null);
    r?.onUndo();
  }, [clearTimer]);

  if (!req) return null;

  return (
    <Animated.View
      entering={SlideInDown.duration(220)}
      exiting={SlideOutDown.duration(160)}
      style={[s.wrap, { bottom: insets.bottom + spacing.md }]}
      pointerEvents="box-none"
      accessibilityLiveRegion="polite"
    >
      <View style={s.bar}>
        <Text style={s.text} numberOfLines={2}>{req.message}</Text>
        <Pressable
          style={s.btn}
          onPress={undo}
          accessibilityRole="button"
          accessibilityLabel={`Undo: ${req.message}`}
        >
          <Ionicons name="arrow-undo" size={14} color={colors.text} />
          <Text style={s.btnText}>Undo</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    /* Wide screens: a toast spanning a tablet is a banner, not a toast. */
    maxWidth: 480,
    alignSelf: 'center',
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderTopColor: colors.edge,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    minHeight: HIT_SIZE + 4,
    /* Sits above every other overlay, so it needs its own separation. */
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  text: { flex: 1, color: colors.text, fontSize: font.size.body },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    minHeight: HIT_SIZE,
  },
  btnText: { color: colors.text, fontSize: font.size.label, fontWeight: '700' },
});
