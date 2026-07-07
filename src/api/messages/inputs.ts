import type { Request } from "express";

import { RequestValidationError } from "../validation-error.js";
import {
  normalizeAgentPromptKind,
  type AgentPromptKind,
} from "../../shared/room-agent-prompts.js";

export function parseOptionalAgentPromptKind(value: unknown): AgentPromptKind | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalizedValue = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (normalizedValue === "join") {
    throw new RequestValidationError("agent_prompt_kind must be one of: inline, auto");
  }

  const kind = normalizeAgentPromptKind(normalizedValue);
  if (!kind) {
    throw new RequestValidationError("agent_prompt_kind must be one of: inline, auto");
  }

  return kind;
}

export function parseOptionalReplyToMessageId(value: unknown): string | null {
  return parseOptionalMessageId(value, "reply_to");
}

export function parseOptionalThreadRootMessageId(value: unknown): string | null {
  return parseOptionalMessageId(value, "thread_root_id");
}

function parseOptionalMessageId(value: unknown, fieldName: "reply_to" | "thread_root_id"): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw new RequestValidationError(`${fieldName} must be a valid message id`);
  }

  const normalized = value.trim();
  if (!/^msg_\d+$/.test(normalized)) {
    throw new RequestValidationError(`${fieldName} must be a valid message id`);
  }

  return normalized;
}

export interface CreateMessageBody {
  sender: string | null;
  text: string | null;
  agent_prompt_kind: unknown;
  reply_to: unknown;
  thread_root_id: unknown;
  attachments: unknown;
  agent_session_id: string | null;
  agent_session_token: string | null;
  client_message_id: string | null;
}

export function parseCreateMessageBody(body: unknown): CreateMessageBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestValidationError("request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  return {
    sender: optionalStringField(record, "sender"),
    text: optionalStringField(record, "text"),
    agent_prompt_kind: record.agent_prompt_kind,
    reply_to: record.reply_to,
    thread_root_id: record.thread_root_id,
    attachments: record.attachments,
    agent_session_id: optionalStringField(record, "agent_session_id"),
    agent_session_token: optionalStringField(record, "agent_session_token"),
    client_message_id: optionalStringField(record, "client_message_id"),
  };
}

function optionalStringField(record: Record<string, unknown>, fieldName: string): string | null {
  const value = record[fieldName];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new RequestValidationError(`${fieldName} must be a string`);
  }
  return value;
}

export function shouldIncludePromptOnlyMessages(req: Request): boolean {
  const value = req.query.include_prompt_only;
  if (typeof value !== "string") {
    return false;
  }

  return value === "1" || value.toLowerCase() === "true";
}
