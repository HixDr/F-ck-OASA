/**
 * Home Screen — saved stops first, then saved lines.
 *
 * The saved stops are the answer to "when is my bus coming?", so they are the
 * list itself: a real virtualized FlatList, not a ScrollView wearing a FlatList
 * costume with everything crammed into ListHeaderComponent.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Image,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Alert,
  type ListRenderItemInfo,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing } from '../../theme';
import * as storage from '../../services/storage';
import {
  getFavorites,
  removeFavorite,
  getFavoriteStops,
  removeFavoriteStop,
  addFavoriteStop,
  isOfflineDataDownloaded,
  getOfflineTimestamp,
} from '../../services/storage';
import { downloadAllOfflineData, removeAllOfflineData, type OfflineProgress } from '../../services/offlineData';
import { useLines } from '../../hooks';
import { USER_MARKER_BASE64 } from '../../data/userMarker';
import { useSettings } from '../settings/SettingsProvider';
import FavoriteStopCard from '../../components/FavoriteStopCard';
import SettingsModal from '../../components/SettingsModal';
import { s } from './HomeScreen.styles';
import type { FavoriteLine, FavoriteStop } from '../../types';

/**
 * Persist a new saved-stop order.
 *
 * A `reorderFavoriteStops` in services/storage would say this in one call; until
 * it exists we rebuild through the existing add/remove API. That is safe rather
 * than merely lucky: storage coalesces pending writes per key and serializes the
 * in-memory mirror at flush time, so the whole rebuild lands as one write of the
 * final array.
 */
function persistStopOrder(next: FavoriteStop[]): void {
  const ext = storage as unknown as Partial<{ reorderFavoriteStops: (codes: string[]) => void }>;
  if (typeof ext.reorderFavoriteStops === 'function') {
    ext.reorderFavoriteStops(next.map((st) => st.stopCode));
    return;
  }
  for (const st of next) removeFavoriteStop(st.stopCode);
  for (const st of next) addFavoriteStop(st);
}

/* ── Saved line chip ─────────────────────────────────────────── */

interface FavoriteCardProps {
  fav: FavoriteLine;
  editing: boolean;
  accentColor: string;
  onOpen: (fav: FavoriteLine) => void;
  onRemove: (fav: FavoriteLine) => void;
}

const FavoriteCard = React.memo(function FavoriteCard({
  fav,
  editing,
  accentColor,
  onOpen,
  onRemove,
}: FavoriteCardProps) {
  return (
    <TouchableOpacity
      style={s.lineCard}
      activeOpacity={0.7}
      onPress={() => (editing ? onRemove(fav) : onOpen(fav))}
      onLongPress={() => onRemove(fav)}
      accessibilityRole="button"
      accessibilityLabel={
        editing
          ? `Remove line ${fav.lineId} from saved lines`
          : `Line ${fav.lineId}, ${fav.lineDescrEng}`
      }
      accessibilityHint={editing ? undefined : 'Opens the live map for this line'}
    >
      <View style={[s.lineBadge, { backgroundColor: accentColor }]}>
        <Text style={s.lineBadgeText}>{fav.lineId}</Text>
      </View>
      {editing && (
        <Ionicons name="close-circle" size={20} color={colors.danger} style={s.lineRemove} />
      )}
    </TouchableOpacity>
  );
});

