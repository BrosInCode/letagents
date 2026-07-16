import { randomUUID } from "node:crypto";

import type { DesktopCodexJoinedVia } from "./state.js";
import type { DesktopManagedAgentDeliveryMode } from "../../ipc-types.js";
import { LETAGENTS_CODENAME_EXAMPLES } from "./codenames.js";
import { DESKTOP_EVENTS_NO_ROOM_REPLY } from "./codex-event-prompt.js";

export const DEFAULT_CODEX_STOP_PHRASE = "/stop-codex-room";

export function makeCodexStopToken(): string {
  return `LOCAL_CODEX_ROOM_${randomUUID()}`;
}

export function formatCodexDeadline(minutes: number): { utc: string | null } {
  if (minutes <= 0) {
    return { utc: null };
  }

  const deadline = new Date(Date.now() + minutes * 60 * 1000);
  return {
    utc: deadline.toISOString().replace("T", " ").replace(".000Z", " UTC"),
  };
}

function buildJoinInstruction(joinedVia: DesktopCodexJoinedVia, roomIdentifier: string): string {
  if (joinedVia === "join_code") {
    return `Call the LetAgents MCP tool join_code with ${JSON.stringify({ code: roomIdentifier, session_mode: "current" })}.`;
  }

  return `Call the LetAgents MCP tool join_room with ${JSON.stringify({ name: roomIdentifier, session_mode: "current" })}.`;
}

function codenameInstructionLines(suggestedDisplayName: string, providerLabel: string): string[] {
  const examples = LETAGENTS_CODENAME_EXAMPLES.join(", ");
  return [
    `3. Give yourself a short distinct LetAgents-style codename before you do any room work. Suggested codename: ${suggestedDisplayName}. Use it if it is not already visible in the room; otherwise choose another fused codename in the same style. Examples: ${examples}.`,
    "4. Call set_agent_name with that chosen codename before posting status or registering. Treat this as your room identity, not decoration.",
    `5. Never call yourself ${providerLabel}, ${providerLabel} 1, ${providerLabel} 2, or any numbered provider label.`,
  ];
}

