// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function readNumber(
  source: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export function readBool(
  source: Record<string, unknown>,
  fallback: boolean,
  ...keys: string[]
): boolean {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") return value;
  }
  return fallback;
}

export function readStringArray(
  source: Record<string, unknown>,
  ...keys: string[]
): string[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === "string");
    }
  }
  return [];
}

export function readJsonObject(
  source: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | null {
  for (const key of keys) {
    const value = source[key];
    if (isObject(value)) return value;
  }
  return null;
}

export function isoOrNull(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

export function nonNullIso(value: unknown, fallback: string): string {
  return isoOrNull(value) ?? fallback;
}

export function coerceFromList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

export function coerceFromListOrNull<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return null;
}
