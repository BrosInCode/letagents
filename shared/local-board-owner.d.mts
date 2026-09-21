export const LOCAL_BOARD_MAX_FRAME_BYTES: number;
export function runWithLocalBoardOwner<T>(assertCurrent: () => void, callback: () => T): T;
export function registerLocalBoardOwner(assertCurrent: () => void): void;
export function isLocalBoardOwner(): boolean;
export function notifyLocalBoardChanged(roomId: string): void;
export function onLocalBoardChanged(listener: (roomId: string) => void): () => void;
export function requestLocalBoard<T = unknown>(method: "mutate" | "watch", params: unknown, options?: {
  signal?: AbortSignal; socketPath?: string; timeoutMs?: number;
}): Promise<T>;