export function buildCodexStartPrompt(input: {
  roomIdentifier: string;
  joinedVia: DesktopCodexJoinedVia;
  cwd: string;
  deliveryMode: DesktopManagedAgentDeliveryMode;
  stopPhrase: string;
  token: string;
  suggestedDisplayName: string;
  deadlineUtc: string | null;
  maxMinutes: number;
  /** Human label for the provider running this worker. Defaults to Codex. */
  providerLabel?: string;
  /** register_agent_session runtime prefix. Defaults to codex. */
  runtimeKey?: string;
  /** Exact non-secret room continuity restored by the supervisor. */
  resumeWorker?: {
    agentSessionId: string;
    roomCursor: string | null;
  };
}): string {
  const providerLabel = input.providerLabel ?? "Codex";
  const runtimeKey = input.runtimeKey ?? "codex";
  const deadlineInstruction =
    input.maxMinutes > 0 && input.deadlineUtc
      ? `Hard stop deadline: ${input.deadlineUtc}. Stop when the stop phrase appears or when that deadline is reached, whichever comes first.`
      : "There is no hard deadline. Stop only when the stop phrase appears or when you are interrupted.";

  if (input.deliveryMode === "desktop_events") {
    return [
      "Start as a desktop-supervised local Codex worker for a LetAgents room.",
      `Primary working directory: ${input.cwd}. Use this repository/worktree when future room events ask for implementation or repo work.`,
      deadlineInstruction,
      "",
      "Bootstrap instructions:",
      `1. The LetAgents desktop app has already registered this room worker as ${input.suggestedDisplayName}.`,
      "2. Do not call LetAgents MCP room tools during bootstrap. This app-server surface may not expose them.",
      "3. Do not call wait_for_messages. The desktop app will send room events into this same Codex thread as future turns.",
      `4. Finish this bootstrap turn with exactly ${DESKTOP_EVENTS_NO_ROOM_REPLY}.`,
      "",
      "Future event turns:",
      "- When the desktop sends a room event, decide whether action is needed.",
      "- If action is useful, do the local work and make your final answer the public room reply the desktop should publish as you.",
      `- If no public room reply is needed, finish with exactly ${DESKTOP_EVENTS_NO_ROOM_REPLY}.`,
      "- Be concise, avoid duplicate responses, and do not narrate hidden chain-of-thought.",
      `- Stop immediately if a future room message text exactly equals: ${input.stopPhrase}`,
      `- When stopping, finish with exactly: ${input.token}_DONE`,
    ].join("\n");
  }

  if (input.resumeWorker) {
    const cursorInstruction = input.resumeWorker.roomCursor
      ? `Use ${JSON.stringify(input.resumeWorker.roomCursor)} as the first after_message_id cursor.`
      : "No prior worker cursor was checkpointed; perform one bounded catch-up wait, then checkpoint and advance its returned cursor.";
    return [
      `Resume the existing persistent local ${providerLabel} worker for a LetAgents room.`,
      `Primary working directory: ${input.cwd}. Continue the same work attempt in this repository/worktree.`,
      deadlineInstruction,
      "",
      "Durable worker continuity:",
      `1. Your exact existing agent_session_id is ${JSON.stringify(input.resumeWorker.agentSessionId)}. Reuse it for every room, status, reasoning, task, and wait tool that accepts agent_session_id.`,
      `2. The exact supervised room is ${JSON.stringify(input.roomIdentifier)}. Pass it explicitly as room_id to every room and task tool; do not infer a repo/default room.`,
      `3. ${cursorInstruction}`,
      "4. Call get_board once to re-read the current lease and task state, then immediately continue wait_for_messages from that cursor.",
      "5. Stay in the wait loop and advance from each returned message id or last_observed_message_id.",
      "6. Continue unfinished room work from the existing transcript, workspace, and lease state.",
      `7. Stop immediately if a browser/user room message text exactly equals: ${input.stopPhrase}`,
      `8. When stopping, reply in the relevant room thread with exactly: ${input.token}_DONE`,
      "",
      "Identity fences:",
      "- Do not call join_room or join_code during this resume bootstrap.",
      "- Do not call resume_room_session; it recreates owner participation and uses shared room-local cursor state.",
      "- Do not choose or set a new codename.",
      "- Do not call register_agent_session or create a replacement worker session.",
      "- Do not replay the full room history; continue from the saved cursor.",
      "- Do not narrate hidden chain-of-thought or spam keepalives.",
    ].join("\n");
  }

  return [
    `Run as a persistent local ${providerLabel} worker for a LetAgents room.`,
    `Primary working directory: ${input.cwd}. Use this repository/worktree when the room asks for implementation or repo work.`,
    deadlineInstruction,
    "",
    "Instructions:",
    `1. ${buildJoinInstruction(input.joinedVia, input.roomIdentifier)}`,
    "2. Call read_messages once, then call get_board once so you know the current participants and active work.",
    ...codenameInstructionLines(input.suggestedDisplayName, providerLabel),
    `6. Call register_agent_session with session_kind="worker", runtime=${JSON.stringify(`${runtimeKey}:${input.token}`)}, and the same chosen display_name. Keep the returned agent_session_id.`,
    "7. Do not continue into the room loop until register_agent_session succeeds. If LetAgents MCP auth is required, call get_onboarding_status and finish with a short public setup-needed note instead of claiming availability.",
    "8. Pass that agent_session_id to wait_for_messages, send_message, send_thread_message, post_status, post_reasoning, and task tools whenever the tool accepts it.",
    "9. If get_board shows accepted unassigned work that is appropriate for you, claim it with claim_task using the registered agent_session_id before entering the wait loop.",
    "10. Do not start another live session. Join the room inline in this worker only.",
    "11. Keep polling with wait_for_messages using a 30000 ms timeout and track the latest seen message id.",
    "12. When new messages arrive, contribute when useful. Be concise, thoughtful, and non-repetitive.",
    "13. When the room asks for coding work, do the work locally in this repository: inspect files, edit code, run checks, commit when asked, and push only when explicitly requested.",
    "14. Post short status updates to the room when you start meaningful work, when you are blocked, and when you finish meaningful work.",
    "15. Also call post_reasoning for concise public progress summaries when you start meaningful work, become blocked, make a useful checkpoint, or finish useful work. This is readable progress for the desktop UI, not hidden chain-of-thought.",
    `16. Stop immediately if a browser/user room message text exactly equals: ${input.stopPhrase}`,
    `17. When stopping, reply in this thread with exactly: ${input.token}_DONE`,
    "",
    "Constraints:",
    "- Do not narrate hidden chain-of-thought.",
    "- Do not spam the room with keepalive messages.",
    "- Stay in the room continuously until stopped.",
  ].join("\n");
}

export function looksLikeInviteCode(value: string): boolean {
  return /^[A-Z0-9]{4}(?:-[A-Z0-9]{4})+$/.test(value.trim().toUpperCase());
}
