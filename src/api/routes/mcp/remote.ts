import type { Express, Response } from "express";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { AuthenticatedRequest } from "../../http/helpers.js";
import { parseBearerAuthorization } from "../../request/bearer-authorization.js";
import {
  RemoteMcpCapacityError,
  RemoteMcpSessionManager,
} from "../../remote-mcp/sessions.js";
import { buildInMemoryListingsRateLimiter } from "../rental/renter/rate-limiter.js";

/**
 * Remote (streamable HTTP) MCP endpoint. Mounted at `/mcp`, next to the other
 * root-level API routes (`/rooms`, `/auth`, `/agents`), because MCP clients
 * take the endpoint URL as given and `https://letagents.chat/mcp` is the
 * conventional shape for a hosted MCP server.
 */
export const REMOTE_MCP_PATH = "/mcp";

export interface RemoteMcpRouteDeps {
  sessions?: RemoteMcpSessionManager;
  /** Base URL the per-connection MCP child uses to call this API. */
  apiUrlForRequest?: (req: AuthenticatedRequest) => string;
  /** Per-account request budget; true allows the request. */
  allowRequest?: (accountId: string) => boolean;
  /** Per-account budget for opening new sessions. */
  allowSessionCreate?: (accountId: string) => boolean;
}

function jsonRpcError(res: Response, status: number, message: string, headers: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

/**
 * The child calls back into this same server on the address the request
 * arrived on, so it works whatever HOST/PORT the process listens on.
 * LETAGENTS_REMOTE_MCP_API_URL overrides it.
 */
export function defaultRemoteMcpApiUrl(req: AuthenticatedRequest): string {
  const configured = process.env.LETAGENTS_REMOTE_MCP_API_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const raw = req.socket.localAddress ?? "127.0.0.1";
  const address = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  const host = address === "::" || address === "0.0.0.0" ? "127.0.0.1"
    : address.includes(":") ? `[${address}]` : address;
  return `http://${host}:${req.socket.localPort}`;
}

export function registerRemoteMcpRoutes(app: Express, deps: RemoteMcpRouteDeps = {}): RemoteMcpSessionManager {
  const sessions = deps.sessions ?? new RemoteMcpSessionManager();
  const apiUrlForRequest = deps.apiUrlForRequest ?? defaultRemoteMcpApiUrl;
  const allowRequest = deps.allowRequest ?? buildInMemoryListingsRateLimiter({ capacity: 600, windowMs: 60_000 });
  const allowSessionCreate = deps.allowSessionCreate
    ?? buildInMemoryListingsRateLimiter({ capacity: 10, windowMs: 60_000 });

  const handler = async (req: AuthenticatedRequest, res: Response) => {
    // Only an owner token sent as a bearer (LETAGENTS_TOKEN) opens this
    // endpoint. Browser cookies, app sessions, worker bearers and host grants
    // do not. Invalid bearers were already refused by the auth middleware.
    const authorization = parseBearerAuthorization(req.headers.authorization);
    if (authorization.kind !== "token" || req.authKind !== "owner_token" || !req.sessionAccount) {
      jsonRpcError(res, 401, "A LetAgents owner token is required as 'Authorization: Bearer <LETAGENTS_TOKEN>'.",
        { "WWW-Authenticate": 'Bearer realm="letagents"' });
      return;
    }
    const accountId = req.sessionAccount.account_id;
    if (!allowRequest(accountId)) {
      jsonRpcError(res, 429, "Too many remote MCP requests. Slow down.");
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string" && sessionId) {
      const session = sessions.find(sessionId, authorization.token);
      if (!session) {
        // Unknown, expired, or opened with another token: the client re-initializes.
        jsonRpcError(res, 404, "Session not found.");
        return;
      }
      await sessions.handle(session, req, res, req.body);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(req.body)) {
      jsonRpcError(res, 400, "Send an initialize request first, without an Mcp-Session-Id header.");
      return;
    }
    if (!allowSessionCreate(accountId)) {
      jsonRpcError(res, 429, "Too many new remote MCP sessions. Slow down.");
      return;
    }
    let session;
    try {
      session = await sessions.create({ accountId, token: authorization.token, apiUrl: apiUrlForRequest(req) });
    } catch (error) {
      if (error instanceof RemoteMcpCapacityError) {
        jsonRpcError(res, error.status, error.message);
        return;
      }
      console.error("Remote MCP session start failed:", error instanceof Error ? error.name : "unknown");
      jsonRpcError(res, 500, "The remote MCP session could not start.");
      return;
    }
    await sessions.handle(session, req, res, req.body);
  };

  app.post(REMOTE_MCP_PATH, handler);
  app.get(REMOTE_MCP_PATH, handler);
  app.delete(REMOTE_MCP_PATH, handler);
  return sessions;
}
