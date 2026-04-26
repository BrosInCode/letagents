import { buildAgentActorLabel, parseAgentActorLabel } from "../shared/agent-identity.js";
import {
  getAgentIdentityByCanonicalKey,
  getRoomAgentSessionByCredentials,
  touchRoomAgentSession,
} from "./db.js";
import type { AuthenticatedRequest } from "./http-helpers.js";
import type { RoomAgentSessionKind } from "../shared/agent-presence.js";

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export interface ResolvedRequestAgentIdentity {
  actor_label: string;
  agent_key: string;
  agent_instance_id: string | null;
  agent_session_id: string | null;
  session_kind: RoomAgentSessionKind;
  runtime: string;
  display_name: string;
  owner_label: string;
  ide_label: string;
}

export async function resolveRequestAgentIdentity(input: {
  req: AuthenticatedRequest;
  actor_label?: string | null;
  actor_key?: string | null;
  actor_instance_id?: string | null;
  agent_session_id?: string | null;
  agent_session_token?: string | null;
  room_id?: string | null;
}): Promise<ResolvedRequestAgentIdentity | null> {
  if (input.req.authKind !== "owner_token") {
    return null;
  }

  const sessionId = normalizeOptionalString(input.agent_session_id);
  const sessionToken = normalizeOptionalString(input.agent_session_token);
  if (sessionId && sessionToken) {
    const session = await getRoomAgentSessionByCredentials({
      session_id: sessionId,
      session_token: sessionToken,
      room_id: input.room_id,
      owner_account_id: input.req.sessionAccount?.account_id,
    });
    if (!session) {
      return null;
    }

    await touchRoomAgentSession(session.session_id);
    return {
      actor_label: session.actor_label,
      agent_key: session.agent_key,
      agent_instance_id: session.agent_instance_id,
      agent_session_id: session.session_id,
      session_kind: session.session_kind,
      runtime: session.runtime,
      display_name: session.display_name,
      owner_label: session.owner_label,
      ide_label: session.ide_label,
    };
  }

  const actorKey = normalizeOptionalString(input.actor_key);
  if (!actorKey) {
    return null;
  }

  const actorIdentity = await getAgentIdentityByCanonicalKey(actorKey);
  if (!actorIdentity || actorIdentity.owner_account_id !== input.req.sessionAccount?.account_id) {
    return null;
  }

  const parsedActorLabel = parseAgentActorLabel(input.actor_label);
  const ideLabel = parsedActorLabel?.ide_label ?? "Agent";

  return {
    actor_label: buildAgentActorLabel({
      display_name: actorIdentity.display_name,
      owner_label: actorIdentity.owner_label,
      ide_label: ideLabel,
    }),
    agent_key: actorIdentity.canonical_key,
    agent_instance_id: normalizeOptionalString(input.actor_instance_id),
    agent_session_id: null,
    session_kind: "controller",
    runtime: "unknown",
    display_name: actorIdentity.display_name,
    owner_label: actorIdentity.owner_label,
    ide_label: ideLabel,
  };
}

export type WorkerRequestAgentIdentityResult =
  | { ok: true; identity: ResolvedRequestAgentIdentity }
  | { ok: false; status: number; error: string };

export async function requireWorkerRequestAgentIdentity(input: {
  req: AuthenticatedRequest;
  body: Record<string, unknown>;
  room_id: string;
}): Promise<WorkerRequestAgentIdentityResult> {
  const sessionId = normalizeOptionalString(
    typeof input.body.agent_session_id === "string" ? input.body.agent_session_id : null
  );
  const sessionToken = normalizeOptionalString(
    typeof input.body.agent_session_token === "string" ? input.body.agent_session_token : null
  );
  if (!sessionId || !sessionToken) {
    return {
      ok: false,
      status: 403,
      error: "Registered worker session is required for agent write actions.",
    };
  }

  const identity = await resolveRequestAgentIdentity({
    req: input.req,
    agent_session_id: sessionId,
    agent_session_token: sessionToken,
    room_id: input.room_id,
  });
  if (!identity) {
    return {
      ok: false,
      status: 401,
      error: "Invalid agent session credentials.",
    };
  }
  if (identity.session_kind !== "worker") {
    return {
      ok: false,
      status: 403,
      error: "Worker session is required for agent write actions.",
    };
  }

  return { ok: true, identity };
}
