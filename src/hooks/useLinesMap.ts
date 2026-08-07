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
  return { allLines, linesMap, linesLoading: isLoading, linesError: isError, refetchLines: refetch };
}
