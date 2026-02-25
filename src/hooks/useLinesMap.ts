import { useMemo } from 'react';
import { useLines } from './index';
import type { OasaLine } from '../types';

/**
 * Shared hook — builds a Map<LineCode, OasaLine> from the useLines() query.
 * Eliminates identical `useMemo(() => new Map(allLines.map(...)))` across 4 screens.
 */
export function useLinesMap() {
  const { data: allLines } = useLines();
  const linesMap = useMemo(() => {
    if (!allLines) return new Map<string, OasaLine>();
    return new Map(allLines.map((l) => [l.LineCode, l]));
  }, [allLines]);
  return { allLines, linesMap };
}
