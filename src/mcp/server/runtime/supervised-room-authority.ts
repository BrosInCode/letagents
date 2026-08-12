import { AsyncLocalStorage } from "node:async_hooks";

const exactRoomAuthority = new AsyncLocalStorage<string>();

export function getCurrentSupervisedRoomAuthority(): string | null {
  return exactRoomAuthority.getStore() ?? null;
}

export function runWithSupervisedRoomAuthority<T>(roomId: string, callback: () => T): T {
  return exactRoomAuthority.run(roomId, callback);
}
