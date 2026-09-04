import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLines } from './index';
import { clearCachedLines } from '../services/storage';
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
   * `buildLineGroups` needs it to turn a route's LineCode into the number on
   * the front of the bus, and a card that renders before it lands shows every
   * line as unnamed. The routes query can easily win that race — it serves
   * from its own cache — so readiness is a question worth asking.
   *
   * A hard failure counts as ready on purpose. Without that, a lines request
   * that cannot succeed — offline, no cache — would hold every card behind a
   * skeleton for good instead of showing what it does know, and the Retry.
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

/**
 * One attempt, per app session, to replace a catalogue that cannot name the
 * LineCodes the route lists reference.
 *
 * A cached catalogue inside its TTL is not necessarily a correct one. When the
 * copy on disk predates a reorganisation at OASA it is simply wrong about the
 * network, and no amount of waiting fixes it — the entry is valid until it
 * expires, days later. Throwing it away and asking again is the only route
 * back, and it is cheap: ~150 KB, once.
 *
 * Strictly one-shot, and that is not a nicety. OASA publishes route lists and
 * the line catalogue separately and they do not always agree: on 2026-09-04
 * stop 240001 referenced LineCodes 1298, 1299 and 1300, none of which
 * `webGetLines` contained. Those misses are permanent and no refetch resolves
 * them, so a heal that retried on every miss would refetch the catalogue for
 * as long as the app stayed open. One try, then the app trusts what it has and
 * the badges say "unnamed" rather than inventing a number.
 */
let _healed = false;

export function useCatalogueHeal(unresolved: readonly string[] | null | undefined): void {
  const client = useQueryClient();
  const count = unresolved?.length ?? 0;
  useEffect(() => {
    if (count === 0 || _healed) return;
    _healed = true;
    void (async () => {
      await clearCachedLines();
      await client.invalidateQueries({ queryKey: ['lines'] });
    })();
  }, [count, client]);
}
