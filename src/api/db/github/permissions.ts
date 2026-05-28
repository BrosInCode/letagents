export function serializeGitHubPermissions(
  permissions: Record<string, string> | null | undefined
): string | null {
  if (!permissions) {
    return null;
  }

  const entries = Object.entries(permissions).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return null;
  }

  return JSON.stringify(Object.fromEntries(entries));
}
