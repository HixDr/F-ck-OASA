/**
 * FavoriteStopCard — live arrival dashboard for a saved stop.
 * Polls getStopArrivals + getRoutesForStop, groups by line,
 * and shows a compact arrival board with alert buttons.
 * Supports filtering visible lines via an edit mode.
 * Shows next scheduled departure when no live arrivals are available.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, radius, font } from '../theme';
import { getStopArrivals, getRoutesForStop, getRoutes, getDailySchedule } from '../api';
import { updateFavoriteStop, getCachedSchedule, setCachedSchedule, getCachedRoutesForStop, setCachedRoutesForStop, getCachedRoutes } from '../storage';
import { useLines } from '../hooks';
import { buildLineGroups, enrichWithDirectionHints, getArrivalColor, type LineGroup } from '../mapUtils';
import { startAlertWatch, stopAlertWatch, subscribeAlertConfig, type AlertConfig } from '../notifications';
import { parseSchedule, type LineSchedule } from '../scheduleUtils';
import type { FavoriteStop, OasaLine, OasaDailySchedule } from '../types';

const POLL_INTERVAL = 15_000;

/* ── Schedule grid with auto-scroll to next departure ────────── */

function ScheduleGrid({ times, nextDeparture, accentColor }: { times: string[]; nextDeparture: string | null; accentColor: string }) {
  const scrollRef = useRef<ScrollView>(null);
  const nextY = useRef(0);

  return (
    <ScrollView
      ref={scrollRef}
      style={schedStyles.scheduleScroll}
      showsVerticalScrollIndicator={false}
      nestedScrollEnabled
    >
      <View style={schedStyles.scheduleGrid}>
        {times.map((t, i) => {
          const now = new Date();
          const nowMin = now.getHours() * 60 + now.getMinutes();
          const [h, m] = t.split(':').map(Number);
          const isPast = h * 60 + m < nowMin;
          const isNext = t === nextDeparture;
          return (
            <View
              key={i}
              style={[schedStyles.scheduleTime, isNext && { backgroundColor: accentColor }]}
              onLayout={isNext ? (e) => {
                nextY.current = e.nativeEvent.layout.y;
                scrollRef.current?.scrollTo({ y: Math.max(0, nextY.current - 40), animated: false });
              } : undefined}
            >
              <Text style={[schedStyles.scheduleTimeText, isPast && schedStyles.scheduleTimePast, isNext && schedStyles.scheduleTimeNextText]}>{t}</Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

interface Props {
  stop: FavoriteStop;
  primaryColor: string;
  onRemove: () => void;
}

export default function FavoriteStopCard({ stop, primaryColor, onRemove }: Props) {
  const router = useRouter();
  const { data: allLines } = useLines();
  const linesMap = useMemo(() => {
    if (!allLines) return new Map<string, OasaLine>();
    return new Map(allLines.map((l) => [l.LineCode, l]));
  }, [allLines]);

  const [allLineGroups, setAllLineGroups] = useState<LineGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const routeToLineRef = useRef<Map<string, string>>(new Map());
  // Keep original descriptions for the edit screen (before "to X" enrichment)
  const rawDescrMap = useRef<Map<string, string>>(new Map());

  // Edit mode for line visibility
  const [editing, setEditing] = useState(false);
  const [visibleSet, setVisibleSet] = useState<Set<string> | null>(() =>
    stop.visibleLines ? new Set(stop.visibleLines) : null,
  );

  // Alert state
  const [arrivalAlert, setArrivalAlert] = useState<AlertConfig | null>(null);
  useEffect(() => subscribeAlertConfig(setArrivalAlert), []);
  const [alertLineCode, setAlertLineCode] = useState<string | null>(null);
  const [alertThreshold, setAlertThreshold] = useState('5');

  // Schedule state
  const [scheduleMap, setScheduleMap] = useState<Map<string, LineSchedule>>(new Map());
  const [expandedScheduleLine, setExpandedScheduleLine] = useState<string | null>(null);

  // Filtered lines for display
  const displayLines = useMemo(() => {
    if (!allLineGroups) return null;
    if (!visibleSet) return allLineGroups;
    return allLineGroups.filter((l) => visibleSet.has(l.lineCode));
  }, [allLineGroups, visibleSet]);

  // Initial load — fetch routes and arrivals
  const fetchData = useCallback(async () => {
    try {
      let routes: Awaited<ReturnType<typeof getRoutesForStop>> | null = null;
      let arrivals: Awaited<ReturnType<typeof getStopArrivals>> = [];
      try {
        [routes, arrivals] = await Promise.all([
          getRoutesForStop(stop.stopCode),
          getStopArrivals(stop.stopCode),
        ]);
        // Cache routes for offline use
        if (routes && routes.length > 0) {
          setCachedRoutesForStop(stop.stopCode, routes);
        }
      } catch {
        // Offline fallback — use cached routes, no arrivals
        routes = await getCachedRoutesForStop(stop.stopCode);
        arrivals = [];
      }
      const { lines: grouped, routeToLine } = buildLineGroups(routes ?? [], arrivals ?? [], linesMap);
      routeToLineRef.current = routeToLine;
      // Save raw descriptions before enrichment (for edit mode)
      grouped.forEach((l) => rawDescrMap.current.set(l.lineCode, l.lineDescrEng));
      // Enrich circular routes with direction hints
      const enriched = await enrichWithDirectionHints(grouped, stop.stopCode);
      setAllLineGroups(enriched);
    } catch {
      setAllLineGroups([]);
    } finally {
      setLoading(false);
    }
  }, [stop.stopCode, linesMap]);

  useEffect(() => {
    if (!allLines) return; // Wait for lines data to populate linesMap
    fetchData();
  }, [fetchData, allLines]);

  // Auto-refresh arrivals
  useEffect(() => {
    if (loading) return;
    const id = setInterval(async () => {
      try {
        const arrivals = await getStopArrivals(stop.stopCode);
        const routeToLine = routeToLineRef.current;
        const lineMinMap = new Map<string, number>();
        (arrivals ?? []).forEach((a) => {
          const lineCode = routeToLine.get(a.route_code);
          if (lineCode) {
            const min = Number(a.btime2);
            const prev = lineMinMap.get(lineCode);
            if (prev === undefined || min < prev) lineMinMap.set(lineCode, min);
          }
        });
        setAllLineGroups((prev) => {
          if (!prev) return prev;
          return prev.map((l) => {
            const nextMin = lineMinMap.get(l.lineCode) ?? null;
            const color = nextMin != null ? getArrivalColor(nextMin) : colors.textMuted;
            return { ...l, nextMin, color };
          });
        });
      } catch {}
    }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [stop.stopCode, loading]);

  // Fetch schedules for all displayed lines (one-time, cached)
  useEffect(() => {
    if (!allLineGroups || allLineGroups.length === 0) return;
    let cancelled = false;
    (async () => {
      const newMap = new Map<string, LineSchedule>();
      await Promise.allSettled(
        allLineGroups.map(async (line) => {
          try {
            // Determine direction: fetch line's routes, find index of our routeCode
            let direction: 'go' | 'come' = 'go';
            try {
              // Try API first, fall back to cache
              let lineRoutes;
              try {
                lineRoutes = await getRoutes(line.lineCode);
              } catch {
                lineRoutes = await getCachedRoutes(line.lineCode);
              }
              if (lineRoutes && lineRoutes.length > 0) {
                const idx = lineRoutes.findIndex((r) => r.RouteCode === line.routeCode);
                direction = idx <= 0 ? 'come' : 'go';
              }
            } catch {}

            // Try cache first, then network
            let data = await getCachedSchedule(line.lineCode);
            if (!data) {
              try {
                data = await getDailySchedule(line.lineCode);
                if (data) setCachedSchedule(line.lineCode, data);
              } catch {}
            }
            if (data) {
              newMap.set(line.lineCode, parseSchedule(data, direction));
            }
          } catch {}
        }),
      );
      if (!cancelled) setScheduleMap(newMap);
    })();
    return () => { cancelled = true; };
  }, [allLineGroups]);

  const handleLinePress = useCallback((line: LineGroup) => {
    const info = linesMap.get(line.lineCode);
    router.push({
      pathname: '/map/[lineCode]',
      params: {
        lineCode: line.lineCode,
        lineId: line.lineId,
        lineDescr: info?.LineDescrEng ?? info?.LineDescr ?? line.lineDescrEng,
      },
    });
  }, [linesMap, router]);

  const handleAlertToggle = useCallback((line: LineGroup) => {
    if (arrivalAlert?.stopCode === stop.stopCode) {
      stopAlertWatch();
      setAlertLineCode(null);
      return;
    }
    if (alertLineCode === line.lineCode) {
      setAlertLineCode(null);
      return;
    }
    setAlertLineCode(line.lineCode);
    setAlertThreshold('5');
  }, [arrivalAlert, stop.stopCode, alertLineCode]);

  const handleAlertConfirm = useCallback((line: LineGroup) => {
    const min = parseInt(alertThreshold, 10);
    if (!isNaN(min) && min > 0) {
      const routeCodes: string[] = [];
      routeToLineRef.current.forEach((lc, rc) => {
        if (lc === line.lineCode) routeCodes.push(rc);
      });
      startAlertWatch({
        stopCode: stop.stopCode,
        stopName: stop.stopName,
        thresholdMin: min,
        lineId: line.lineId,
        routeCodes,
        color: primaryColor,
      });
      setAlertLineCode(null);
    }
  }, [alertThreshold, stop]);

  const toggleLineVisibility = useCallback((lineCode: string) => {
    setVisibleSet((prev) => {
      const allCodes = (allLineGroups ?? []).map((l) => l.lineCode);
      const current = prev ?? new Set(allCodes);
      const next = new Set(current);
      if (next.has(lineCode)) {
        next.delete(lineCode);
      } else {
        next.add(lineCode);
      }
      // If all are selected, store null (show all)
      const result = next.size === allCodes.length ? null : next;
      updateFavoriteStop(stop.stopCode, {
        visibleLines: result ? [...result] : null,
      });
      return result;
    });
  }, [allLineGroups, stop.stopCode]);

  return (
    <View style={s.card}>
      <TouchableOpacity style={s.header} activeOpacity={0.7} onLongPress={onRemove}>
        <Ionicons name="location" size={16} color={primaryColor} />
        <Text style={s.stopName} numberOfLines={1}>{stop.stopName}</Text>
        {!loading && allLineGroups && allLineGroups.length > 0 && (
          <TouchableOpacity onPress={() => setEditing((v) => !v)} hitSlop={12}>
            <Ionicons name={editing ? 'checkmark-circle' : 'options-outline'} size={16}
              color={editing ? primaryColor : colors.textMuted} />
          </TouchableOpacity>
        )}
      </TouchableOpacity>

      {/* Edit mode — line visibility toggles */}
      {editing && allLineGroups && allLineGroups.length > 0 && (
        <ScrollView style={s.editScroll} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          {allLineGroups.map((line) => {
            const isVisible = !visibleSet || visibleSet.has(line.lineCode);
            return (
              <TouchableOpacity key={line.lineCode} style={s.editRow} activeOpacity={0.7}
                onPress={() => toggleLineVisibility(line.lineCode)}>
                <Ionicons
                  name={isVisible ? 'checkbox' : 'square-outline'}
                  size={18}
                  color={isVisible ? primaryColor : colors.textMuted}
                />
                <View style={[s.lineBadge, { backgroundColor: isVisible ? primaryColor : colors.border }]}>
                  <Text style={s.lineBadgeText}>{line.lineId}</Text>
                </View>
                <Text style={[s.lineDescr, !isVisible && { opacity: 0.4 }]}>
                  {rawDescrMap.current.get(line.lineCode) || line.lineDescrEng}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* Normal mode — filtered arrival board */}
      {!editing && (
        loading ? (
          <ActivityIndicator size="small" color={primaryColor} style={{ marginTop: spacing.sm }} />
        ) : displayLines && displayLines.length > 0 ? (
          displayLines.map((line) => {
            const isAlertActive = arrivalAlert?.stopCode === stop.stopCode && arrivalAlert?.lineId === line.lineId;
            const isAlertPicking = alertLineCode === line.lineCode;
            const lineSched = scheduleMap.get(line.lineCode);
            const isSchedExpanded = expandedScheduleLine === line.lineCode;
            return (
              <View key={line.lineCode}>
                <TouchableOpacity style={s.lineRow} activeOpacity={0.7}
                  onPress={() => handleLinePress(line)}>
                  <View style={[s.lineBadge, { backgroundColor: primaryColor }]}>
                    <Text style={s.lineBadgeText}>{line.lineId}</Text>
                  </View>
                  <Text style={s.lineDescr} numberOfLines={1}>{line.lineDescrEng}</Text>
                  {line.nextMin != null ? (
                    <View style={[s.arrivalBadge, { backgroundColor: line.color }]}>
                      <Text style={s.arrivalMin}>{line.nextMin}'</Text>
                    </View>
                  ) : lineSched?.nextDeparture ? (
                    <TouchableOpacity
                      style={s.schedBadge}
                      hitSlop={6}
                      onPress={() => setExpandedScheduleLine(isSchedExpanded ? null : line.lineCode)}>
                      <Ionicons name="time-outline" size={10} color={colors.textMuted} style={{ marginRight: 2 }} />
                      <Text style={s.schedBadgeText}>{lineSched.nextDeparture}</Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={s.noArrival}>—</Text>
                  )}
                  {/* Schedule toggle — show on all lines that have schedule data */}
                  {lineSched && lineSched.times.length > 0 && (
                    <TouchableOpacity
                      onPress={() => setExpandedScheduleLine(isSchedExpanded ? null : line.lineCode)}
                      hitSlop={14}
                      style={{ marginLeft: 6, padding: 6 }}>
                      <Ionicons name={isSchedExpanded ? 'time' : 'time-outline'} size={22}
                        color={isSchedExpanded ? primaryColor : colors.textMuted} />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity onPress={() => handleAlertToggle(line)} hitSlop={14} style={{ marginLeft: 4, padding: 6 }}>
                    <Ionicons
                      name={isAlertActive ? 'notifications' : 'notifications-outline'}
                      size={22}
                      color={isAlertActive ? colors.warning : colors.textMuted}
                    />
                  </TouchableOpacity>
                </TouchableOpacity>
                {/* Inline full schedule grid */}
                {isSchedExpanded && lineSched && (
                  <View style={s.schedExpandContainer}>
                    <ScheduleGrid times={lineSched.times} nextDeparture={lineSched.nextDeparture} accentColor={primaryColor} />
                  </View>
                )}
              </View>
            );
          })
        ) : displayLines && displayLines.length === 0 && visibleSet && visibleSet.size === 0 ? (
          <Text style={s.emptyText}>Tap <Ionicons name="options-outline" size={12} color={colors.textMuted} /> to choose lines</Text>
        ) : (
          <Text style={s.emptyText}>No lines found</Text>
        )
      )}

      {/* Alert picker modal */}
      <Modal visible={!!alertLineCode} transparent animationType="fade" onRequestClose={() => setAlertLineCode(null)}>
        <TouchableOpacity style={s.alertOverlay} activeOpacity={1} onPress={() => setAlertLineCode(null)}>
          <TouchableOpacity style={s.alertModal} activeOpacity={1} onPress={() => {}}>
            <Text style={s.alertModalTitle}>Set Arrival Alert</Text>
            <Text style={s.alertModalSubtitle}>
              {alertLineCode && displayLines ? displayLines.find(l => l.lineCode === alertLineCode)?.lineId : ''} at {stop.stopName}
            </Text>
            <View style={s.alertPickerRow}>
              <Text style={s.alertPickerLabel}>Alert when ≤</Text>
              <TextInput
                style={s.alertPickerInput}
                value={alertThreshold}
                onChangeText={setAlertThreshold}
                keyboardType="number-pad"
                maxLength={2}
                placeholderTextColor={colors.textMuted}
                autoFocus
              />
              <Text style={s.alertPickerLabel}>min</Text>
            </View>
            <View style={s.alertModalBtns}>
              <TouchableOpacity style={s.alertModalCancel} onPress={() => setAlertLineCode(null)}>
                <Text style={s.alertModalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.alertModalConfirm, { backgroundColor: primaryColor }]}
                onPress={() => {
                  const line = displayLines?.find(l => l.lineCode === alertLineCode);
                  if (line) handleAlertConfirm(line);
                }}>
                <Ionicons name="notifications" size={16} color="#FFF" />
                <Text style={s.alertModalConfirmText}>Start</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  stopName: {
    flex: 1,
    color: colors.text,
    fontSize: font.size.md,
    fontWeight: '600',
  },
  editScroll: {
    maxHeight: 200,
  },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs + 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs + 1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  lineBadge: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    marginRight: spacing.sm,
    minWidth: 40,
    alignItems: 'center',
  },
  lineBadgeText: {
    color: '#FFFFFF',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  lineDescr: {
    flex: 1,
    color: colors.textMuted,
    fontSize: font.size.xs,
    marginRight: spacing.sm,
  },
  arrivalBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  arrivalMin: {
    color: '#000',
    fontSize: font.size.xs,
    fontWeight: '700',
  },
  noArrival: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontWeight: '600',
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    textAlign: 'center',
    marginTop: spacing.xs,
    opacity: 0.7,
  },
  alertOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  alertModal: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minWidth: 280,
    maxWidth: 340,
    borderWidth: 1,
    borderColor: colors.border,
  },
  alertModalTitle: {
    color: colors.text,
    fontSize: font.size.lg,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  alertModalSubtitle: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    marginBottom: spacing.md,
  },
  alertPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: spacing.lg,
  },
  alertPickerLabel: {
    color: colors.textMuted,
    fontSize: font.size.md,
    fontWeight: '600',
  },
  alertPickerInput: {
    color: colors.text,
    fontSize: font.size.lg,
    fontWeight: '700',
    backgroundColor: colors.card,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    minWidth: 52,
    textAlign: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  alertModalBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  alertModalCancel: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  alertModalCancelText: {
    color: colors.textMuted,
    fontSize: font.size.sm,
    fontWeight: '600',
  },
  alertModalConfirm: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  alertModalConfirmText: {
    color: '#FFF',
    fontSize: font.size.sm,
    fontWeight: '700',
  },
  schedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  schedBadgeText: {
    color: colors.textMuted,
    fontSize: font.size.xs,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  schedExpandContainer: {
    paddingVertical: spacing.xs,
    paddingLeft: spacing.sm,
    maxHeight: 140,
  },
});

/* ── Schedule grid styles ──────────────────────────────────────── */

const schedStyles = StyleSheet.create({
  scheduleScroll: { maxHeight: 120 },
  scheduleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 3 },
  scheduleTime: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  scheduleTimeText: {
    color: colors.text,
    fontSize: font.size.xs,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  scheduleTimePast: { color: colors.textMuted, opacity: 0.5 },
  scheduleTimeNextText: { color: '#FFF', fontWeight: '700' },
});
