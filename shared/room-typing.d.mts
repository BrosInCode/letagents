export const ROOM_TYPING: 'room_typing_v1';
export const TYPING: Readonly<{ ttl: number; interval: number; sweep: number; sources: number; people: number; entries: number; name: number }>;
export interface TypingReport { client_id: string; sequence: number; typing: boolean; ttl_ms: number }
export interface TypingSignal extends TypingReport { room_id: string; account_id: string; name: string; expires_at: number }
export function parseTypingReport(value: unknown): TypingReport | null;
export function parseTypingSignal(value: unknown): TypingSignal | null;
export function createTypingSender(options: {
  send: (report: TypingReport) => unknown; clientId: string; now?: () => number;
  schedule?: (callback: () => void, ms: number) => any; cancel?: (timer: any) => void;
}): { input(nonempty: boolean): void; stop(): void };
export function createTypingReceiver(now?: () => number): {
  receive(raw: unknown, self: string | null): void; clear(): void; label(): string; nextExpiry(): number | null;
};
export function createTypingDisplay(update: (label: string) => void, clock?: {
  now?: () => number; schedule?: (callback: () => void, ms: number) => any; cancel?: (timer: any) => void;
}): { receive(raw: unknown, self: string | null): void; clear(): void };
