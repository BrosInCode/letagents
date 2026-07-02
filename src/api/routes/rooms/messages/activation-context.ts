import { getActiveTaskLeases } from "../../../db.js";
import type { ResolvedRequestAgentIdentity } from "../../../request/agent-identity.js";
import type { AgentMessageActivationContext } from "../../../../shared/activation-routing.js";

export async function resolveMessageActivationContext(
  roomId: string,
  identity: ResolvedRequestAgentIdentity | null,
  options: { includeTaskOwnerLeases?: boolean } = {},
): Promise<AgentMessageActivationContext | undefined> {
  if (!identity || identity.session_kind !== "worker") {
    return undefined;
  }
  if (options.includeTaskOwnerLeases === false) {
    return undefined;
  }

  try {
    return { activeTaskLeases: await getActiveTaskLeases(roomId) };
  } catch (error) {
    console.error(`[message activation] failed to load active task leases for ${roomId}`, error);
    return undefined;
  }
}
