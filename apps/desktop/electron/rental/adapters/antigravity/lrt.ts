export function estimateLrtRemainingForWindow(
  percentRemaining: number | null,
  lrtPerFullWindow: number | null,
): number | null {
  if (lrtPerFullWindow === null || lrtPerFullWindow <= 0) return null;
  if (
    typeof percentRemaining !== "number"
    || !Number.isFinite(percentRemaining)
  ) return null;
  const clamped = Math.min(1, Math.max(0, percentRemaining));
  return lrtPerFullWindow * clamped;
}
