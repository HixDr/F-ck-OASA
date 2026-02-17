/**
 * Root layout — wraps the app in React Query provider + dark status bar.
 */

import React, { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
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

/* ── Alert Banner ────────────────────────────────────────────── */

function AlertBanner() {
  const [alert, setAlert] = useState<AlertConfig | null>(null);
  const insets = useSafeAreaInsets();
  useEffect(() => subscribeAlertConfig(setAlert), []);
  if (!alert) return null;
  return (
    <View style={[ls.alertBanner, { paddingTop: insets.top + spacing.xs + 2 }]}>
      <Text style={ls.alertBannerIcon}>🔔</Text>
      <Text style={ls.alertBannerText} numberOfLines={1}>
        {alert.lineId} — ≤{alert.thresholdMin}min at {alert.stopName}
      </Text>
      <TouchableOpacity onPress={() => stopAlertWatch()} hitSlop={8}>
        <Text style={ls.alertBannerDismiss}>✕</Text>
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
  alertBanner: {
    backgroundColor: '#451A03',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F59E0B',
  },
  alertBannerIcon: { fontSize: 12 },
  alertBannerText: {
    flex: 1,
    color: '#FBBF24',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  alertBannerDismiss: {
    color: '#FBBF24',
    fontSize: font.size.sm,
    fontWeight: '700',
    paddingHorizontal: spacing.xs,
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
      <AlertBanner />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: colors.bg },
          animation: 'slide_from_right',
        }}
      />
    </QueryClientProvider>
    </SettingsProvider>
  );
}
