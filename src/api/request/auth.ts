import type { Request } from "express";
import { parseBearerAuthorization } from "./bearer-authorization.js";

import { inProcessPrincipal } from "../remote-mcp/in-process-dispatch.js";
import { getOwnerTokenAccountByTokenHash } from "../db/auth/owner-tokens.js";
import {
  getOwnerTokenAccountByToken,
  getRoomAgentSessionBearerByToken,
  getSessionAccountByToken,
  getSupervisorHostGrantByToken,
} from "../db.js";
import {
  parseCookies,
  type ResolvedRequestAuth,
} from "../http/helpers.js";
import { isAgentSessionBearerCapability, isAgentSessionBearerFeatureEnabled } from "../../shared/agent-session-bearer.js";

export async function resolveRequestAuth(req: Request): Promise<ResolvedRequestAuth> {
  // A remote MCP session's in-process call: re-resolve the bound owner token
  // from its hash, so a fresh check (live rechecks, revocation) sees the
  // session's current account, or nothing once the token is revoked.
  const internal = inProcessPrincipal(req);
  if (internal) {
    const account = await getOwnerTokenAccountByTokenHash(internal.tokenHash);
    return account && account.account_id === internal.account.account_id
      ? { account, authKind: "owner_token" }
      : { account: null, authKind: null };
  }
  const cookies = parseCookies(req.headers?.cookie);
  const sessionToken = cookies.letagents_session;
  let cookieSessionAccount = null;
  if (sessionToken) {
    cookieSessionAccount = await getSessionAccountByToken(sessionToken);
  }

  const authorization = parseBearerAuthorization(req.headers?.authorization);
  if (authorization.kind === "none") {
    return {
      account: cookieSessionAccount,
      authKind: cookieSessionAccount ? "session" : null,
    };
  }

  if (authorization.kind === "invalid") return { account: null, authKind: null };
  const providerToken = authorization.token;

  const ownerTokenAccount = await getOwnerTokenAccountByToken(providerToken);
  if (ownerTokenAccount) {
    return {
      account: ownerTokenAccount,
      authKind: "owner_token",
    };
  }

  const appSession = await getSessionAccountByToken(providerToken);
  if (appSession) {
    if (cookieSessionAccount && cookieSessionAccount.id !== appSession.id) {
      return { account: null, authKind: null };
    }
    return { account: appSession, authKind: "session" };
  }

  const supervisorGrant = await getSupervisorHostGrantByToken(providerToken);
  if (supervisorGrant) {
    // A browser/session credential and a host credential in one request is a
    // confused-deputy envelope. Do not silently choose either principal.
    if (cookieSessionAccount) return { account: null, authKind: null };
    return { account: null, authKind: "supervisor_grant", supervisorGrant };
  }

  if (isAgentSessionBearerFeatureEnabled()) {
    const workerBearer = await getRoomAgentSessionBearerByToken(providerToken);
    if (workerBearer) {
      const { bearer, session } = workerBearer;
      // Loaded here, not at the top: the ask store pulls in room messaging, which imports this module.
      const waitingForAsker = session.supervisor_grant_id
        ? await import("../agent-asks/store.js").then(asks => asks.isGrantWaitingForAsker(session.supervisor_grant_id!))
        : false;
      return {
        account: null,
        authKind: "agent_session",
        agentSession: {
          bearer_id: bearer.bearer_id,
          bearer_generation: bearer.generation,
          capabilities: bearer.capabilities.filter(isAgentSessionBearerCapability),
          room_id: session.room_id,
          agent_session_id: session.session_id,
          actor_label: session.actor_label,
          agent_key: session.agent_key,
          owner_account_id: session.owner_account_id,
          agent_instance_id: session.agent_instance_id,
          session_kind: "worker",
          runtime: session.runtime,
          display_name: session.display_name,
          owner_label: session.owner_label,
          ide_label: session.ide_label,
          repo_branch: session.repo_branch ?? null,
          expires_at: bearer.expires_at,
          waiting_for_asker: waitingForAsker,
        },
      };
    }
  }

  return {
    account: null,
    authKind: null,
  };
}
