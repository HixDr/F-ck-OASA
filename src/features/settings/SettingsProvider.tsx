/**
 * App-wide settings context — user icon choice and primary accent color.
 * Wraps the app so any screen can read/write these preferences reactively.
 */

import React, { createContext, useContext, useState, useCallback } from 'react';
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
    _setPrimary(hex);
    setSetting('primaryColor', hex);
  }, []);

  const setIconStyle = useCallback((style: string) => {
    _setIcon(style);
    setSetting('iconStyle', style);
  }, []);

  return (
    <SettingsContext.Provider value={{ primaryColor, setPrimaryColor, iconStyle, setIconStyle }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
