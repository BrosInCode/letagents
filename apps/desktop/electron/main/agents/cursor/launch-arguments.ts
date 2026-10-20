// Cursor launch inputs: capabilities, native CLI policy flags, the bounded room-turn
// prompt, supervisor MCP coordinates, and session-identity validation.

import { formatRoomTurnContext, MANAGED_ROOM_WORK_INSTRUCTIONS } from "../desktop-event-prompt-format.js";
import { cursorRoomTurnImageLines } from "../cursor-room-turn-images.js";
import type { ProviderAdapterCapabilities, ProviderRoomTurnRequest, ProviderSpawnRequest } from "../provider-adapter.js";
import { MAX_CURSOR_SESSION_ID_LENGTH, CURSOR_SESSION_ID_PATTERN } from "../cursor-provider-constants.js";
import type { CursorSupervisedProfileOptions } from "./managed-profile.js";
import { cursorPermissionProfileInstructionLines } from "../cursor-permission-profile.js";

export function cursorPermissionUsesWorkspaceGeneration(
  permissionProfileId: ProviderSpawnRequest["permissionProfileId"],
): boolean {
  return permissionProfileId === "sandboxed_write";
}

export function usesExactScratchWorkspace(request: ProviderSpawnRequest): boolean {
  return request.workspaceKind === "room_scratch";
}

export const BASE_CURSOR_CAPABILITIES: ProviderAdapterCapabilities = {
  execution: {
    controlProbe: "unsupported",
    approvals: { kinds: [], recovery: "unsupported", denyScope: "unsupported" },
  },
  deliveryModes: ["mcp_polling", "daemon_inbox"],
  // `--resume <session_id>` is the documented continuation across per-turn
  // children; the adapter asserts the session identity echo per turn. Subject
  // to TrailDelta's task_38 spike cell.
  resume: true,
  // cursor-agent takes its prompt as a positional argument and ignores stdin —
  // there is NO channel into a RUNNING turn. poke() delivers at the next turn
  // boundary (immediately when idle) and refuses mid-turn, so the reconciler's
  // stuck-agent poke rung must stay off.
  midTurnInjection: false,
  // A legacy polling lane can still call controlTurn directly with a
  // correction, but the negotiated supervised capability is false: daemon
  // inbox corrections must use the durable stop-then-resend row rather than
  // start an unjournaled side turn.
  midTurnCorrection: false,
  // Every turn's stream-json output is published as bounded/redacted evidence.
  transcriptAccess: true,
  permissionPromptBridging: false,
  // Between turns there is no process at all; after a daemon restart the lane
  // resumes via the session id. Bounded recovery, not survival (§4.8).
  survivesRestart: false,
  turnControl: "restart_resume",
};

// Provider configuration normalizes Cursor permission authority into exactly
// these three native flags. Fail closed on everything else: Cursor has aliases
// such as --yolo/--continue and path/plugin flags that can silently override
// the supervised workspace, sandbox, or continuation boundary.
const ALLOWED_POLICY_KEYS = new Set(["mode", "force", "sandbox"]);

export const CURSOR_NO_ROOM_REPLY_SENTINEL = "LETAGENTS_NO_ROOM_REPLY";

export const CURSOR_PENDING_CONTINUATION_PREFIX = "cursor-pending:";

