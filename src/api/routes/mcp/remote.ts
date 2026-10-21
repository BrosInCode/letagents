import type { Express, Response } from "express";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { AuthenticatedRequest } from "../../http/helpers.js";
import { parseBearerAuthorization } from "../../request/bearer-authorization.js";
import { buildAllowedOrigins, INVALID_BEARER_MESSAGE } from "../../http/middleware.js";
import { inProcessPrincipal } from "../../remote-mcp/in-process-dispatch.js";
import type { RemoteMcpSessions } from "../../remote-mcp/sessions.js";
import type { OwnerTokenAccount } from "../../db/types/auth.js";
import { buildInMemoryListingsRateLimiter } from "../rental/renter/rate-limiter.js";

/**
 * Remote (streamable HTTP) MCP endpoint. Mounted at `/mcp`, next to the other
 * root-level API routes (`/rooms`, `/auth`, `/agents`), because MCP clients
 * take the endpoint URL as given and `https://letagents.chat/mcp` is the
 * conventional shape for a hosted MCP server.
 */
export const REMOTE_MCP_PATH = "/mcp";

/**
 * Request bodies above this are refused before the MCP SDK validates them.
 * The API's global JSON parser allows 1 MB; MCP tool calls need far less, and
 * SDK validation cost grows with the number of array elements and object keys
 * (GHSA-46jr-4wx8-v453).
 */
export function remoteMcpMaxBodyBytes(): number {
  const value = Number.parseInt(process.env.LETAGENTS_REMOTE_MCP_MAX_BODY_BYTES ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 256 * 1024;
}

export interface RemoteMcpRouteDeps {
  sessions: RemoteMcpSessions;
  /** Per-account request budget; true allows the request. */
  allowRequest?: (accountId: string) => boolean;
  /** Per-account budget for opening new sessions. */
  allowSessionCreate?: (accountId: string) => boolean;
}

function jsonRpcError(res: Response, status: number, message: string, headers: Record<string, string> = {}): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

function clientNameOf(body: unknown): string | null {
  const name = (body as { params?: { clientInfo?: { name?: unknown } } })?.params?.clientInfo?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

export function registerRemoteMcpRoutes(app: Express, deps: RemoteMcpRouteDeps): void {
  const { sessions } = deps;
  const allowRequest = deps.allowRequest ?? buildInMemoryListingsRateLimiter({ capacity: 600, windowMs: 60_000 });
  const allowSessionCreate = deps.allowSessionCreate
    ?? buildInMemoryListingsRateLimiter({ capacity: 10, windowMs: 60_000 });
  const allowedOrigins = buildAllowedOrigins();

  const handler = async (req: AuthenticatedRequest, res: Response) => {
    // A remote session's own in-process calls never re-enter the endpoint.
    if (inProcessPrincipal(req)) {
      jsonRpcError(res, 403, "The MCP endpoint is not available to in-process calls.");
      return;
    }
    // The MCP transport spec requires Origin validation (DNS rebinding). Server
    // clients such as Claude's connector send no Origin; browsers always do.
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      jsonRpcError(res, 403, "This Origin may not use the MCP endpoint.");
      return;
    }
    // Only an owner token sent as a bearer (LETAGENTS_TOKEN) opens this
    // endpoint. Browser cookies, app sessions, worker bearers and host grants
    // do not. Invalid bearers were already refused by the auth middleware.
    const authorization = parseBearerAuthorization(req.headers.authorization);
    if (authorization.kind === "token" && (req.authKind !== "owner_token" || !req.sessionAccount)) {
      // Same status, headers and body as the middleware's invalid-bearer reply,
      // so a valid credential of another kind cannot be told from a bad one.
      res.status(401).json({ error: INVALID_BEARER_MESSAGE });
      return;
    }
    if (authorization.kind !== "token" || !req.sessionAccount) {
      jsonRpcError(res, 401, "A LetAgents owner token is required as 'Authorization: Bearer <LETAGENTS_TOKEN>'.",
        { "WWW-Authenticate": 'Bearer realm="letagents"' });
      return;
    }
    const account = req.sessionAccount as OwnerTokenAccount;
    const accountId = account.account_id;
    if (!allowRequest(accountId)) {
      jsonRpcError(res, 429, "Too many remote MCP requests. Slow down.");
      return;
    }
    const declaredLength = Number.parseInt(req.headers["content-length"] ?? "0", 10) || 0;
    const parsedLength = req.body === undefined ? 0 : Buffer.byteLength(JSON.stringify(req.body));
    if (Math.max(declaredLength, parsedLength) > remoteMcpMaxBodyBytes()) {
      jsonRpcError(res, 413, "The MCP request body is too large.");
      return;
    }
    const token = authorization.token;

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string" && sessionId) {
      const session = await sessions.find(sessionId, token, accountId);
      if (!session) {
        // Unknown, expired, or opened with another token: the client re-initializes.
        jsonRpcError(res, 404, "Session not found.");
        return;
      }
      if (req.method === "DELETE") {
        await sessions.delete(session.sessionId);
        res.status(200).end();
        return;
      }
      if (req.method === "GET") {
        // No server-initiated stream: every reply travels on its POST.
        res.setHeader("Allow", "POST, DELETE");
        jsonRpcError(res, 405, "This server does not offer a notification stream.");
        return;
      }
      await sessions.handle(session, account, req, res, req.body);
      return;
    }

    if (req.method !== "POST" || !isInitializeRequest(req.body)) {
      jsonRpcError(res, 400, "Send an initialize request first, without an Mcp-Session-Id header.");
      return;
    }
    // The transport would refuse these with 406; refuse them before a session is stored.
    const accept = String(req.headers.accept ?? "");
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      jsonRpcError(res, 406, "Accept must include application/json and text/event-stream.");
      return;
    }
    if (!allowSessionCreate(accountId)) {
      jsonRpcError(res, 429, "Too many new remote MCP sessions. Slow down.");
      return;
    }
    const opened = await sessions.open({ accountId, token, clientName: clientNameOf(req.body) });
    const session = await sessions.find(opened, token, accountId);
    if (!session) {
      jsonRpcError(res, 500, "The remote MCP session could not start.");
      return;
    }
    await sessions.handle(session, account, req, res, req.body);
  };

  app.post(REMOTE_MCP_PATH, handler);
  app.get(REMOTE_MCP_PATH, handler);
  app.delete(REMOTE_MCP_PATH, handler);
}
