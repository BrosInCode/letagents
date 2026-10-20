import { formatRoomTurnContext, includedRoomTurnImages, MANAGED_ROOM_WORK_INSTRUCTIONS } from "../desktop-event-prompt-format.js";
import type { ProviderRoomTurnRequest, ProviderStreamEventKind } from "../provider-adapter.js";
import { CLAUDE_NO_ROOM_REPLY_SENTINEL } from "../claude-room-turn-evidence.js";
import { shownName } from "./launch-args.js";
import type { ClaudeStreamMessage } from "./types.js";

/**
 * A request nobody can answer here. With the owner's own setup on, their MCP
 * servers can ask a person for typed input, and their skills can run
 * sub-agents whose tools need approval. LetAgents shows approvals only for
 * the agent's own tool calls, so either would wait forever. Neither can
 * happen without that setup: the room's server never asks, and an agent that
 * asks for approval has no tool that starts a sub-agent.
 */
export function unanswerableClaudeRequest(request: unknown): { response: Record<string, unknown>; summary: string } | null {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const candidate = request as Record<string, unknown>;
  if (candidate.subtype === "elicitation" && candidate.mcp_server_name !== "letagents") {
    const server = shownName(candidate.mcp_server_name);
    return {
      // Declining is what the server sees when a person says no.
      response: { action: "decline" },
      summary: `Declined a request for ${candidate.mode === "url" ? "a sign-in" : "typed input"} from ${server ? `your MCP server ${server}` : "one of your MCP servers"}. LetAgents cannot show it.`,
    };
  }
  if (candidate.subtype === "can_use_tool" && candidate.agent_id != null) {
    const tool = shownName(candidate.tool_name);
    return {
      response: { behavior: "deny", message: "LetAgents cannot show an approval for a sub-agent's action, so it was not allowed." },
      summary: `Did not allow ${tool ? `the tool ${tool}` : "a tool"} for a skill's helper agent. LetAgents cannot show an approval for it.`,
    };
  }
  return null;
}

export function claudeStreamKind(message: ClaudeStreamMessage): ProviderStreamEventKind {
  const type = typeof message.type === "string" ? message.type : "";
  if (type === "assistant") return "text_delta";
  if (type === "user") return "tool_lifecycle";
  if (type === "tool_use_summary") return "tool_lifecycle";
  if (type === "result") return isClaudeFailedResult(message) && !isClaudeTurnLimitResult(message)
    ? "error" : "turn_lifecycle";
  if (type === "system") return "provider_event";
  if (/error/i.test(type)) return "error";
  return "provider_event";
}

export function isClaudeFailedResult(message: ClaudeStreamMessage): boolean {
  if (message.type !== "result") return false;
  if ((message as { is_error?: unknown }).is_error === true) return true;
  return typeof message.subtype === "string" && /(?:error|failed)/i.test(message.subtype);
}

export function isClaudeTurnLimitResult(message: ClaudeStreamMessage): boolean {
  // These documented limits end one command, not the CLI session. Unknown
  // failures retain the legacy recovery path until typed lifecycle rollout.
  return message.type === "result" && typeof message.subtype === "string"
    && /^(?:error_max_turns|error_max_budget_usd|error_max_structured_output_retries)$/.test(message.subtype);
}

export function streamMethod(message: ClaudeStreamMessage): string {
  const type = typeof message.type === "string" ? message.type : "unknown";
  const subtype = typeof message.subtype === "string" ? message.subtype : null;
  return subtype ? `${type}/${subtype}` : type;
}

export function sessionIdOf(message: ClaudeStreamMessage): string | null {
  const value = (message as { session_id?: unknown }).session_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function claudeTerminalDiscriminator(message: ClaudeStreamMessage): string {
  const subtype = typeof message.subtype === "string" && message.subtype.trim()
    ? message.subtype.trim().toLowerCase()
    : "unknown";
  const errorState = message.is_error === true ? "error"
    : message.is_error === false ? "ok" : "unknown";
  return `${subtype}:${errorState}`;
}

export function hasReadyRoomWorkplace(message: ClaudeStreamMessage): boolean {
  if (!Array.isArray(message.mcp_servers) || !Array.isArray(message.tools)) return false;
  const connected = message.mcp_servers.some(row => row && typeof row === "object"
    && row.name === "letagents" && row.status === "connected");
  return connected && ["get_board", "read_messages", "send_message"].every(name =>
    (message.tools as unknown[]).includes(`mcp__letagents__${name}`));
}

/**
 * With the owner's own setup on, Claude also reads their MCP servers, and one
 * of them may be named `letagents` too. The room's server is the one this
 * launch named on the command line, which Claude reports as `dynamic`.
 */
export function roomServerIsThisLaunchs(message: ClaudeStreamMessage): boolean {
  const rooms = Array.isArray(message.mcp_servers)
    ? message.mcp_servers.filter(row => row && typeof row === "object" && row.name === "letagents")
    : [];
  return rooms.length === 1 && rooms[0].source === "dynamic";
}

export function assistantTextOf(message: ClaudeStreamMessage): string | null {
  const content = ((message as { message?: { content?: unknown } }).message ?? {}).content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || null;
}

/**
 * Claude Code takes base64 image blocks in a stream-json user message and
 * resizes them itself. Each image follows a short label that names it, in the
 * order the prompt's attachment notes number them.
 */
export function userStreamJsonLine(text: string, uuid?: string, attachments?: ProviderRoomTurnRequest["attachments"]): string {
  const images = includedRoomTurnImages(attachments).flatMap(image => image.data ? [
    { type: "text", text: `Image ${image.number}: ${JSON.stringify(image.fileName)}` },
    { type: "image", source: { type: "base64", media_type: image.mimeType,
      data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength).toString("base64") } },
  ] : []);
  return JSON.stringify({
    type: "user",
    ...(uuid ? { uuid } : {}),
    message: { role: "user", content: [{ type: "text", text }, ...images] },
  });
}

export function boundedClaudeRoomTurnPrompt(request: ProviderRoomTurnRequest, context = formatRoomTurnContext(request)): string {
  return [
    ...MANAGED_ROOM_WORK_INSTRUCTIONS,
    "You may use the discovered LetAgents product tools for room context, tasks, artifacts, status, deliberate side messages, or moving to another room. Those actions are daemon-mediated.",
    "Answer the activating message in your final response; do not send that same reply with a message tool.",
    `If no response should be published, return exactly ${CLAUDE_NO_ROOM_REPLY_SENTINEL} with no other text.`,
    `Inbox item: ${request.inboxItemId}`,
    ...context,
  ].join("\n");
}

export const CLAUDE_DAEMON_BOOTSTRAP_PROMPT = [
  "Initialize this supervised Claude Code continuation.",
  "Do not call tools, inspect the room, or perform work.",
  "Reply exactly LETAGENTS_CLAUDE_DAEMON_READY.",
].join("\n");

/** The model's own short description of a task, as one printable line. */
export function shownTaskDescription(value: unknown): string {
  // eslint-disable-next-line no-control-regex
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return text || "a task";
}

/** The result of the turn that Claude Code runs by itself for the notice of a background task. It names no command. */
export function isClaudeTaskNoticeResult(message: ClaudeStreamMessage, sessionId: string): boolean {
  const origin = message.origin as { kind?: unknown } | null | undefined;
  return message.type === "result" && message.user_message_uuid == null && origin?.kind === "task-notification"
    && sessionIdOf(message) === sessionId;
}

export function parseStreamLine(line: string): ClaudeStreamMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as ClaudeStreamMessage
      : null;
  } catch {
    return null;
  }
}
