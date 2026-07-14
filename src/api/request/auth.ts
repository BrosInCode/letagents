import type { Request } from "express";

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
  const cookies = parseCookies(req.headers.cookie);
  const sessionToken = cookies.letagents_session;
  if (sessionToken) {
    const sessionAccount = await getSessionAccountByToken(sessionToken);
    if (sessionAccount) {
      return {
        account: sessionAccount,
        authKind: "session",
      };
    }
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return {
      account: null,
      authKind: null,
    };
  }

  const providerToken = authHeader.slice("Bearer ".length).trim();
  if (!providerToken) {
    return {
      account: null,
      authKind: null,
    };
  }

  const ownerTokenAccount = await getOwnerTokenAccountByToken(providerToken);
  if (ownerTokenAccount) {
    return {
      account: ownerTokenAccount,
      authKind: "owner_token",
    };
  }

  const supervisorGrant = await getSupervisorHostGrantByToken(providerToken);
  if (supervisorGrant) {
    return { account: null, authKind: "supervisor_grant", supervisorGrant };
  }

  if (isAgentSessionBearerFeatureEnabled()) {
    const workerBearer = await getRoomAgentSessionBearerByToken(providerToken);
    if (workerBearer) {
      const { bearer, session } = workerBearer;
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
          agent_instance_id: session.agent_instance_id,
          session_kind: "worker",
          runtime: session.runtime,
          display_name: session.display_name,
          owner_label: session.owner_label,
          ide_label: session.ide_label,
          repo_branch: session.repo_branch ?? null,
          expires_at: bearer.expires_at,
        },
      };
    }
  }

  return {
    account: null,
    authKind: null,
  };
}
