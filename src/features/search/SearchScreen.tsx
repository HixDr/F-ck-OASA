/**
 * Search screen — find bus lines by number or name.
 */

import React, { useCallback, useDeferredValue, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Keyboard,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font, HIT_SIZE } from '../../theme';
import { useLines } from '../../hooks';
import { addFavorite, isFavorite, removeFavorite, getFavorites, getSetting, setSetting } from '../../services/storage';
import { useSettings } from '../settings/SettingsProvider';
import type { OasaLine } from '../../types';

/** Recently opened line codes, newest first. */
const RECENT_KEY = 'recentLines';
const RECENT_MAX = 6;

function readRecents(): string[] {
  try {
    const parsed = JSON.parse(getSetting(RECENT_KEY, '[]'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Fold a string for searching: strip diacritics and case.
 *
 * OASA's data is Greek, and nobody types accents on a phone. Without this,
 * `'Αθήνα'.toLowerCase()` is `'αθήνα'` and a search for `αθηνα` found nothing —
 * in an Athens app. Final sigma is folded too ('Πατησίων' vs 'ΠΑΤΗΣΙΩΝΟΣ').
 */
function fold(input: string): string {
  let out = input;
  try {
    out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {
    // Hermes without full Unicode data — fall back to the Greek vowels that
    // actually carry tonos in stop and line names.
    out = out
      .replace(/[άΆ]/g, 'α').replace(/[έΈ]/g, 'ε').replace(/[ήΉ]/g, 'η')
      .replace(/[ίΊϊΐ]/g, 'ι').replace(/[όΌ]/g, 'ο').replace(/[ύΎϋΰ]/g, 'υ')
      .replace(/[ώΏ]/g, 'ω');
  }
  return out.toLowerCase().replace(/ς/g, 'σ');
}

export default function SearchScreen() {
  const router = useRouter();
  const { data: lines, isLoading, isError, refetch, isFetching } = useLines();
  const [query, setQuery] = useState('');
  const { primaryColor } = useSettings();

  /* Favourites are read from storage's synchronous mirror, which React cannot
     see. This counter is the subscription: it invalidates the derived set and
     is handed to the list as `extraData`. Previously the list only updated by
     accident, because the inline renderItem changed identity every render. */
  const [favVersion, setFavVersion] = useState(0);
  const favSet = useMemo(
    () => new Set(getFavorites().map((f) => f.lineCode)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [favVersion],
  );
  const [recents, setRecents] = useState<string[]>(readRecents);

  /* One normalized haystack per line, built once. The old filter called
     `.toLowerCase()` three times for each of ~470 lines on every keystroke,
     synchronously, inside the render that had to show the new character. */
  const index = useMemo(
    () =>
      (lines ?? []).map((line) => ({
        line,
        hay: fold(`${line.LineID} ${line.LineDescr} ${line.LineDescrEng}`),
      })),
    [lines],
  );

  // Typing stays responsive; the (heavier) list render is allowed to lag.
  const deferredQuery = useDeferredValue(query);

  const filtered = useMemo(() => {
    const q = fold(deferredQuery.trim());
    if (!q) return [];
    return index.filter((e) => e.hay.includes(q)).map((e) => e.line);
  }, [index, deferredQuery]);

  /** Browse path for an empty query — recents first, then saved lines. */
  const browse = useMemo(() => {
    if (!lines || query.trim()) return [];
    const byCode = new Map(lines.map((l) => [l.LineCode, l]));
    const out: OasaLine[] = [];
    const seen = new Set<string>();
    for (const code of [...recents, ...getFavorites().map((f) => f.lineCode)]) {
      if (seen.has(code)) continue;
      const line = byCode.get(code);
      if (!line) continue;
      seen.add(code);
      out.push(line);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, query, recents, favVersion]);

  const showingBrowse = !query.trim() && browse.length > 0;
  const data = showingBrowse ? browse : filtered;

  const handleSelect = useCallback((line: OasaLine) => {
    Keyboard.dismiss();
    const next = [line.LineCode, ...readRecents().filter((c) => c !== line.LineCode)].slice(0, RECENT_MAX);
    setSetting(RECENT_KEY, JSON.stringify(next));
    setRecents(next);
    router.push({
      pathname: '/map/[lineCode]',
      params: {
        lineCode: line.LineCode,
        lineId: line.LineID,
        lineDescr: line.LineDescrEng,
      },
    });
  }, [router]);

  const toggleFav = useCallback((line: OasaLine) => {
    if (isFavorite(line.LineCode)) {
      removeFavorite(line.LineCode);
    } else {
      addFavorite({
        lineCode: line.LineCode,
        lineId: line.LineID,
        lineDescr: line.LineDescr,
        lineDescrEng: line.LineDescrEng,
      });
    }
    setFavVersion((n) => n + 1);
  }, []);

  const renderItem = useCallback(({ item }: { item: OasaLine }) => {
    const faved = favSet.has(item.LineCode);
    return (
      <TouchableOpacity
        style={s.row}
        activeOpacity={0.7}
        onPress={() => handleSelect(item)}
        accessibilityRole="button"
        accessibilityLabel={`Line ${item.LineID}, ${item.LineDescrEng}`}
        accessibilityHint="Opens the live map for this line"
      >
        <View style={[s.badge, { backgroundColor: primaryColor }]}>
          <Text style={s.badgeText}>{item.LineID}</Text>
        </View>
        <View style={s.rowMeta}>
          <Text style={s.rowTitle} numberOfLines={1}>{item.LineDescrEng}</Text>
          <Text style={s.rowSub} numberOfLines={1}>{item.LineDescr}</Text>
        </View>
        <TouchableOpacity
          style={s.heartBtn}
          onPress={() => toggleFav(item)}
          accessibilityRole="switch"
          accessibilityState={{ checked: faved }}
          accessibilityLabel={`Save line ${item.LineID}`}
        >
          <Ionicons
            name={faved ? 'heart' : 'heart-outline'}
            size={22}
            color={faved ? '#B91C1C' : colors.textMuted}
          />
        </TouchableOpacity>
      </TouchableOpacity>
    );
  }, [favSet, primaryColor, handleSelect, toggleFav]);

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'Search Lines', headerShown: true }} />

      <View style={s.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          style={s.input}
          placeholder="Line number or destination…"
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={setQuery}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search bus lines"
        />
        {query.length > 0 && (
          <TouchableOpacity
            style={s.clearBtn}
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {isLoading ? (
        <ActivityIndicator
          size="large"
          color={primaryColor}
          style={{ marginTop: 40 }}
          accessibilityLabel="Loading bus lines"
        />
      ) : isError ? (
        /* There was no error state at all: a failed lines request left the user
           typing into a box that could never match anything. */
        <View style={s.errorBox}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.border} />
          <Text style={s.errorTitle}>Couldn't load the line list</Text>
          <Text style={s.errorSub}>Check your connection and try again.</Text>
          <TouchableOpacity
            style={[s.retryBtn, { borderColor: primaryColor }]}
            onPress={() => refetch()}
            accessibilityRole="button"
            accessibilityLabel="Retry loading lines"
          >
            {isFetching
              ? <ActivityIndicator size="small" color={primaryColor} />
              : <>
                  <Ionicons name="refresh" size={16} color={primaryColor} />
                  <Text style={[s.retryText, { color: primaryColor }]}>Retry</Text>
                </>}
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={data}
          extraData={favSet}
          keyExtractor={(item) => item.LineCode}
          renderItem={renderItem}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={s.list}
          ListHeaderComponent={
            showingBrowse ? <Text style={s.sectionLabel}>Recent &amp; saved</Text> : null
          }
          ListEmptyComponent={
            <Text style={s.emptyText}>
              {query.trim()
                ? 'No lines match your search.'
                : `Type to search among ${lines?.length ?? 0} lines.`}
            </Text>
          }
        />
      )}
    </View>
  );
}

/* ── Styles ──────────────────────────────────────────────────── */

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: HIT_SIZE + 4,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: font.size.md,
    marginLeft: spacing.sm,
    paddingVertical: spacing.xs,
  },
  clearBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -spacing.sm,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl * 2,
  },
  sectionLabel: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs + 2,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 60,
  },
  badge: {
    backgroundColor: colors.primary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
    minWidth: 44,
    alignItems: 'center',
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: font.size.sm,
    fontWeight: '700',
  },
  rowMeta: {
    flex: 1,
    marginRight: spacing.sm,
  },
  rowTitle: {
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: '500',
  },
  rowSub: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    marginTop: 2,
  },
  heartBtn: {
    width: HIT_SIZE,
    height: HIT_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: font.size.md,
    textAlign: 'center',
    marginTop: 40,
  },
  errorBox: {
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xl,
    marginTop: 60,
  },
  errorTitle: {
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  errorSub: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    minHeight: HIT_SIZE,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  retryText: {
    fontSize: font.size.sm,
    fontWeight: '700',
  },
});
