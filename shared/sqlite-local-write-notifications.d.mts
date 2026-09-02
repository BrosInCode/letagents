export type SqliteLocalWriteNotificationDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
};

export function ensureLocalChatWriteNotificationSchema(
  database: SqliteLocalWriteNotificationDatabase,
): void;

export function getLocalChatRoomWriteSequence(
  database: SqliteLocalWriteNotificationDatabase,
  roomId: string,
): number;