/* ── Home Screen ─────────────────────────────────────────────── */

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const { primaryColor, setPrimaryColor, iconStyle, setIconStyle } = useSettings();

  /* Seeded from storage's synchronous mirror. These used to start empty and be
     filled in useFocusEffect — which runs after commit, so frame 1 told every
     existing user "No favorites yet" on every cold start. */
  const [favorites, setFavorites] = useState<FavoriteLine[]>(getFavorites);
  const [favoriteStops, setFavoriteStops] = useState<FavoriteStop[]>(getFavoriteStops);
  const [refreshing, setRefreshing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editing, setEditing] = useState(false);
  /** Home stays mounted under /search, /map/* and /planner, so cards must be
   *  told to stop polling rather than relying on unmount. */
  const [focused, setFocused] = useState(true);

  // Offline data download state
  const [offlineAvailable, setOfflineAvailable] = useState(isOfflineDataDownloaded);
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

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      loadFavorites();
      return () => setFocused(false);
    }, [loadFavorites]),
  );

  const handleRemove = useCallback((fav: FavoriteLine) => {
    Alert.alert('Remove Line', `Remove line ${fav.lineId} from saved lines?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => setFavorites(removeFavorite(fav.lineCode)),
      },
    ]);
  }, []);

  const handleOpenLine = useCallback((fav: FavoriteLine) => {
    router.push({
      pathname: '/map/[lineCode]',
      params: { lineCode: fav.lineCode, lineId: fav.lineId, lineDescr: fav.lineDescrEng },
    });
  }, [router]);

  const handleRemoveStop = useCallback((stop: FavoriteStop) => {
    Alert.alert('Remove Stop', `Remove "${stop.stopName}" from saved stops?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => setFavoriteStops(removeFavoriteStop(stop.stopCode)),
      },
    ]);
  }, []);

  /** Reorder by one position. The storage write stays outside the state
   *  updater — updaters must be pure, React may replay them. */
  const moveStop = useCallback((stop: FavoriteStop, delta: number) => {
    const i = favoriteStops.findIndex((st) => st.stopCode === stop.stopCode);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= favoriteStops.length) return;
    const next = favoriteStops.slice();
    next[i] = favoriteStops[j];
    next[j] = favoriteStops[i];
    setFavoriteStops(next);
    persistStopOrder(next);
  }, [favoriteStops]);

  const moveStopUp = useCallback((stop: FavoriteStop) => moveStop(stop, -1), [moveStop]);
  const moveStopDown = useCallback((stop: FavoriteStop) => moveStop(stop, 1), [moveStop]);

  /**
   * Pull to refresh. This used to call `loadFavorites()` between two batched
   * `setRefreshing` calls — the spinner never appeared and no arrival data was
   * ever refetched. It is the most natural gesture in a bus app.
   */
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    loadFavorites();
    try {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['arrivals'] }),
        queryClient.refetchQueries({ queryKey: ['routesForStop'] }),
      ]);
    } catch {
      // A failed refresh is surfaced per-card; the spinner must still stop.
    } finally {
      setRefreshing(false);
    }
  }, [loadFavorites, queryClient]);

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
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await removeAllOfflineData();
          setOfflineAvailable(false);
          setOfflineTs(null);
          setDlProgress(null);
        },
      },
    ]);
  }, []);

  /* ── List plumbing ─────────────────────────────────────────── */

  const listExtra = useMemo(
    () => ({ primaryColor, focused, editing, count: favoriteStops.length }),
    [primaryColor, focused, editing, favoriteStops.length],
  );

  const renderStop = useCallback(
    ({ item, index }: ListRenderItemInfo<FavoriteStop>) => (
      <FavoriteStopCard
        stop={item}
        primaryColor={primaryColor}
        active={focused}
        editing={editing}
        onRemove={handleRemoveStop}
        onMoveUp={moveStopUp}
        onMoveDown={moveStopDown}
        canMoveUp={index > 0}
        canMoveDown={index < favoriteStops.length - 1}
      />
    ),
    [primaryColor, focused, editing, handleRemoveStop, moveStopUp, moveStopDown, favoriteStops.length],
  );

  const listHeader = useMemo(
    () => (favoriteStops.length > 0 ? <Text style={s.sectionLabel}>Saved Stops</Text> : null),
    [favoriteStops.length],
  );

  const listFooter = useMemo(
    () =>
      favorites.length > 0 ? (
        <View style={{ marginTop: spacing.md }}>
          <Text style={s.sectionLabel}>Saved Lines</Text>
          <View style={s.lineGrid}>
            {favorites.map((fav) => (
              <FavoriteCard
                key={fav.lineCode}
                fav={fav}
                editing={editing}
                accentColor={primaryColor}
                onOpen={handleOpenLine}
                onRemove={handleRemove}
              />
            ))}
          </View>
        </View>
      ) : null,
    [favorites, editing, primaryColor, handleOpenLine, handleRemove],
  );

  const isEmpty = favorites.length === 0 && favoriteStops.length === 0;
  const canEdit = !isEmpty;

  return (
    <View style={[s.container, { paddingTop: insets.top + spacing.sm }]}>
      <Stack.Screen options={{ headerShown: false }} />

      <View style={s.header}>
        <View style={s.logoRow}>
          <TouchableOpacity
            style={s.avatarBtn}
            onPress={() => setShowSettings(true)}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Image source={{ uri: USER_MARKER_BASE64 }} style={s.logoIcon} />
          </TouchableOpacity>
          {/* Wears the accent color: it was the one piece of chrome the
              setting never reached. */}
          <Text style={[s.logo, { color: primaryColor }]}>F*ck OASA</Text>
          {canEdit && (
            <TouchableOpacity
              style={s.editBtn}
              onPress={() => setEditing((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ selected: editing }}
              accessibilityLabel={editing ? 'Finish editing saved items' : 'Edit saved items'}
            >
              <Ionicons
                name={editing ? 'checkmark' : 'create-outline'}
                size={16}
                color={editing ? primaryColor : colors.textMuted}
              />
              <Text style={[s.editBtnText, { color: editing ? primaryColor : colors.textMuted }]}>
                {editing ? 'Done' : 'Edit'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={s.actionRow}>
          <TouchableOpacity
            style={s.searchBtn}
            onPress={() => router.push('/search')}
            accessibilityRole="button"
            accessibilityLabel="Search for a bus line"
          >
            <Ionicons name="search" size={20} color={colors.text} />
            <Text style={s.searchBtnText} numberOfLines={1}>Find a line…</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.nearbyBtn}
            activeOpacity={0.7}
            onPress={() => router.push('/map/nearby')}
            accessibilityRole="button"
            accessibilityLabel="Stops near me"
          >
            <Ionicons name="location" size={20} color={primaryColor} />
            <Text style={s.nearbyBtnText}>Nearby</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.nearbyBtn}
            activeOpacity={0.7}
            onPress={() => router.push('/planner')}
            accessibilityRole="button"
            accessibilityLabel="Plan a journey"
          >
            <Ionicons name="navigate" size={20} color={primaryColor} />
            <Text style={s.nearbyBtnText}>Go To</Text>
          </TouchableOpacity>
        </View>

        {/* Dismissing the settings sheet used to hide an in-flight download
            entirely, with no way to tell whether it was still running. */}
        {downloading && !showSettings && (
          <View style={s.headerProgress} accessibilityLabel="Downloading offline data">
            <Text style={s.headerProgressText}>Offline data…</Text>
            <View style={s.headerProgressTrack}>
              <View
                style={[
                  s.headerProgressFill,
                  {
                    backgroundColor: primaryColor,
                    width: dlProgress && dlProgress.total > 0
                      ? `${Math.round((dlProgress.current / dlProgress.total) * 100)}%`
                      : '5%',
                  },
                ]}
              />
            </View>
          </View>
        )}
      </View>

      {isEmpty ? (
        <View style={s.empty}>
          <Ionicons name="bus-outline" size={48} color={colors.border} />
          <Text style={s.emptyTitle}>Nothing saved yet</Text>
          <Text style={s.emptySubtitle}>
            Save the stops you use and their arrivals show up here.
          </Text>
          <View style={s.emptyActions}>
            <TouchableOpacity
              style={[s.emptyPrimaryBtn, { backgroundColor: primaryColor }]}
              onPress={() => router.push('/map/nearby')}
              accessibilityRole="button"
              accessibilityLabel="Find stops near me"
            >
              <Ionicons name="location" size={18} color="#FFF" />
              <Text style={s.emptyPrimaryText}>Find stops near me</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.emptySecondaryBtn}
              onPress={() => router.push('/search')}
              accessibilityRole="button"
              accessibilityLabel="Search for a bus line"
            >
              <Ionicons name="search" size={18} color={colors.text} />
              <Text style={s.emptySecondaryText}>Search a line</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <FlatList
          data={favoriteStops}
          keyExtractor={(item) => item.stopCode}
          renderItem={renderStop}
          extraData={listExtra}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
          contentContainerStyle={[s.list, { paddingBottom: insets.bottom + spacing.xl * 2 }]}
          initialNumToRender={4}
          windowSize={5}
          // Cards contain nested ScrollViews (timetable grid, line filter),
          // which Android blanks out when their cell is clipped.
          removeClippedSubviews={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={primaryColor}
              colors={[primaryColor]}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}

      <SettingsModal
        visible={showSettings}
        onClose={() => setShowSettings(false)}
        primaryColor={primaryColor}
        setPrimaryColor={setPrimaryColor}
        iconStyle={iconStyle}
        setIconStyle={setIconStyle}
        offlineAvailable={offlineAvailable}
        offlineTs={offlineTs}
        downloading={downloading}
        progress={dlProgress}
        onDownload={handleDownloadOffline}
        onClear={handleClearOffline}
        onDataRestored={loadFavorites}
      />
    </View>
  );
}
