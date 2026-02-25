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
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing } from '../theme';
import { getStopArrivals, getRoutesForStop, getRoutes, getDailySchedule } from '../services/api';
import { updateFavoriteStop, getCachedSchedule, setCachedSchedule, getCachedRoutesForStop, setCachedRoutesForStop, getCachedRoutes } from '../services/storage';
import { useLinesMap } from '../hooks/useLinesMap';
import { buildLineGroups, enrichWithDirectionHints, getArrivalColor, type LineGroup } from '../features/map/mapUtils';
import { startAlertWatch, stopAlertWatch, subscribeAlertConfig, type AlertConfig } from '../services/notifications';
import { parseSchedule, type LineSchedule } from '../utils/scheduleUtils';
import ScheduleGrid from './ScheduleGrid';
import AlertPickerModal from './AlertPickerModal';
import { s } from './FavoriteStopCard.styles';
import type { FavoriteStop } from '../types';

const POLL_INTERVAL = 15_000;

interface Props {
  stop: FavoriteStop;
  primaryColor: string;
  onRemove: () => void;
}

export default function FavoriteStopCard({ stop, primaryColor, onRemove }: Props) {
  const router = useRouter();
  const { allLines, linesMap } = useLinesMap();

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
                    <ScheduleGrid times={lineSched.times} nextDeparture={lineSched.nextDeparture} accentColor={primaryColor} maxHeight={120} />
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
      <AlertPickerModal
        visible={!!alertLineCode}
        subtitle={`${alertLineCode && displayLines ? displayLines.find(l => l.lineCode === alertLineCode)?.lineId : ''} at ${stop.stopName}`}
        threshold={alertThreshold}
        onChangeThreshold={setAlertThreshold}
        accentColor={primaryColor}
        onCancel={() => setAlertLineCode(null)}
        onConfirm={() => {
          const line = displayLines?.find(l => l.lineCode === alertLineCode);
          if (line) handleAlertConfirm(line);
        }}
      />
    </View>
  );
}

