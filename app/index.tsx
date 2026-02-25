/**
 * Home Screen — Favorites + nearby stops.
 * Black/dark-purple themed with favorite line cards.
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  Image,
  Modal,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Stack } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font } from '../src/theme';
import { getFavorites, removeFavorite, getFavoriteStops, removeFavoriteStop, isOfflineDataDownloaded, getOfflineTimestamp } from '../src/storage';
import { downloadAllOfflineData, removeAllOfflineData, type OfflineProgress } from '../src/offlineData';
import { useLines } from '../src/hooks';
import { USER_MARKER_BASE64 } from '../src/userMarker';
import { useSettings } from '../src/settings';
import FavoriteStopCard from '../src/components/FavoriteStopCard';
import type { FavoriteLine, FavoriteStop } from '../src/types';

/* ── HSL → Hex helper ────────────────────────────────────────── */

const HUE_STEPS = 36; // one slice per 10°

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Build hue bar colors (S=70%, L=45% → vivid accent) */
const HUE_COLORS = Array.from({ length: HUE_STEPS }, (_, i) =>
  hslToHex((i * 360) / HUE_STEPS, 70, 45),
);

/** Extract hue (0-360) from a hex color string */
function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return h;
}

/* ── Favorite Card ───────────────────────────────────────────── */

function FavoriteCard({ fav, onRemove, accentColor }: { fav: FavoriteLine; onRemove: () => void; accentColor: string }) {
  const router = useRouter();

  return (
    <TouchableOpacity
      style={s.lineCard}
      activeOpacity={0.7}
      onPress={() =>
        router.push({
          pathname: '/map/[lineCode]',
          params: { lineCode: fav.lineCode, lineId: fav.lineId, lineDescr: fav.lineDescrEng },
        })
      }
      onLongPress={onRemove}
    >
      <View style={[s.lineBadge, { backgroundColor: accentColor }]}>
        <Text style={s.lineBadgeText}>{fav.lineId}</Text>
      </View>
    </TouchableOpacity>
  );
}

/* ── Home Screen ─────────────────────────────────────────────── */

