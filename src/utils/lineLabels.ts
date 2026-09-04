/**
 * How the app names a bus line, including when it cannot.
 *
 * A badge shows a LineID — the number painted on the front of the bus. It is
 * reached by looking a route's LineCode up in the `webGetLines` catalogue, and
 * that lookup can miss: the two lists are published separately and do not
 * always agree. Measured against the live API on 2026-09-04, stop 240001 lists
 * routes for LineCodes 1298, 1299 and 1300 and the catalogue names none of
 * them. A stale catalogue on disk widens the same gap to any stop.
 *
 * The old fallback printed the LineCode in the badge. That is the worst
 * available answer: an internal code looks exactly like a line number, so the
 * rider reads 937 and goes looking for a 937 that does not exist. There is no
 * way to tell it apart from a real answer by looking at it.
 *
 * A missing name is shown as missing. `null` is the type of "the catalogue
 * could not name this", and these two functions are the only places that
 * decide what that looks like — on screen and to a screen reader.
 */

/** Badge text for a line the catalogue could not name. */
export const UNKNOWN_LINE_BADGE = '?';

/** What the badge prints. Never an internal code. */
export function lineBadge(lineId: string | null | undefined): string {
  // `||`, not `??`: a navigation param cannot carry null, so an unnamed line
  // crosses a route boundary as an empty string. Both mean "no name".
  return lineId || UNKNOWN_LINE_BADGE;
}

/**
 * How a screen reader says it. "Line ?" is not a sentence, so the unnamed case
 * gets words instead of the badge's punctuation.
 */
export function spokenLine(lineId: string | null | undefined): string {
  return lineId ? `Line ${lineId}` : 'Unnamed line';
}

/**
 * How a notification refers to the line it is watching.
 *
 * Not the badge's "?" — a push notification is a sentence, and "🚌 ? arriving!"
 * is not one. Named lines are untouched: "🚌 140 arriving!" reads exactly as it
 * always did.
 */
export function notifiedLine(lineId: string | null | undefined): string {
  return lineId ?? 'your bus';
}
