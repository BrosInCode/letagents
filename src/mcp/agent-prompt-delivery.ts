import {
  buildCompactRoomAgentPrompt,
  buildRoomAgentPrompt,
  type AgentPromptKind,
} from "../shared/room-agent-prompts.js";

// The MCP server process serves a single agent client, so "delivered once per
// process" is equivalent to "delivered once per agent session". After the full
// room-agent instructions have gone out once, every later expansion uses the
// compact form so long-polling loops stop re-paying the full boilerplate.
let fullPromptDelivered = false;

export function dispenseRoomAgentPrompt(kind: AgentPromptKind): string {
  if (kind === "join") {
    fullPromptDelivered = true;
    return buildRoomAgentPrompt("join");
  }

  if (fullPromptDelivered) {
    return buildCompactRoomAgentPrompt(kind);
  }

  fullPromptDelivered = true;
  return buildRoomAgentPrompt(kind);
}

export function resetRoomAgentPromptDeliveryForTests(): void {
  fullPromptDelivered = false;
}
