/**
 * Haptic feedback.
 *
 * This app is used one-handed, at a bus stop, often while walking and looking
 * at traffic rather than the screen. Touch feedback is not decoration here —
 * it is the confirmation channel for actions the user cannot afford to
 * double-check visually, and the only affordance that makes a long-press
 * gesture feel like it registered before the dialog appears.
 *
 * Every call is fire-and-forget and swallows its own errors: a device with no
 * haptic motor, or a user who has disabled system haptics, must never turn a
 * confirmation into a crash.
 */

import * as Haptics from 'expo-haptics';

/** A press landed on something meaningful — long-press to remove, arming an alert. */
export function hapticImpact(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** A value changed inside a continuous control — colour slider, reorder, toggles. */
export function hapticSelection(): void {
  Haptics.selectionAsync().catch(() => {});
}

/** An action completed successfully — data exported, alert armed. */
export function hapticSuccess(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** An action failed or was refused — import rejected, alert could not start. */
export function hapticError(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
}
