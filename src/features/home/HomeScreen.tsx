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
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Stack } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing } from '../../theme';
import { getFavorites, removeFavorite, getFavoriteStops, removeFavoriteStop, isOfflineDataDownloaded, getOfflineTimestamp } from '../../services/storage';
import { downloadAllOfflineData, removeAllOfflineData, type OfflineProgress } from '../../services/offlineData';
import { useLines } from '../../hooks';
import { USER_MARKER_BASE64 } from '../../data/userMarker';
import { useSettings } from '../settings/SettingsProvider';
import FavoriteStopCard from '../../components/FavoriteStopCard';
import { hslToHex, hexToHue, HUE_COLORS } from '../../utils/colorUtils';
import { s } from './HomeScreen.styles';
import type { FavoriteLine, FavoriteStop } from '../../types';

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

