import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

import { DAEMON_PROTOCOL_VERSION, type DaemonRequest, type DaemonResponse } from "./types.js";
import { LOCAL_BOARD_MAX_FRAME_BYTES } from "../../../shared/local-board-owner.mjs";
import { acceptDaemonPeer, ensureDaemonProof, isWindowsPipePath } from "../../../shared/daemon-endpoint.mjs";
import { DaemonFenceLostError } from "./singleton.js";

/** Another process holds the daemon's pipe name: refuse to serve beside it. */
export class DaemonEndpointInUseError extends Error {}

export interface DaemonControlSocketOptions {
  /**
   * The client proof (see shared/daemon-endpoint.mjs). Required on a Windows
   * pipe, where it stands in for the socket file's 0600 mode; no proof is used
   * on POSIX unless a test sets one.
   */
  peerProofPath?: string | null;
  /**
   * How long a pipe name left by the previous daemon may stay busy after it
   * released the singleton. A pipe instance lives until its last handle closes,
   * a slow client's included, so this matches a desktop start's patience.
   */
  pipeReleaseWaitMs?: number;
}

export type RequestHandler = (request: DaemonRequest, disconnected: AbortSignal) => Promise<unknown> | unknown;

export class DaemonControlSocket {
  private server: Server | null = null;
  private readonly connections = new Set<Socket>();
  private readonly pipe: boolean;
  constructor(readonly path: string, private readonly handle: RequestHandler, private readonly onFatal?: (error: Error) => Promise<void> | void, private readonly maxFrameBytes = LOCAL_BOARD_MAX_FRAME_BYTES, private readonly options: DaemonControlSocketOptions = {}) {
    this.pipe = isWindowsPipePath(path);
  }

  async start(): Promise<void> {
    if (this.pipe) {
      await this.startPipe();
      return;
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    await unlink(this.path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    this.server = this.createServer(this.options.peerProofPath ? await ensureDaemonProof(this.options.peerProofPath) : null);
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.path, () => { this.server!.off("error", reject); resolve(); });
    });
    await chmod(this.path, 0o600);
  }

  /**
   * A pipe has no file to unlink or chmod. The caller holds the singleton, so a
   * busy name is either the previous daemon's last instance closing after a
   * handoff or someone else's pipe: wait briefly for the first, then fail
   * closed rather than serve beside an impostor.
   */
  private async startPipe(): Promise<void> {
    if (!this.options.peerProofPath) throw new Error("A daemon pipe needs a client proof; refusing to listen without one.");
    const proof = await ensureDaemonProof(this.options.peerProofPath);
    const deadline = Date.now() + (this.options.pipeReleaseWaitMs ?? 10_000);
    for (;;) {
      const server = this.createServer(proof);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(this.path, () => { server.off("error", reject); resolve(); });
        });
        this.server = server;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
        if (Date.now() >= deadline) throw new DaemonEndpointInUseError("Another process holds the supervisor daemon pipe; refusing to start beside it.");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  private createServer(proof: string | null): Server {
    return createServer((socket) => {
      this.connections.add(socket);
      socket.once("close", () => this.connections.delete(socket));
      // Requests deliberately outlive their provider socket. A provider may
      // disconnect while the daemon finishes and journals a long tool call;
      // EPIPE is transport loss, not a daemon-fatal execution error.
      socket.on("error", () => undefined);
      if (proof === null) this.serve(socket);
      else acceptDaemonPeer(socket, proof, (admitted) => this.serve(admitted));
    });
  }

  private serve(socket: Socket): void {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > this.maxFrameBytes) { socket.destroy(); return; }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) void this.respond(socket, line);
      });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (this.pipe) return;
    await unlink(this.path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }

  private async respond(socket: import("node:net").Socket, line: string): Promise<void> {
    let request: DaemonRequest | null = null;
    const disconnected = new AbortController();
    const close = () => disconnected.abort();
    socket.once("close", close);
    if (socket.destroyed) close();
    try {
      request = JSON.parse(line) as DaemonRequest;
      // Board imports carry existing task descriptions (up to 100,000 characters
      // each). Other control requests keep their original 64 KiB admission cap.
      if (request.method !== "local_board.mutate" && Buffer.byteLength(line) >= 64 * 1024) {
        throw new Error("Daemon request is too large.");
      }
      // Negotiation is intentionally version-agnostic: a vN+1 desktop must be
      // able to identify and hand off a healthy vN daemon without blind-killing
      // it or its provider children.
      if (request.version !== DAEMON_PROTOCOL_VERSION && request.method !== "daemon.negotiate") {
        throw new Error(`Protocol version mismatch: expected ${DAEMON_PROTOCOL_VERSION}, received ${request.version}.`);
      }
      // Only read subscriptions consume this signal. Mutations retain their
      // established lifetime and finish journaling after their caller leaves.
      const result = await this.handle(request, disconnected.signal);
      this.write(socket, { version: DAEMON_PROTOCOL_VERSION, id: request.id, ok: true, result });
    } catch (error) {
      if (error instanceof DaemonFenceLostError) {
        socket.destroy();
        await this.onFatal?.(error);
        return;
      }
      this.write(socket, { version: DAEMON_PROTOCOL_VERSION, id: request?.id, ok: false, error: error instanceof Error ? error.message : "Invalid daemon request." });
    } finally { socket.off("close", close); }
  }

  private write(socket: import("node:net").Socket, response: DaemonResponse): void {
    if (socket.destroyed || !socket.writable) return;
    try { socket.write(`${JSON.stringify(response)}\n`); } catch { /* provider disconnected */ }
  }
}
