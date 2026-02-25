/**
 * Search screen — find bus lines by number or name.
 */

import React, { useMemo, useState } from 'react';
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
import { colors, spacing, radius, font } from '../../theme';
import { useLines } from '../../hooks';
import { addFavorite, isFavorite, removeFavorite } from '../../services/storage';
import { useSettings } from '../settings/SettingsProvider';
import type { OasaLine } from '../../types';

export default function SearchScreen() {
  const router = useRouter();
  const { data: lines, isLoading } = useLines();
  const [query, setQuery] = useState('');
  const { primaryColor } = useSettings();

  const filtered = useMemo(() => {
    if (!lines || !query.trim()) return [];
    const q = query.trim().toLowerCase();
    return lines.filter(
      (l) =>
        l.LineID.toLowerCase().includes(q) ||
        l.LineDescr.toLowerCase().includes(q) ||
        l.LineDescrEng.toLowerCase().includes(q),
    );
  }, [lines, query]);

  const handleSelect = (line: OasaLine) => {
    Keyboard.dismiss();
    router.push({
      pathname: '/map/[lineCode]',
      params: {
        lineCode: line.LineCode,
        lineId: line.LineID,
        lineDescr: line.LineDescrEng,
      },
    });
  };

  const [, forceUpdate] = useState(0);
  const toggleFav = (line: OasaLine) => {
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
    forceUpdate((n) => n + 1);
  };

  return (
    <View style={s.container}>
      <Stack.Screen
        options={{
          title: 'Search Lines',
          headerShown: true,
        }}
      />

      {/* Search Input */}
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
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={12}>
            <Ionicons name="close-circle" size={18} color={colors.textMuted} />
          </TouchableOpacity>
        )}
      </View>

      {isLoading ? (
        <ActivityIndicator
          size="large"
          color={colors.primaryLight}
          style={{ marginTop: 40 }}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.LineCode}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={s.list}
          renderItem={({ item }) => {
            const faved = isFavorite(item.LineCode);
            return (
              <TouchableOpacity
                style={s.row}
                activeOpacity={0.7}
                onPress={() => handleSelect(item)}
              >
                <View style={[s.badge, { backgroundColor: primaryColor }]}>
                  <Text style={s.badgeText}>{item.LineID}</Text>
                </View>
                <View style={s.rowMeta}>
                  <Text style={s.rowTitle} numberOfLines={1}>
                    {item.LineDescrEng}
                  </Text>
                  <Text style={s.rowSub} numberOfLines={1}>
                    {item.LineDescr}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => toggleFav(item)} hitSlop={12}>
                  <Ionicons
                    name={faved ? 'heart' : 'heart-outline'}
                    size={22}
                    color={faved ? '#B91C1C' : colors.textMuted}
                  />
                </TouchableOpacity>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <Text style={s.emptyText}>
              {query ? 'No lines match your search.' : 'Type to search among 464 lines.'}
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
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: font.size.md,
    marginLeft: spacing.sm,
    paddingVertical: spacing.xs,
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: 80,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.xs + 2,
    borderWidth: 1,
    borderColor: colors.border,
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
  emptyText: {
    color: colors.textMuted,
    fontSize: font.size.md,
    textAlign: 'center',
    marginTop: 40,
  },
});
