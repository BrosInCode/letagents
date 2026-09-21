export function withStateFileLock<T>(statePath: string, callback: (statePath: string) => T): T;
export function withRegisteredWorkerStateFence<T>(statePath: string, supplied: unknown, callback: (session: Record<string, unknown>) => T): T;
