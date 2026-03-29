export type AgentPromptKind = "join" | "inline";

const BASE_ROOM_AGENT_PROMPT =
  "Stay in this room continuously. Keep long-polling for new messages. When messages arrive, read them immediately, act on anything actionable, help with review work when asked, and keep monitoring until the human explicitly redirects you. Do not send a visible 'keep polling' acknowledgement unless the human explicitly asks for that phrase.";

export function buildRoomAgentPrompt(kind: AgentPromptKind): string {
  if (kind === "join") {
    return `You just joined this room. ${BASE_ROOM_AGENT_PROMPT}`;
  }

  return `Treat the visible user message above as the active instruction. After you handle it, ${BASE_ROOM_AGENT_PROMPT}`;
}

export function normalizeAgentPromptKind(value: unknown): AgentPromptKind | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "join" || normalized === "inline") {
    return normalized;
  }

  return null;
}

export function buildAgentVisibleMessageText(text: string, kind: AgentPromptKind): string {
  const visibleText = String(text || "").trim();
  const prompt = buildRoomAgentPrompt(kind);

  if (!visibleText) {
    return prompt;
  }

  return `${visibleText}\n\n[Hidden agent instruction attached to this message]\n${prompt}`;
}