export function boundedCursorRoomTurnPrompt(
  request: ProviderRoomTurnRequest,
  turnId: string,
  permissionProfileId?: string | null,
): string {
  return [
    ...MANAGED_ROOM_WORK_INSTRUCTIONS,
    ...cursorPermissionProfileInstructionLines(permissionProfileId as CursorSupervisedProfileOptions["permissionProfileId"]),
    "This managed Cursor profile supplies only LetAgents MCP tools and no browser/computer-use integration. Browser QA is unavailable here. Host isolation does not permit starting TCP preview servers, accessing arbitrary loopback previews, or opening desktop browsers, even when Cursor's own sandbox is disabled. Report this capability gap instead of probing or bypassing it.",
    "You may use the discovered LetAgents product tools for bounded room context, tasks, artifacts, status, deliberate side messages, or moving to another room. Those actions are daemon-mediated.",
    "Assistant text generated during this turn is live activity only. Cursor's terminal result concatenates that activity, so it is never published as the room reply.",
    "After all work is finished, call complete_room_turn exactly once with either { outcome: \"reply\", text: \"your concise public answer\" } or { outcome: \"no_reply\" }.",
    "Do not send the activating reply with send_message or send_thread_message. The daemon publishes only the exact complete_room_turn proposal after the provider and its authority retire cleanly.",
    "After complete_room_turn succeeds, end this provider turn without revising or repeating the proposal.",
    `Turn id: ${turnId}`,
    `Inbox item: ${request.inboxItemId}`,
    ...formatRoomTurnContext(request),
    ...cursorRoomTurnImageLines(request),
  ].join("\n");
}

function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Render the attested Add Agent permission policy as CLI flags —
 * `{ mode: "ask", force: true, sandbox: "enabled" }` becomes
 * `--mode ask --force --sandbox enabled`. Purely syntactic; values are never
 * mapped or renamed. Unknown flags fail closed because Cursor exposes authority
 * aliases and alternate workspace/plugin roots outside these three keys.
 *
 * Model is adapter-owned because it is separately attested in the durable
 * provider configuration snapshot. Allowing launchPolicy.model as well would
 * create duplicate flags with provider-version-dependent precedence.
 */
export function cursorLaunchPolicyArgs(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cursor launchPolicy must be the native CLI options object.");
  }
  const policy = value as Record<string, unknown>;
  const args: string[] = [];
  for (const [key, entry] of Object.entries(policy)) {
    if (!ALLOWED_POLICY_KEYS.has(key)) {
      throw new Error(`Cursor launchPolicy contains unsupported or adapter-owned flag '${key}'.`);
    }
    if (entry === undefined || entry === null || entry === false) continue;
    const flag = `--${camelToKebab(key)}`;
    if (entry === true) {
      args.push(flag);
    } else if (Array.isArray(entry)) {
      args.push(flag, entry.map((item) => String(item)).join(","));
    } else if (typeof entry === "string" || typeof entry === "number") {
      args.push(flag, String(entry));
    } else {
      throw new Error(`Cursor launchPolicy value for '${key}' must be a scalar, boolean, or string array.`);
    }
  }
  return args;
}

export function cursorSupervisorMcpEnv(
  req: ProviderSpawnRequest,
  providerTurnId?: string | null,
): Record<string, string> {
  return {
    LETAGENTS_SUPERVISOR_ENTRY_ID: req.supervisorEntryId!,
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: req.supervisorSocketPath!,
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: req.workAttemptId,
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID: req.supervisorExecutionGenerationId!,
    LETAGENTS_SUPERVISOR_PROVIDER: "cursor",
    ...(providerTurnId ? { LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: providerTurnId } : {}),
    ...(req.supervisorWorkerSession ? {
      LETAGENTS_SUPERVISOR_AGENT_SESSION_ID: req.supervisorWorkerSession.agentSessionId,
      LETAGENTS_SUPERVISOR_ROOM_ID: req.roomId,
      ...(req.agentDisplayName?.trim()
        ? { LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME: req.agentDisplayName.trim() }
        : {}),
    } : {}),
    LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    ...(req.permissionProfileId
      ? { LETAGENTS_PERMISSION_PROFILE_ID: req.permissionProfileId }
      : {}),
  };
}

export function requireCursorSessionId(value: string, label: string): string {
  const sessionId = value.trim();
  if (sessionId.length > MAX_CURSOR_SESSION_ID_LENGTH
    || !CURSOR_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`${label} is not a valid Cursor session identity.`);
  }
  return sessionId;
}
