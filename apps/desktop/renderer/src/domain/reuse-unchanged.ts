/**
 * Structural sharing for plain JSON-like data (objects, arrays, primitives).
 *
 * `reuseUnchanged(previous, next)` returns `next`'s data, but every subtree that
 * is deep-equal to the same place in `previous` keeps the PREVIOUS reference.
 * When everything is equal it returns `previous` itself. A periodic refetch
 * that returns the same data then changes no reference, so Vue computeds,
 * watchers and child props that compare by identity do not run again.
 *
 * Only plain data is supported: no Dates, Maps, class instances or cycles.
 * Non-plain objects are compared by identity only.
 */
export function reuseUnchanged<T>(previous: T, next: T): T {
  if (previous === next) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    return reuseArray(previous, next) as unknown as T;
  }
  if (isPlainObject(previous) && isPlainObject(next)) {
    return reuseObject(previous, next) as T;
  }
  // Primitives, null, undefined, mixed shapes, and non-plain objects.
  return next;
}

function reuseArray(previous: readonly unknown[], next: readonly unknown[]): unknown[] {
  let same = previous.length === next.length;
  const result = new Array<unknown>(next.length);
  for (let index = 0; index < next.length; index += 1) {
    const item = index < previous.length ? reuseUnchanged(previous[index], next[index]) : next[index];
    result[index] = item;
    if (same && item !== previous[index]) same = false;
  }
  return same ? (previous as unknown[]) : result;
}

function reuseObject(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const nextKeys = Object.keys(next);
  let same = nextKeys.length === Object.keys(previous).length;
  const result: Record<string, unknown> = {};
  for (const key of nextKeys) {
    const hasPrevious = Object.prototype.hasOwnProperty.call(previous, key);
    const value = hasPrevious ? reuseUnchanged(previous[key], next[key]) : next[key];
    result[key] = value;
    if (same && (!hasPrevious || value !== previous[key])) same = false;
  }
  return same ? previous : result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
