/** Repository label from a canonical project room ID; never a focus-room locator. */
export function repositoryRoomName(roomIdentifier) {
  const parts = roomIdentifier?.trim().split("/") ?? [];
  const host = parts[0]?.toLowerCase();
  if (!["github.com", "gitlab.com", "bitbucket.org"].includes(host)
    || parts.length < 3 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
    || (host !== "gitlab.com" && parts.length !== 3)) return null;
  return parts.at(-1) || null;
}
