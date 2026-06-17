export const MANAGED_AGENT_CONTEXT_REQUEST_PREFIX = "LETAGENTS_CONTEXT_REQUEST";

export type ManagedAgentContextToolName =
  | "read_recent_room_messages"
  | "search_room_messages"
  | "read_thread"
  | "read_messages_around"
  | "get_task_context"
  | "get_room_context_summary";

export interface ManagedAgentContextRequest {
  tool: ManagedAgentContextToolName;
  arguments: Record<string, unknown>;
}

export type ManagedAgentContextStorage = "local" | "cloud";

export type ManagedAgentContextResult =
  | {
      ok: true;
      tool: ManagedAgentContextToolName;
      roomIdentifier: string;
      storage: ManagedAgentContextStorage;
      messages?: unknown[];
      tasks?: unknown[];
      hasMore?: boolean;
      note?: string;
    }
  | {
      ok: false;
      tool: ManagedAgentContextToolName | string;
      roomIdentifier: string;
      storage: ManagedAgentContextStorage | null;
      error: string;
    };

export function parseManagedAgentContextRequest(
  value: string | null | undefined,
): ManagedAgentContextRequest | null {
  const text = String(value ?? "").trim();
  if (!containsManagedAgentContextRequestPrefix(text)) {
    return null;
  }

  for (const candidate of managedAgentContextRequestPayloads(text)) {
    const jsonText = jsonObjectPrefix(candidate);
    if (!jsonText) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const record = parsed as Record<string, unknown>;
    const tool = typeof record.tool === "string" ? record.tool : "";
    if (!isManagedContextToolName(tool)) {
      continue;
    }

    const args = record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
      ? (record.arguments as Record<string, unknown>)
      : {};
    return { tool, arguments: args };
  }

  return null;
}

export function containsManagedAgentContextRequestPrefix(value: string | null | undefined): boolean {
  return String(value ?? "").includes(MANAGED_AGENT_CONTEXT_REQUEST_PREFIX);
}

export function isManagedAgentContextRequest(value: string | null | undefined): boolean {
  return Boolean(parseManagedAgentContextRequest(value));
}

export function buildManagedAgentContextResultPrompt(
  result: ManagedAgentContextResult,
): string {
  return [
    "Desktop context tool result.",
    "",
    "The desktop app fetched this read-only, room-scoped context for you.",
    "Use it to answer the original room event. If you still need more context, finish with another LETAGENTS_CONTEXT_REQUEST line. Otherwise, finish with the public room reply or NO_ROOM_REPLY.",
    "",
    "Result JSON:",
    JSON.stringify(result, null, 2),
  ].join("\n");
}

function isManagedContextToolName(value: string): value is ManagedAgentContextToolName {
  return [
    "read_recent_room_messages",
    "search_room_messages",
    "read_thread",
    "read_messages_around",
    "get_task_context",
    "get_room_context_summary",
  ].includes(value);
}

function managedAgentContextRequestPayloads(text: string): string[] {
  const payloads: string[] = [];
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const index = text.indexOf(MANAGED_AGENT_CONTEXT_REQUEST_PREFIX, searchFrom);
    if (index === -1) {
      break;
    }

    const rest = text.slice(index + MANAGED_AGENT_CONTEXT_REQUEST_PREFIX.length);
    const line = rest.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (line) {
      payloads.push(line);
    }
    searchFrom = index + MANAGED_AGENT_CONTEXT_REQUEST_PREFIX.length;
  }
  return payloads;
}

function jsonObjectPrefix(value: string): string | null {
  const start = value.indexOf("{");
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
}
