/**
 * Every value OASA sends is text to this app, whatever JSON type it arrives as.
 *
 * The API used to send everything as a string — `"LineCode":"1173"` — and every
 * type in `types/index.ts` says so. Some time before November 2026 it started
 * sending the same values as JSON numbers, `"LineCode":1173`, with the values
 * themselves unchanged. Nothing threw. What broke was equality: a saved stop's
 * `visibleLines` held `"1173"`, the routes now said `1173`, `Set.has` said no,
 * and every stop saved before the switch showed "No lines shown". A stop saved
 * after it stored numbers and worked, which is why re-saving looked like a fix.
 *
 * So the type is enforced where data enters the app, not at each comparison:
 * `api()` passes every response through `codesAsText`, and so does every disk
 * read of OASA data or of anything that holds its codes, because what was saved
 * while the API sent numbers holds numbers. Converting everything rather than a
 * list of known fields is deliberate — the API changed type without notice
 * once, and a list is what it would change next.
 *
 * No imports, so `tests/oasa-codes.test.mjs` can load it under node's type
 * stripping.
 */
export function codesAsText<T>(value: T): T {
  if (typeof value === 'number') return String(value) as T;
  if (Array.isArray(value)) return value.map(codesAsText) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = codesAsText(v);
    return out as T;
  }
  return value;
}

/** One stored code — a string, or a number saved while the API sent numbers. */
export function codeAsText(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}
