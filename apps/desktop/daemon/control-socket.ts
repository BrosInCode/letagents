import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";

import { DAEMON_PROTOCOL_VERSION, type DaemonRequest, type DaemonResponse } from "./types.js";

export type RequestHandler = (request: DaemonRequest) => Promise<unknown> | unknown;

export class DaemonControlSocket {
  private server: Server | null = null;
  constructor(readonly path: string, private readonly handle: RequestHandler) {}

  async start(): Promise<void> {
    await unlink(this.path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    this.server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) void this.respond(socket, line);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.path, () => { this.server!.off("error", reject); resolve(); });
    });
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
    this.server = null;
    await unlink(this.path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }

  private async respond(socket: import("node:net").Socket, line: string): Promise<void> {
    let request: DaemonRequest | null = null;
    try {
      request = JSON.parse(line) as DaemonRequest;
      if (request.version !== DAEMON_PROTOCOL_VERSION) throw new Error(`Protocol version mismatch: expected ${DAEMON_PROTOCOL_VERSION}, received ${request.version}.`);
      const result = await this.handle(request);
      this.write(socket, { version: DAEMON_PROTOCOL_VERSION, id: request.id, ok: true, result });
    } catch (error) {
      this.write(socket, { version: DAEMON_PROTOCOL_VERSION, id: request?.id, ok: false, error: error instanceof Error ? error.message : "Invalid daemon request." });
    }
  }

  private write(socket: import("node:net").Socket, response: DaemonResponse): void { socket.write(`${JSON.stringify(response)}\n`); }
}
