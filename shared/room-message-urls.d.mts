export const LETAGENTS_ROOM_ORIGIN: string;
export const MESSAGE_ID_PATTERN: RegExp;

export function isValidMessageId(messageId: unknown): messageId is string;
export function encodeRoomPathIdentifier(identifier: string): string;
export function decodeRoomPath(path: string): string;
export function isLocalRoomIdentifier(identifier: string | null | undefined): boolean;

export function buildLetAgentsMessageUrl(
  roomIdentifier: string,
  messageId: string,
  origin?: string,
): string;

export function parseLetAgentsMessageUrl(
  rawUrl: string,
  configuredOrigin?: string,
): { roomIdentifier: string; messageId: string | null } | null;

export function resolveSameRoomMessageReference(
  rawUrl: string | null | undefined,
  currentRoomIdentifier: string | null | undefined,
  configuredOrigin?: string,
): string | null;

