/** Repository-backed room ids are `host/namespace/repo` locators. Kept free of imports so hot paths can use it. */
export function isRepoBackedRoomId(roomId: string): boolean {
  return /^[A-Za-z0-9.-]+\/[^/]+\/[^/]+$/.test(roomId);
}
