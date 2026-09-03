import type { Response } from "express";

import type { SupervisorHostGrant } from "../db.js";

type ExecutionDelegationResourceScope = {
  room_id: string;
  agent_key: string;
};

export function requireExecutionDelegationHostAuthority(input: {
  grant: SupervisorHostGrant;
  requested_grant_id: string;
  resource?: ExecutionDelegationResourceScope;
  conceal(): void;
  res: Response;
}): boolean {
  const { grant, requested_grant_id: requestedGrantId, resource, conceal, res } = input;
  if (grant.scope_key !== "owner" || grant.rental_session_id) {
    conceal();
    return false;
  }
  if (grant.grant_id !== requestedGrantId) {
    res.status(403).json({ error: "Supervisor grant does not match the requested grant." });
    return false;
  }
  if (resource && (!grant.allowed_room_ids.includes(resource.room_id)
    || !grant.allowed_agent_keys.includes(resource.agent_key))) {
    conceal();
    return false;
  }
  return true;
}
