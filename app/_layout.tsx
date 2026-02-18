/**
 * Root layout — wraps the app in React Query provider + dark status bar.
 */

import React, { useEffect, useState } from 'react';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font, spacing, radius } from '../src/theme';
import { initStorage, prefetchFavoriteSchedules } from '../src/storage';
import { initLocation } from '../src/location';
import { setupNetworkListener, useNetworkStatus } from '../src/network';
import { subscribeAlertConfig, stopAlertWatch, type AlertConfig } from '../src/notifications';
import { SettingsProvider } from '../src/settings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      refetchOnWindowFocus: false,
    },
  },
});

/* ── Offline Banner ──────────────────────────────────────────── */

function OfflineBanner() {
  const isOnline = useNetworkStatus();
  if (isOnline) return null;
  return (
    <View style={ls.banner}>
      <Text style={ls.bannerText}>You are offline — showing cached data</Text>
    </View>
  );
}

/* ── Alert Pill (floating) ────────────────────────────────────── */

function AlertPill() {
  const [alert, setAlert] = useState<AlertConfig | null>(null);
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const isMap = pathname.startsWith('/map');
  const [deferredIsMap, setDeferredIsMap] = useState(isMap);

  useEffect(() => subscribeAlertConfig(setAlert), []);

  // Delay position change to let screen transition finish
  useEffect(() => {
    const t = setTimeout(() => setDeferredIsMap(isMap), 350);
    return () => clearTimeout(t);
  }, [isMap]);

  if (!alert) return null;

  const posStyle = deferredIsMap
    ? { top: insets.top + spacing.xl + spacing.lg + spacing.xs, left: spacing.sm }
    : { top: insets.top + 19, right: spacing.xl + spacing.md };

  return (
    <View style={[ls.alertPill, posStyle]}>
      <Text style={ls.alertPillIcon}>🔔</Text>
      <View style={ls.alertPillContent}>
        <Text style={ls.alertPillLine} numberOfLines={1}>{alert.lineId} ≤{alert.thresholdMin}′</Text>
      </View>
      <TouchableOpacity onPress={() => stopAlertWatch()} hitSlop={12} style={ls.alertPillClose}>
        <Text style={ls.alertPillCloseText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const ls = StyleSheet.create({
  banner: {
    backgroundColor: '#B91C1C',
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  bannerText: {
    color: '#FFF',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  alertPill: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.warning,
    borderRadius: radius.full,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.sm + 2,
    gap: spacing.xs,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 6,
  },
  alertPillIcon: { fontSize: 14 },
  alertPillContent: { },
  alertPillLine: {
    color: '#000',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  alertPillClose: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertPillCloseText: {
    color: '#000',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
});

export default function RootLayout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setupNetworkListener();
    Promise.all([initStorage(), initLocation()]).then(() => {
      setReady(true);
      // Silently pre-cache schedules for all favorite lines
      prefetchFavoriteSchedules();
    });
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={colors.primaryLight} />
      </View>
    );
  }

  return (
    <SettingsProvider>
    <QueryClientProvider client={queryClient}>
      <StatusBar style="light" backgroundColor={colors.bg} />
      <OfflineBanner />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: colors.bg },
          animation: 'slide_from_right',
        }}
      />
      <AlertPill />
    </QueryClientProvider>
    </SettingsProvider>
  );
}
