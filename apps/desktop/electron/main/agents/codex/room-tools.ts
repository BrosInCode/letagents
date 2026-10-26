/** Room-turn prompt input and the checks that the LetAgents workplace and room tools are ready. */
import { formatRoomTurnContext, includedRoomTurnImages, MANAGED_ROOM_WORK_INSTRUCTIONS, roomTurnImageLabel } from "../desktop-event-prompt-format.js";
import { z } from "zod";
import { type ProviderRoomTurnRequest, ProviderContinuationMissingError } from "../provider-adapter.js";
import { errorMessage } from "../provider-evidence.js";
import type { CodexAdapterRpc } from "./types.js";
import { REQUIRED_ROOM_TOOLS } from "./launch-contract.js";
import { isMissingContinuation } from "./thread-access.js";
import { recordValue } from "./notifications.js";

/**
 * Codex's own process reads a local image, outside the agent's sandbox, and
 * resizes it before it enters the thread history. The daemon staged the file
 * and keeps it until this turn has ended. Each image follows a short label.
 */
export function roomTurnImageInput(request: ProviderRoomTurnRequest): Array<Record<string, unknown>> {
  return includedRoomTurnImages(request.attachments).flatMap(image => image.path ? [
    { type: "text", text: roomTurnImageLabel(image), text_elements: [] },
    { type: "localImage", path: image.path },
  ] : []);
}

export function boundedRoomTurnPrompt(request: ProviderRoomTurnRequest, context = formatRoomTurnContext(request)): string {
  return [
    ...MANAGED_ROOM_WORK_INSTRUCTIONS,
    "You may use the discovered LetAgents product tools for room context, tasks, artifacts, status, deliberate side messages, or moving to another room. Those actions are daemon-mediated.",
    "Answer the activating message in your final response; do not send that same reply with a message tool.",
    "If no response should be published, return exactly LETAGENTS_NO_ROOM_REPLY with no other text.",
    `Inbox item: ${request.inboxItemId}`,
    ...context,
  ].join("\n");
}

export class CodexRoomTurnRecoveryError extends Error {
  readonly roomTurnRecoveryOutcome = "ambiguous" as const;
}
export class CodexRoomTurnObservationDetachedError extends Error {}

export function isMethodNotFound(error: unknown): boolean {
  return /(?:-32601|method\s+not\s+found|unknown\s+method|unsupported\s+method)/i.test(
    errorMessage(error),
  );
}

export function configuredMcpServerNames(value: unknown): string[] {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [
        ...((value as { data?: unknown }).data && Array.isArray((value as { data?: unknown }).data)
          ? (value as { data: unknown[] }).data
          : []),
        ...((value as { servers?: unknown }).servers && Array.isArray((value as { servers?: unknown }).servers)
          ? (value as { servers: unknown[] }).servers
          : []),
      ]
      : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const name = (row as { name?: unknown }).name;
    return typeof name === "string" ? [name] : [];
  });
}

export function isTransientWorkplaceProbeFailure(error: unknown): boolean {
  return /(?:timed?\s*out|timeout|aborted|temporar(?:y|ily)|unavailable|connection\s+(?:closed|reset)|socket\s+hang\s+up)/i.test(
    errorMessage(error),
  );
}

export async function requireLetAgentsWorkplace(client: CodexAdapterRpc): Promise<void> {
  let response: unknown;
  try {
    response = await client.request("mcpServerStatus/list", {});
  } catch (error) {
    // This RPC is only an observability probe. The daemon already injects the
    // exact LetAgents MCP config into the Codex app-server launch, and the
    // worker's register_agent_session + wait evidence is the authoritative
    // readiness gate. A busy MCP host can time this probe out while the room
    // worker is healthy; do not kill or strand that durable execution.
    if (isTransientWorkplaceProbeFailure(error)) return;
    throw new Error(`Unable to verify the LetAgents MCP workplace: ${errorMessage(error)}`);
  }
  if (!configuredMcpServerNames(response).some((name) => name.toLowerCase() === "letagents")) {
    throw new Error(
      "LetAgents MCP server is not configured in Codex; refusing to launch without the room workplace.",
    );
  }
}

export class CodexRoomToolsUnavailableError extends Error {
  readonly providerFailureCode = "provider_room_tools_unavailable";

  constructor(detail: string) {
    super(`${detail} No model turn was started. Retry the message.`);
    this.name = "CodexRoomToolsUnavailableError";
  }
}

export const ROOM_READINESS_URI = "letagents://runtime/readiness";
export const roomReadinessSchema = z.strictObject({
  format: z.literal(1),
  profile: z.literal("supervised_room_turn"),
  provider: z.literal("codex"),
  tools: z.array(z.string().min(1).max(128)).max(256),
});

/** Read this thread's server directly; aggregate inventory starts unrelated MCPs. */
export async function requireLetAgentsRoomTools(client: CodexAdapterRpc, threadId: string): Promise<void> {
  let response: Record<string, unknown> | null;
  try {
    response = recordValue(await client.request("mcpServer/resource/read", {
      threadId, server: "letagents", uri: ROOM_READINESS_URI,
    }));
  } catch (error) {
    if (isMissingContinuation(error, threadId)) throw new ProviderContinuationMissingError(threadId);
    throw new CodexRoomToolsUnavailableError(/(?:timed?\s*out|timeout)/i.test(errorMessage(error))
      ? "Room tool discovery timed out."
      : "Codex could not read this conversation's room readiness.");
  }
  const contents = response?.contents;
  const resource = Array.isArray(contents) && contents.length === 1 ? recordValue(contents[0]) : null;
  let payload: unknown;
  if (resource?.uri === ROOM_READINESS_URI && resource.mimeType === "application/json"
    && typeof resource.text === "string" && Buffer.byteLength(resource.text, "utf8") <= 64 * 1024) {
    try { payload = JSON.parse(resource.text); } catch { /* Reject malformed readiness below. */ }
  }
  const readiness = roomReadinessSchema.safeParse(payload);
  if (!readiness.success) throw new CodexRoomToolsUnavailableError("LetAgents returned invalid room readiness.");
  if (!REQUIRED_ROOM_TOOLS.every(name => readiness.data.tools.includes(name))) {
    throw new CodexRoomToolsUnavailableError("Required LetAgents room tools are missing from this conversation.");
  }
}