export default function HomeScreen() {
  const router = useRouter();
  const [favorites, setFavorites] = useState<FavoriteLine[]>([]);
  const [favoriteStops, setFavoriteStops] = useState<FavoriteStop[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { primaryColor, setPrimaryColor, iconStyle, setIconStyle } = useSettings();
  const hueBarRef = useRef<View>(null);
  const hueBarWidth = useRef(0);
  const hueBarX = useRef(0);

  // Offline data download state
  const [offlineAvailable, setOfflineAvailable] = useState(isOfflineDataDownloaded());
  const [offlineTs, setOfflineTs] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [dlProgress, setDlProgress] = useState<OfflineProgress | null>(null);

  // Preload lines cache in background
  useLines();

  const loadFavorites = useCallback(() => {
    setFavorites(getFavorites());
    setFavoriteStops(getFavoriteStops());
    setOfflineAvailable(isOfflineDataDownloaded());
    getOfflineTimestamp().then(setOfflineTs);
  }, []);

  // Reload favorites when screen gains focus (returning from other screens)
  useFocusEffect(
    useCallback(() => {
      loadFavorites();
    }, [loadFavorites]),
  );

  const handleRemove = useCallback(
    (lineCode: string, lineId: string) => {
      Alert.alert('Remove Favorite', `Remove line ${lineId} from favorites?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => {
          const updated = removeFavorite(lineCode);
          setFavorites(updated);
        }},
      ]);
    },
    [],
  );

  const handleRemoveStop = useCallback(
    (stopCode: string, stopName: string) => {
      Alert.alert('Remove Stop', `Remove "${stopName}" from saved stops?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => {
          const updated = removeFavoriteStop(stopCode);
          setFavoriteStops(updated);
        }},
      ]);
    },
    [],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadFavorites();
    setRefreshing(false);
  }, [loadFavorites]);

  const handleDownloadOffline = useCallback(async () => {
    setDownloading(true);
    setDlProgress(null);
    const ok = await downloadAllOfflineData((p) => setDlProgress(p));
    setDownloading(false);
    if (ok) {
      setOfflineAvailable(true);
      getOfflineTimestamp().then(setOfflineTs);
    }
  }, []);

  const handleClearOffline = useCallback(() => {
    Alert.alert('Clear Offline Data', 'This will remove all cached stops and schedules.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear', style: 'destructive', onPress: async () => {
          await removeAllOfflineData();
          setOfflineAvailable(false);
          setOfflineTs(null);
          setDlProgress(null);
        },
      },
    ]);
  }, []);

  return (
    <View style={s.container}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Header */}
      <View style={s.header}>
        <View style={s.logoRow}>
          <TouchableOpacity onPress={() => setShowSettings(true)} activeOpacity={0.7}>
            <Image source={{ uri: USER_MARKER_BASE64 }} style={s.logoIcon} />
          </TouchableOpacity>
          <Text style={s.logo}>F*ck OASA</Text>
        </View>
        <View style={s.actionRow}>
          <TouchableOpacity
            style={s.searchBtn}
            onPress={() => router.push('/search')}
          >
            <Ionicons name="search" size={20} color={colors.text} />
            <Text style={s.searchBtnText} numberOfLines={1}>Find a line…</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.nearbyBtn}
            activeOpacity={0.7}
            onPress={() => router.push('/map/nearby')}
          >
            <Ionicons name="location" size={20} color={primaryColor} />
            <Text style={s.nearbyBtnText}>Nearby</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.nearbyBtn}
            activeOpacity={0.7}
            onPress={() => router.push('/planner')}
          >
            <Ionicons name="navigate" size={20} color={primaryColor} />
            <Text style={s.nearbyBtnText}>Go To</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Favorites List */}
      {favorites.length === 0 && favoriteStops.length === 0 ? (
        <View style={s.empty}>
          <Ionicons name="heart-outline" size={48} color={colors.border} />
          <Text style={s.emptyTitle}>No favorites yet</Text>
          <Text style={s.emptySubtitle}>
            Search for a bus line and tap the heart to add it here.{'\n'}
            Tap a stop on the map and bookmark it for quick arrivals.
          </Text>
        </View>
      ) : (
        <FlatList
          data={[]}
          keyExtractor={() => ''}
          renderItem={() => null}
          ListHeaderComponent={
            <>
              {(favoriteStops.length > 0 || favorites.length > 0) && (
                <Text style={s.sectionHint}>Long press to remove</Text>
              )}
              {favoriteStops.length > 0 && (
                <View style={s.stopsSection}>
                  <Text style={s.sectionLabel}>Saved Stops</Text>
                  {favoriteStops.map((stop) => (
                    <FavoriteStopCard
                      key={stop.stopCode}
                      stop={stop}
                      primaryColor={primaryColor}
                      onRemove={() => handleRemoveStop(stop.stopCode, stop.stopName)}
                    />
                  ))}
                </View>
              )}
              {favorites.length > 0 && (
                <View>
                  <Text style={s.sectionLabel}>Saved Lines</Text>
                  <View style={s.lineGrid}>
                    {favorites.map((fav) => (
                      <FavoriteCard key={fav.lineCode} fav={fav} onRemove={() => handleRemove(fav.lineCode, fav.lineId)} accentColor={primaryColor} />
                    ))}
                  </View>
                </View>
              )}
            </>
          }
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primaryLight}
              colors={[colors.primaryLight]}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Settings modal */}
      <Modal visible={showSettings} transparent animationType="fade" onRequestClose={() => setShowSettings(false)}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setShowSettings(false)}>
          <TouchableOpacity style={s.modalCard} activeOpacity={1} onPress={() => {}}>
            <Text style={s.modalTitle}>Settings</Text>

            {/* Icon style */}
            <Text style={s.modalLabel}>Location Icon</Text>
            <View style={s.iconRow}>
              <TouchableOpacity
                style={[s.iconOption, iconStyle === 'cat' && { borderColor: primaryColor }]}
                onPress={() => setIconStyle('cat')}
              >
                <Image source={{ uri: USER_MARKER_BASE64 }} style={{ width: 28, height: 28 }} />
                <Text style={s.iconOptionText}>Cat</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.iconOption, iconStyle === 'pin' && { borderColor: primaryColor }]}
                onPress={() => setIconStyle('pin')}
              >
                <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: '#4285F4', borderWidth: 2, borderColor: '#FFF' }} />
                <Text style={s.iconOptionText}>Dot</Text>
              </TouchableOpacity>
            </View>

            {/* Color picker — hue bar */}
            <Text style={[s.modalLabel, { marginTop: spacing.md }]}>Accent Color</Text>
            <View style={s.hueBarWrap}>
              <View
                ref={hueBarRef}
                style={s.hueBar}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderTerminationRequest={() => false}
                onResponderGrant={(e) => {
                  const x = e.nativeEvent.pageX - hueBarX.current;
                  const w = hueBarWidth.current;
                  if (w > 0) {
                    const hue = Math.max(0, Math.min(359, (x / w) * 360));
                    setPrimaryColor(hslToHex(hue, 70, 45));
                  }
                }}
                onResponderMove={(e) => {
                  const x = e.nativeEvent.pageX - hueBarX.current;
                  const w = hueBarWidth.current;
                  if (w > 0) {
                    const hue = Math.max(0, Math.min(359, (x / w) * 360));
                    setPrimaryColor(hslToHex(hue, 70, 45));
                  }
                }}
                onLayout={() => {
                  hueBarRef.current?.measureInWindow((x, _y, w) => {
                    hueBarX.current = x;
                    hueBarWidth.current = w;
                  });
                }}
              >
                {HUE_COLORS.map((c, i) => (
                  <View key={i} style={{ flex: 1, backgroundColor: c }} />
                ))}
                <View style={[s.hueIndicator, { left: `${(hexToHue(primaryColor) / 360) * 100}%` }]} />
              </View>
              <View style={[s.huePreview, { backgroundColor: primaryColor }]} />
            </View>

            {/* Offline data */}
            <Text style={[s.modalLabel, { marginTop: spacing.md }]}>Offline Data</Text>
            {downloading ? (
              <View style={s.offlineSection}>
                <Text style={s.offlineStatus}>
                  {!dlProgress && 'Starting…'}
                  {dlProgress?.phase === 'lines' && 'Fetching lines…'}
                  {dlProgress?.phase === 'stops' && 'Fetching all stops…'}
                  {dlProgress?.phase === 'routes' && `Routes ${dlProgress.current}/${dlProgress.total}`}
                  {dlProgress?.phase === 'schedules' && `Schedules ${dlProgress.current}/${dlProgress.total}`}
                  {dlProgress?.phase === 'done' && 'Saving…'}
                </Text>
                {dlProgress && dlProgress.total > 0 && (
                  <View style={s.progressBarBg}>
                    <View style={[s.progressBarFill, { width: `${Math.round((dlProgress.current / dlProgress.total) * 100)}%`, backgroundColor: primaryColor }]} />
                  </View>
                )}
                {(!dlProgress || dlProgress.total === 0) && (
                  <ActivityIndicator size="small" color={primaryColor} />
                )}
              </View>
            ) : dlProgress?.phase === 'error' ? (
              <View>
                <Text style={[s.offlineStatus, { color: colors.danger, marginBottom: spacing.xs }]}>
                  {dlProgress.message}
                </Text>
                <TouchableOpacity style={[s.offlineDownloadBtn, { borderColor: primaryColor }]} onPress={handleDownloadOffline}>
                  <Ionicons name="refresh" size={18} color={primaryColor} />
                  <Text style={[s.offlineDownloadText, { color: primaryColor }]}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : offlineAvailable ? (
              <View style={s.offlineSection}>
                <Text style={s.offlineStatus}>
                  Downloaded {offlineTs ? new Date(offlineTs).toLocaleDateString() : ''}
                </Text>
                <TouchableOpacity style={s.offlineClearBtn} onPress={handleClearOffline}>
                  <Ionicons name="trash-outline" size={16} color={colors.danger} />
                  <Text style={[s.offlineClearText, { color: colors.danger }]}>Clear</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity style={[s.offlineDownloadBtn, { borderColor: primaryColor }]} onPress={handleDownloadOffline}>
                <Ionicons name="cloud-download-outline" size={18} color={primaryColor} />
                <Text style={[s.offlineDownloadText, { color: primaryColor }]}>Download for offline use</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={[s.modalDone, { backgroundColor: primaryColor }]} onPress={() => setShowSettings(false)}>
              <Text style={s.modalDoneText}>Done</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

/* ── Styles ──────────────────────────────────────────────────── */

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingTop: 56,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  logoIcon: {
    width: 32,
    height: 32,
  },
  logo: {
    fontSize: font.size.xxl,
    fontWeight: '800',
    color: colors.primaryLight,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  searchBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  searchBtnText: {
    color: colors.textMuted,
    fontSize: font.size.md,
    marginLeft: spacing.sm,
    flexShrink: 1,
  },
  nearbyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  nearbyBtnText: {
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: '600',
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 120,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  lineGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  lineCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lineBadge: {
    backgroundColor: colors.primary, // overridden inline
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.xs + 2,
    minWidth: 44,
    alignItems: 'center',
  },
  lineBadgeText: {
    color: '#FFFFFF',
    fontSize: font.size.sm,
    fontWeight: '700',
  },
  cardTitle: {
    flex: 1,
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: '500',
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },
  emptyTitle: {
    color: colors.textMuted,
    fontSize: font.size.lg,
    fontWeight: '600',
    marginTop: spacing.md,
  },
  emptySubtitle: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    textAlign: 'center',
    marginTop: spacing.xs,
    opacity: 0.7,
  },
  stopsSection: {
    marginBottom: spacing.sm,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  sectionHint: {
    color: colors.textMuted,
    fontSize: font.size.xs - 1,
    opacity: 0.5,
    marginBottom: spacing.xs,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.lg,
    width: '80%',
    borderWidth: 1,
    borderColor: colors.border,
  },
  modalTitle: {
    color: colors.text,
    fontSize: font.size.lg,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  modalLabel: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  iconRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  iconOption: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.border,
    gap: 4,
    minWidth: 72,
  },
  iconOptionText: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '600',
  },
  hueBarWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  hueBar: {
    flex: 1,
    height: 32,
    borderRadius: radius.sm,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  hueIndicator: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 3,
    marginLeft: -1.5,
    backgroundColor: '#FFF',
    borderRadius: 1.5,
  },
  huePreview: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: '#FFF',
  },
  modalDone: {
    marginTop: spacing.lg,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  modalDoneText: {
    color: '#FFF',
    fontSize: font.size.md,
    fontWeight: '700',
  },
  offlineSection: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  offlineStatus: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    flex: 1,
  },
  offlineClearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  offlineClearText: {
    fontSize: font.size.xs,
    fontWeight: '600',
  },
  offlineDownloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
  },
  offlineDownloadText: {
    fontSize: font.size.sm,
    fontWeight: '600',
  },
  progressBarBg: {
    flex: 1,
    height: 6,
    backgroundColor: colors.border,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    borderRadius: 3,
  },
});
