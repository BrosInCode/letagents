import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import { pool } from "../db/client.js";

const changes = new EventEmitter();
changes.setMaxListeners(0);
let connection: PoolClient | null = null;
let connecting: Promise<void> | null = null;
let stopped = false;
let disconnect: (() => Promise<void>) | null = null;
async function listen() {
  if (stopped) throw new Error("Message updates are shutting down.");
  if (connection) return;
  if (connecting) return connecting;
  connecting = (async () => {
    const client = await pool.connect();
    let released = false;
    const release = (destroy = false) => {
      if (released) return;
      released = true;
      client.removeListener("error", failed);
      if (connection === client) {
        connection = null;
        disconnect = null;
      }
      client.release(destroy);
    };
    const failed = () => {
      release(true);
      changes.emit("change", null);
    };
    client.once("error", failed);
    client.on("notification", (event) => {
      if (event.channel !== "conversation_changed") return;
      try {
        changes.emit("change", JSON.parse(event.payload || "[]"));
      } catch {
        /* malformed notification contains no content */
      }
    });
    try {
      await client.query("LISTEN conversation_changed");
      connection = client;
      disconnect = async () => {
        try {
          await client.query("UNLISTEN conversation_changed");
        } finally {
          release();
        }
      };
    } catch (error) {
      release(true);
      throw error;
    }
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}
export async function conversationVersion(accountId: string): Promise<string> {
  const result = await pool.query(
    "SELECT version::text FROM conversation_versions WHERE account_id=$1",
    [accountId],
  );
  return result.rows[0]?.version ?? "0";
}
export async function waitConversationChanges(
  accountId: string,
  after: string,
  signal: AbortSignal,
): Promise<void> {
  await listen();
  let wake!: () => void;
  const changed = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const handler = (ids: string[] | null) => {
    if (!ids || ids.includes(accountId)) wake();
  };
  changes.on("change", handler);
  signal.addEventListener("abort", wake, { once: true });
  const timer = setTimeout(wake, 25000);
  try {
    // Subscribe before checking the durable cursor, so a commit cannot be lost.
    if (!signal.aborted && (await conversationVersion(accountId)) === after)
      await changed;
  } finally {
    clearTimeout(timer);
    changes.off("change", handler);
    signal.removeEventListener("abort", wake);
  }
}
export async function closeConversationChanges() {
  stopped = true;
  changes.emit("change", null);
  await connecting;
  await disconnect?.();
  changes.emit("change", null);
}
