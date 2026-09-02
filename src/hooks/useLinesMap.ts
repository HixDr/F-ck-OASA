import { useMemo } from 'react';
import { useLines } from './index';
import type { OasaLine } from '../types';

/**
 * Shared hook — builds a Map<LineCode, OasaLine> from the useLines() query.
 * Eliminates identical `useMemo(() => new Map(allLines.map(...)))` across 4 screens.
 *
 * The query state is passed through as well: consumers used to gate their own
 * loading flag on `allLines` alone, so a failed lines request (airplane mode on
 * a fresh install) left them spinning forever with no way to retry.
 */
export function useLinesMap() {
  const { data: allLines, isLoading, isError, refetch } = useLines();
  const linesMap = useMemo(() => {
    if (!allLines) return new Map<string, OasaLine>();
    return new Map(allLines.map((l) => [l.LineCode, l]));
  }, [allLines]);
  /**
   * Is the catalogue usable yet?
   *
   * `buildLineGroups` resolves a badge as `linesMap.get(LineCode)?.LineID ??
   * LineCode`, and that fallback is the right last resort only when the
   * catalogue is genuinely unavailable — an internal code beats a blank badge.
   * While it is merely still in flight the fallback is a wrong answer, and the
   * routes query can easily win the race: it serves from its own cache. Cards
   * that keyed "ready" on routes alone painted 937 where 140 belongs for the
   * length of that gap.
   *
   * A hard failure counts as ready on purpose. Without that, a lines request
   * that cannot succeed — offline, no cache — would hold every badge behind a
   * skeleton for good instead of showing the fallback and a Retry.
   */
  const linesReady = linesMap.size > 0 || isError;
  return {
    allLines,
    linesMap,
    linesReady,
    linesLoading: isLoading,
    linesError: isError,
    refetchLines: refetch,
  };
}
