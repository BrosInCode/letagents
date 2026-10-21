import { Agent, createServer, request, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { duplexPair } from "node:stream";

import type { OwnerTokenAccount } from "../db/types/auth.js";
import { runOutsideSessionScope } from "../../mcp/server/runtime/session-scope.js";

/**
 * Runs API requests for remote MCP sessions inside this process.
 *
 * A remote tool call reaches the API the same way the npm package does, as an
 * HTTP request through the full Express app (auth middleware, route access
 * checks, events), so no route logic is copied. The request travels over an
 * in-memory stream pair handed to an HTTP server that never listens, so it
 * never touches the network, and it carries no token.
 *
 * Identity is bound here and only here: each stream pair is created for one
 * session's account, and the auth middleware asks `inProcessPrincipal` for the
 * account bound to the request's socket. Sockets come only from this module,
 * so no outside request can carry a bound principal.
 */
export interface InProcessPrincipal {
  readonly account: OwnerTokenAccount;
  readonly remoteMcpSessionId: string;
}

const principals = new WeakMap<object, InProcessPrincipal>();

/** The account bound to this request's in-process connection, if any. */
export function inProcessPrincipal(req: IncomingMessage): InProcessPrincipal | null {
  return principals.get(req.socket) ?? null;
}

const INTERNAL_HOST = "letagents.in-process";

export class InProcessDispatcher {
  private readonly server: Server;

  constructor(app: RequestListener) {
    this.server = createServer(app);
    // Long-polls are bounded by the routes themselves (LETAGENTS_POLL_MAX_MS).
    this.server.requestTimeout = 0;
    this.server.timeout = 0;
  }

  /** A fetch-like function bound to one session's account. */
  bind(principal: InProcessPrincipal): (path: string, init: RequestInit) => Promise<Response> {
    const frozen = Object.freeze({ ...principal });
    return (path, init) => this.dispatch(frozen, path, init);
  }

  private dispatch(principal: InProcessPrincipal, path: string, init: RequestInit): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      return Promise.reject(new Error("In-process API paths must be absolute paths on this API."));
    }
    const [clientSide, serverSide] = duplexPair();
    principals.set(serverSide, principal);
    // The API handles the request outside the session's scope: nothing the
    // route starts (timers, brokers) may capture one session's state.
    runOutsideSessionScope(() => this.server.emit("connection", serverSide));

    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      // The bound principal is the only identity; credentials never pass through.
      if (name === "authorization" || name === "cookie") return;
      headers[name] = value;
    });
    headers.host = INTERNAL_HOST;
    headers.connection = "close";
    const body = typeof init.body === "string" ? init.body : init.body == null ? undefined : null;
    if (body === null) return Promise.reject(new Error("In-process API bodies must be strings."));
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));

    return new Promise<Response>((resolve, reject) => {
      // One agent per request whose only connection is the in-memory stream.
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = (() => clientSide) as never;
      const req = request({ method: init.method ?? "GET", path, headers, agent }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          const status = res.statusCode ?? 500;
          const payload = status === 204 || status === 304 ? null : Buffer.concat(chunks);
          resolve(new Response(payload, { status, headers: responseHeaders }));
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      const signal = init.signal;
      if (signal) {
        if (signal.aborted) req.destroy(new Error("aborted"));
        else signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
      }
      req.end(body);
    }).finally(() => {
      clientSide.destroy();
      serverSide.destroy();
    });
  }
}
