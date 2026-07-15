import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

import { DAEMON_PROTOCOL_VERSION, type DaemonRequest, type DaemonResponse } from "./types.js";
import { DaemonFenceLostError } from "./singleton.js";

export type RequestHandler = (request: DaemonRequest) => Promise<unknown> | unknown;

export class DaemonControlSocket {
  private server: Server | null = null;
  private readonly connections = new Set<Socket>();
  constructor(readonly path: string, private readonly handle: RequestHandler, private readonly onFatal?: (error: Error) => Promise<void> | void, private readonly maxFrameBytes = 64 * 1024) {}

  async start(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    await unlink(this.path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    this.server = createServer((socket) => {
      this.connections.add(socket);
      socket.once("close", () => this.connections.delete(socket));
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > this.maxFrameBytes) { socket.destroy(); return; }
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) void this.respond(socket, line);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.path, () => { this.server!.off("error", reject); resolve(); });
    });
    await chmod(this.path, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await unlink(this.path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }

  private async respond(socket: import("node:net").Socket, line: string): Promise<void> {
    let request: DaemonRequest | null = null;
    try {
      request = JSON.parse(line) as DaemonRequest;
      // Negotiation is intentionally version-agnostic: a vN+1 desktop must be
      // able to identify and hand off a healthy vN daemon without blind-killing
      // it or its provider children.
      if (request.version !== DAEMON_PROTOCOL_VERSION && request.method !== "daemon.negotiate") {
        throw new Error(`Protocol version mismatch: expected ${DAEMON_PROTOCOL_VERSION}, received ${request.version}.`);
      }
      const result = await this.handle(request);
      this.write(socket, { version: DAEMON_PROTOCOL_VERSION, id: request.id, ok: true, result });
    } catch (error) {
      if (error instanceof DaemonFenceLostError) {
        socket.destroy();
        await this.onFatal?.(error);
        return;
      }
      this.write(socket, { version: DAEMON_PROTOCOL_VERSION, id: request?.id, ok: false, error: error instanceof Error ? error.message : "Invalid daemon request." });
    }
  }

  private write(socket: import("node:net").Socket, response: DaemonResponse): void { socket.write(`${JSON.stringify(response)}\n`); }
}
