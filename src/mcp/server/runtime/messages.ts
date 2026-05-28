import {
  buildRoomAgentPrompt,
  normalizeAgentPromptKind,
} from "../../../shared/room-agent-prompts.js";

export function getLastMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const messages = (payload as { messages?: Array<{ id?: string }> }).messages;
  const lastMessage = messages?.at(-1);
  return typeof lastMessage?.id === "string" ? lastMessage.id : undefined;
}

export function withJoinRoomAgentPrompt(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    agent_prompt_kind: "join",
    agent_prompt: buildRoomAgentPrompt("join"),
  };
}

function toAgentReadableMessage(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }

  const record = message as Record<string, unknown>;
  const kind = normalizeAgentPromptKind(record.agent_prompt_kind);
  const text = typeof record.text === "string" ? record.text : null;

  if (!kind || text === null) {
    return record;
  }

  return {
    ...record,
    visible_text: text,
    agent_prompt: buildRoomAgentPrompt(kind),
    prompt_injected: kind === "inline",
  };
}

export function toAgentReadableMessages(messages: unknown[] | undefined): unknown[] {
  return (messages ?? []).map((message) => toAgentReadableMessage(message));
}

export function appendIncludePromptOnly(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}include_prompt_only=1`;
}

export function normalizeOptionalToolString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
