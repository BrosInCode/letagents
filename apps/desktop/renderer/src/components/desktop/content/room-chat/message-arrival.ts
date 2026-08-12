export function getAppendedMessageIds(
  previousIds: readonly string[],
  nextIds: readonly string[],
): string[] {
  if (previousIds.length === 0 || nextIds.length <= previousIds.length) return [];

  const previousLastId = previousIds[previousIds.length - 1];
  const previousLastIndex = nextIds.indexOf(previousLastId);
  if (previousLastIndex < 0) return [];

  const previousIdSet = new Set(previousIds);
  return nextIds
    .slice(previousLastIndex + 1)
    .filter((id) => !previousIdSet.has(id));
}
