import {
  buildCompactRoomAgentPrompt,
  buildRoomAgentPrompt,
  type AgentPromptKind,
} from "../shared/room-agent-prompts.js";
import { currentSessionScope } from "./server/runtime/session-scope.js";

// The MCP server process serves a single agent client, so "delivered once per
// process" is equivalent to "delivered once per agent session". After the full
// room-agent instructions have gone out once, every later expansion uses the
// compact form so long-polling loops stop re-paying the full boilerplate.
// A remote session keeps the flag in its own saved state.
let processFullPromptDelivered = false;

function fullPromptDelivered(): boolean {
  const scope = currentSessionScope();
  return scope ? scope.state.fullPromptDelivered : processFullPromptDelivered;
}

function markFullPromptDelivered(): void {
  const scope = currentSessionScope();
  if (!scope) {
    processFullPromptDelivered = true;
    return;
  }
  if (!scope.state.fullPromptDelivered) {
    scope.state.fullPromptDelivered = true;
    scope.dirty = true;
  }
}

export function dispenseRoomAgentPrompt(kind: AgentPromptKind): string {
  if (kind === "join") {
    markFullPromptDelivered();
    return buildRoomAgentPrompt("join");
  }

  if (fullPromptDelivered()) {
    return buildCompactRoomAgentPrompt(kind);
  }

  markFullPromptDelivered();
  return buildRoomAgentPrompt(kind);
}

export function resetRoomAgentPromptDeliveryForTests(): void {
  processFullPromptDelivered = false;
}
