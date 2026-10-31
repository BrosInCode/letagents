export function booleanField(value: unknown, key: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Reflect.get(value, key) === true;
}

export type UnknownRecord = Record<string, unknown>;

export function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function validTurnControlActionId(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 256
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

export function nullableNonEmptyString(value: unknown): string | null | undefined {
  return value === null || (typeof value === "string" && value.trim().length > 0) ? value : undefined;
}

export function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : null;
}
