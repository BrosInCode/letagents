export function validateSessionId(input: { session_id?: string }): string | null {
  const sessionId = input.session_id;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return "session_id is required";
  }
  return null;
}

export function encodeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId.trim());
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}
