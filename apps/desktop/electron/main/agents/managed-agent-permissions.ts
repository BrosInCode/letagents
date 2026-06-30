import { randomUUID } from "node:crypto";

import type {
  DesktopAgentProviderId,
  DesktopManagedAgentPermissionDecisionBehavior,
  DesktopManagedAgentPermissionRequest,
} from "../../ipc-types.js";

export const DEFAULT_MANAGED_AGENT_PERMISSION_TIMEOUT_MS = 10 * 60_000;

export const MANAGED_AGENT_AUTO_ALLOWED_TOOL_NAMES = [
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "Read",
  "TodoRead",
  "TodoWrite",
] as const;

export interface CreateManagedAgentPermissionRequestInput {
  providerId: DesktopAgentProviderId;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string | null;
  title?: string | null;
  displayName?: string | null;
  description?: string | null;
  decisionReason?: string | null;
  requestedAt: string;
}

export interface ManagedAgentPermissionDecision {
  requestId: string;
  behavior: DesktopManagedAgentPermissionDecisionBehavior;
  message: string | null;
  source: "desktop" | "room" | "system";
}

export function createManagedAgentPermissionRequest(
  input: CreateManagedAgentPermissionRequestInput,
): DesktopManagedAgentPermissionRequest {
  const title = normalizeText(input.title) ||
    normalizeText(input.displayName) ||
    `Use ${normalizeText(input.toolName) || "tool"}`;
  return {
    id: `perm_${randomUUID()}`,
    providerId: input.providerId,
    sessionId: input.sessionId,
    toolName: normalizeText(input.toolName) || "unknown",
    toolUseId: normalizeText(input.toolUseId),
    title,
    description: normalizeText(input.description),
    inputSummary: summarizeManagedAgentToolInput(input.toolName, input.toolInput),
    decisionReason: normalizeText(input.decisionReason),
    roomMessageId: null,
    requestedAt: input.requestedAt,
  };
}

export function isAutoAllowedManagedAgentTool(toolName: string | null | undefined): boolean {
  const normalized = normalizeToolName(toolName);
  if (!normalized || normalized.includes("__")) {
    return false;
  }
  return MANAGED_AGENT_AUTO_ALLOWED_TOOL_NAMES.some((allowed) =>
    normalized === normalizeToolName(allowed)
  );
}

export function buildManagedAgentPermissionRoomText(input: {
  request: DesktopManagedAgentPermissionRequest;
  agentDisplayName?: string | null;
}): string {
  const agentName = normalizeText(input.agentDisplayName) || "Managed agent";
  const lines = [
    "Permission request",
    `${agentName} wants approval for: ${input.request.title}`,
    `Tool: ${input.request.toolName}`,
  ];
  if (input.request.inputSummary) {
    lines.push(`Target: ${input.request.inputSummary}`);
  }
  if (input.request.description) {
    lines.push(input.request.description);
  }
  lines.push("Use the local agent detail modal to allow or deny this request.");
  return lines.join("\n");
}

export function parseManagedAgentPermissionDecision(input: {
  text: string | null | undefined;
  pendingRequests: DesktopManagedAgentPermissionRequest[];
  replyToMessageId?: string | null;
}): ManagedAgentPermissionDecision | null {
  const text = normalizeText(input.text);
  if (!text) {
    return null;
  }

  const explicit = /^(approve|allow|yes|deny|reject|no)\s+(`?perm_[a-f0-9-]+`?)(?:\s+([\s\S]+))?$/i.exec(text);
  if (explicit) {
    const requestId = explicit[2]?.replace(/`/g, "") ?? "";
    if (!input.pendingRequests.some((request) => request.id === requestId)) {
      return null;
    }
    return {
      requestId,
      behavior: decisionBehaviorForWord(explicit[1]),
      message: normalizeText(explicit[3]),
      source: "room",
    };
  }

  const implicit = /^(approve|allow|yes|deny|reject|no)(?:\s+([\s\S]+))?$/i.exec(text);
  if (!implicit || !input.replyToMessageId) {
    return null;
  }
  const matching = input.pendingRequests.filter((request) =>
    request.roomMessageId === input.replyToMessageId
  );
  if (matching.length !== 1) {
    return null;
  }
  return {
    requestId: matching[0].id,
    behavior: decisionBehaviorForWord(implicit[1]),
    message: normalizeText(implicit[2]),
    source: "room",
  };
}

export function removeManagedAgentPermissionRequest(
  requests: DesktopManagedAgentPermissionRequest[] | null | undefined,
  requestId: string,
): DesktopManagedAgentPermissionRequest[] {
  return (requests ?? []).filter((request) => request.id !== requestId);
}

export function isManagedAgentPermissionDecisionBehavior(
  value: unknown,
): value is DesktopManagedAgentPermissionDecisionBehavior {
  return value === "allow" || value === "deny";
}

function summarizeManagedAgentToolInput(
  toolName: string | null | undefined,
  input: Record<string, unknown>,
): string | null {
  const normalized = normalizeToolName(toolName);
  const filePath = stringField(input, "file_path") || stringField(input, "path");
  if (filePath) {
    return truncateText(redactInlineSecrets(filePath), 220);
  }
  if (normalized === "bash") {
    const command = stringField(input, "command");
    return command ? truncateText(redactInlineSecrets(command), 320) : null;
  }
  const redacted = redactToolInput(input);
  const json = JSON.stringify(redacted);
  return json && json !== "{}" ? truncateText(json, 360) : null;
}

function redactToolInput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, 12).map(redactToolInput);
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? truncateText(redactInlineSecrets(value), 220) : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 18)) {
    if (/(token|secret|password|credential|api[_-]?key|authorization)/i.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = redactToolInput(entry);
    }
  }
  return output;
}

function decisionBehaviorForWord(value: string | null | undefined): DesktopManagedAgentPermissionDecisionBehavior {
  return /^(approve|allow|yes)$/i.test(String(value ?? "")) ? "allow" : "deny";
}

function normalizeToolName(toolName: string | null | undefined): string {
  return normalizeText(toolName)?.toLowerCase() ?? "";
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? normalizeText(value) : null;
}

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return normalized || null;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(/\b(authorization\s*[:=]\s*(?:bearer\s+)?)([^\s'"`]+)/gi, "$1[redacted]")
    .replace(/\b((?:access[_-]?token|api[_-]?key|apikey|auth|authorization|credential|password|secret|token)=)([^\s'"`]+)/gi, "$1[redacted]")
    .replace(/(--(?:api-key|apikey|auth|authorization|credential|key|password|secret|token)(?:=|\s+))([^\s'"`]+)/gi, "$1[redacted]")
    .replace(/([?&](?:access[_-]?token|api[_-]?key|apikey|auth|authorization|credential|key|password|secret|token)=)([^&\s'"`]+)/gi, "$1[redacted]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, "$1[redacted]@");
}
