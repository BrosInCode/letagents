import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOCAL_BOARD_MAX_FRAME_BYTES = 16 * 1024 * 1024;

const ownership = new AsyncLocalStorage();
const listeners = new Set();
let processOwner = null;

/** The daemon registers once after acquiring its singleton; clients never do. */
export function registerLocalBoardOwner(assertCurrent) {
  processOwner = assertCurrent;
}

/** Only the background service enters this context, after its generation fence. */
export function runWithLocalBoardOwner(assertCurrent, callback) {
  assertCurrent();
  return ownership.run(assertCurrent, callback);
}

export function isLocalBoardOwner() {
  const assertCurrent = ownership.getStore() ?? processOwner;
  if (!assertCurrent) return false;
  assertCurrent();
  return true;
}

export function notifyLocalBoardChanged(roomId) {
  // A renderer disconnect must never turn a committed write into a failure.
  for (const listener of listeners) { try { listener(roomId); } catch { /* reconnect catches up */ } }
}

export function onLocalBoardChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** One request, no mutation retry. A disconnected reply is an unknown outcome. */
export function requestLocalBoard(method, params, { signal, socketPath, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(socketPath ?? process.env.LETAGENTS_BOARD_SOCKET_PATH ?? join(homedir(), ".letagents", "daemon.sock"));
    let settled = false;
    let buffer = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error("Board subscription closed."));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => finish(new Error("The board service did not respond.")));
    socket.once("error", () => finish(new Error("Open LetAgents to connect the board service.")));
    socket.once("close", () => finish(new Error("The board service disconnected.")));
    socket.once("connect", () => {
      const frame = JSON.stringify({ version: 3, id, method: `local_board.${method}`, params });
      if (Buffer.byteLength(frame) > LOCAL_BOARD_MAX_FRAME_BYTES - 1) { finish(new Error("This board change is too large.")); return; }
      socket.write(`${frame}\n`);
    });
    socket.on("data", chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > LOCAL_BOARD_MAX_FRAME_BYTES) { finish(new Error("The board response is too large.")); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== id || response.version !== 3) throw new Error("The board service response did not match this request.");
        if (!response.ok) throw new Error(response.error || "The board change failed.");
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
}
