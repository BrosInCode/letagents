import type { Express, Response } from "express";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { AuthenticatedRequest } from "../../http/helpers.js";
import { parseBearerAuthorization } from "../../request/bearer-authorization.js";
import { buildAllowedOrigins, replyInvalidBearer } from "../../http/middleware.js";
import { inProcessPrincipal } from "../../remote-mcp/in-process-dispatch.js";
import type { RemoteMcpSessions } from "../../remote-mcp/sessions.js";
import { RemoteMcpBusyError } from "../../remote-mcp/errors.js";
import type { OwnerTokenAccount } from "../../db/types/auth.js";
import { buildInMemoryListingsRateLimiter } from "../rental/renter/rate-limiter.js";
import { mcpBearerChallenge, REMOTE_MCP_PATH } from "../../mcp-oauth/config.js";

/**
 * Remote (streamable HTTP) MCP endpoint. Mounted at `/mcp`, next to the other
 * root-level API routes (`/rooms`, `/auth`, `/agents`), because MCP clients
 * take the endpoint URL as given and `https://letagents.chat/mcp` is the
 * conventional shape for a hosted MCP server.
 */
export { REMOTE_MCP_PATH };

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
  // ChatGPT's connector may open a session per tool call, so the budget allows
  // a busy agent turn; the per-account session cap bounds the rows.
  // LETAGENTS_REMOTE_MCP_SESSIONS_PER_MINUTE, default 30.
  const sessionsPerMinute = Number.parseInt(process.env.LETAGENTS_REMOTE_MCP_SESSIONS_PER_MINUTE ?? "", 10);
  const allowSessionCreate = deps.allowSessionCreate
    ?? buildInMemoryListingsRateLimiter({ capacity: Number.isFinite(sessionsPerMinute) && sessionsPerMinute > 0 ? sessionsPerMinute : 30, windowMs: 60_000 });
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
    // Only an owner token (LETAGENTS_TOKEN) or an OAuth access token issued
    // for this resource, sent as a bearer, opens this endpoint. Browser
    // cookies, app sessions, worker bearers and host grants do not. Invalid
    // bearers were already refused by the auth middleware.
    const authorization = parseBearerAuthorization(req.headers.authorization);
    const oauthGrant = req.authKind === "mcp_oauth" ? req.mcpOAuth ?? null : null;
    if (authorization.kind === "token" && ((req.authKind !== "owner_token" && !oauthGrant) || !req.sessionAccount)) {
      // Same status, headers and body as the middleware's invalid-bearer reply,
      // so a valid credential of another kind cannot be told from a bad one.
      replyInvalidBearer(req, res);
      return;
    }
    if (authorization.kind !== "token" || !req.sessionAccount) {
      // MCP authorization: the challenge names the protected resource metadata,
      // which leads an OAuth client to LetAgents sign-in.
      jsonRpcError(res, 401, "Sign in to LetAgents (OAuth), or send 'Authorization: Bearer <LETAGENTS_TOKEN>'.",
        { "WWW-Authenticate": mcpBearerChallenge() });
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
    // What the session binds to: the owner token itself, or the OAuth grant's
    // secret, which stays the same when the client refreshes its access token.
    const token = oauthGrant ? oauthGrant.session_secret : authorization.token;
    const serve = async (session: Parameters<RemoteMcpSessions["handle"]>[0]) => {
      try {
        await sessions.handle(session, account, req, res, req.body);
      } catch (error) {
        if (!(error instanceof RemoteMcpBusyError) || res.headersSent) throw error;
        jsonRpcError(res, error.status, error.message);
      }
    };

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string" && sessionId) {
      // A stateful client: the session it opened, or 404 so it initializes again.
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
      await serve(session);
      return;
    }

    if (req.method !== "POST") {
      jsonRpcError(res, 400, "Send an initialize request first, without an Mcp-Session-Id header.");
      return;
    }
    // Without a session id the body decides between initialize and a stateless
    // call, so it must be one message (batches left the protocol in 2025-06-18).
    if (Array.isArray(req.body)) {
      jsonRpcError(res, 400, "Send one JSON-RPC message per request; batches are not supported here.");
      return;
    }
    // The transport would refuse these with 406; refuse them before a session is stored.
    const accept = String(req.headers.accept ?? "");
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      jsonRpcError(res, 406, "Accept must include application/json and text/event-stream.");
      return;
    }
    const initialize = isInitializeRequest(req.body);
    if (!initialize) {
      // A stateless client (ChatGPT's connector sends every call without a
      // session id): served in the credential's implicit session, which
      // starts from the credential's saved state like any other session.
      const implicit = await sessions.findImplicit({ accountId, token });
      if (implicit) {
        await serve(implicit);
        return;
      }
    }
    if (!allowSessionCreate(accountId)) {
      jsonRpcError(res, 429, "Too many new remote MCP sessions. Slow down.");
      return;
    }
    const opened = await sessions.open({ accountId, token, clientName: initialize ? clientNameOf(req.body) : null, implicit: !initialize });
    // An implicit session that another request created first is found and refreshed like any other.
    const session = initialize ? await sessions.find(opened, token, accountId) : await sessions.findImplicit({ accountId, token });
    if (!session) {
      jsonRpcError(res, 500, "The remote MCP session could not start.");
      return;
    }
    await serve(session);
  };

  app.post(REMOTE_MCP_PATH, handler);
  app.get(REMOTE_MCP_PATH, handler);
  app.delete(REMOTE_MCP_PATH, handler);
}
