/**
 * App-wide settings context — user icon choice and primary accent color.
 * Wraps the app so any screen can read/write these preferences reactively.
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { getSetting, setSetting } from '../../services/storage';

/* ── Defaults ────────────────────────────────────────────────── */

export const DEFAULT_PRIMARY = '#7B2CBF';
export const DEFAULT_ICON = 'cat'; // 'cat' | 'pin'

export const COLOR_PRESETS = [
  { label: 'Purple', hex: '#7B2CBF' },
  { label: 'Blue', hex: '#2563EB' },
  { label: 'Teal', hex: '#0D9488' },
  { label: 'Green', hex: '#16A34A' },
  { label: 'Red', hex: '#DC2626' },
  { label: 'Orange', hex: '#EA580C' },
  { label: 'Pink', hex: '#DB2777' },
] as const;

/* ── Context ─────────────────────────────────────────────────── */

interface SettingsContextValue {
  primaryColor: string;
  /**
   * Commit a new accent color. Every consumer of this context re-renders and
   * the value is serialized to storage, so this is a *commit*, not a preview —
   * continuous gestures (the hue slider) must keep their in-flight value in
   * local state and call this once, on release.
   */
  setPrimaryColor: (hex: string) => void;
  iconStyle: string; // 'cat' | 'pin'
  setIconStyle: (style: string) => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  primaryColor: DEFAULT_PRIMARY,
  setPrimaryColor: () => {},
  iconStyle: DEFAULT_ICON,
  setIconStyle: () => {},
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [primaryColor, _setPrimary] = useState(() => getSetting('primaryColor', DEFAULT_PRIMARY));
  const [iconStyle, _setIcon] = useState(() => getSetting('iconStyle', DEFAULT_ICON));

  const setPrimaryColor = useCallback((hex: string) => {
    // Cheap guard: the color picker can land on the value we already hold, and
    // an identical write would still re-render every consumer.
    _setPrimary((prev) => (prev === hex ? prev : hex));
    setSetting('primaryColor', hex);
  }, []);

  const setIconStyle = useCallback((style: string) => {
    _setIcon((prev) => (prev === style ? prev : style));
    setSetting('iconStyle', style);
  }, []);

  // Without this the context value is a fresh object on every provider render,
  // which re-renders every consumer (i.e. every card on Home) for nothing.
  const value = useMemo(
    () => ({ primaryColor, setPrimaryColor, iconStyle, setIconStyle }),
    [primaryColor, setPrimaryColor, iconStyle, setIconStyle],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}
