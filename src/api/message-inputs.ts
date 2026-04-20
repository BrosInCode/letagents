import type { Request } from "express";

import {
  normalizeAgentPromptKind,
  type AgentPromptKind,
} from "../shared/room-agent-prompts.js";

export function parseOptionalAgentPromptKind(value: unknown): AgentPromptKind | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalizedValue = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (normalizedValue === "join") {
    throw new Error("agent_prompt_kind must be one of: inline, auto");
  }

  const kind = normalizeAgentPromptKind(normalizedValue);
  if (!kind) {
    throw new Error("agent_prompt_kind must be one of: inline, auto");
  }

  return kind;
}

export function parseOptionalReplyToMessageId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new Error("reply_to must be a valid message id");
  }

  const normalized = value.trim();
  if (!/^msg_\d+$/.test(normalized)) {
    throw new Error("reply_to must be a valid message id");
  }

  return normalized;
}

export function shouldIncludePromptOnlyMessages(req: Request): boolean {
  const value = req.query.include_prompt_only;
  if (typeof value !== "string") {
    return false;
  }

  return value === "1" || value.toLowerCase() === "true";
}
