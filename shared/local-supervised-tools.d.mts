export function localSupervisedRoomToolOperation(name: string): string | null;
export function localSupervisedRoomToolAvailable(name: string): boolean;
export function defineLocalSupervisedToolHandlers<T>(handlers: Record<string, (context: T) => Promise<unknown>>): Readonly<Record<string, (context: T) => Promise<unknown>>>;
