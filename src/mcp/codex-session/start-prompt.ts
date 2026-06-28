import { randomUUID } from "crypto";

import type { JoinedVia } from "../room-id.js";

export const DEFAULT_STOP_PHRASE = "/stop-codex-room";

export function makeToken(): string {
  return `LOCAL_CODEX_ROOM_${randomUUID()}`;
}

export function formatDeadline(minutes: number): { utc: string | null } {
  if (minutes <= 0) {
    return { utc: null };
  }

  const deadline = new Date(Date.now() + minutes * 60 * 1000);
  return {
    utc: deadline.toISOString().replace("T", " ").replace(".000Z", " UTC"),
  };
}

function buildJoinInstruction(joinedVia: JoinedVia, roomIdentifier: string): string {
  if (joinedVia === "join_code") {
    return `Call the LetAgents MCP tool join_code with {"code":"${roomIdentifier}","session_mode":"current"}.`;
  }

  return `Call the LetAgents MCP tool join_room with {"name":"${roomIdentifier}","session_mode":"current"}.`;
}

export function buildStartPrompt(input: {
  room_identifier: string;
  joined_via: JoinedVia;
  cwd: string;
  repo_branch?: string | null;
  stop_phrase: string;
  token: string;
  deadline_utc: string | null;
  max_minutes: number;
}): string {
  const deadlineInstruction =
    input.max_minutes > 0 && input.deadline_utc
      ? `Hard stop deadline: ${input.deadline_utc}. Stop when the stop phrase appears or when that deadline is reached, whichever comes first.`
      : "There is no hard deadline. Stop only when the stop phrase appears or when you are interrupted.";

  return [
    "Run as a persistent local Codex worker for a LetAgents room.",
    `Primary working directory: ${input.cwd}. Use this repository/worktree when the room asks for implementation or repo work.`,
    input.repo_branch ? `Active git branch at startup: ${input.repo_branch}.` : null,
    deadlineInstruction,
    "",
    "Instructions:",
    `1. ${buildJoinInstruction(input.joined_via, input.room_identifier)}`,
    "2. Call register_agent_session with session_kind=\"worker\" and runtime=\"codex\". Keep the returned agent_session_id.",
    "3. Pass that agent_session_id to wait_for_messages, send_message, send_thread_message, post_status, and task tools whenever the tool accepts it.",
    "4. Do not start another live session. Join the room inline in this worker only.",
    "5. Read the room and task board before contributing so you have current context.",
    "6. Keep polling with wait_for_messages using a 30000 ms timeout and track the latest seen message id.",
    "7. When new messages arrive, contribute when useful. Be concise, thoughtful, and non-repetitive.",
    "8. When the room asks for coding work, do the work locally in this repository: inspect files, edit code, run checks, commit when asked, and push only when explicitly requested.",
    "9. Post short status updates to the room when you start meaningful work, when you are blocked, and when you finish meaningful work.",
    `10. Stop immediately if a browser/user room message text exactly equals: ${input.stop_phrase}`,
    `11. When stopping, reply in this thread with exactly: ${input.token}_DONE`,
    "",
    "Constraints:",
    "- Do not narrate hidden chain-of-thought.",
    "- Do not spam the room with keepalive messages.",
    "- Stay in the room continuously until stopped.",
  ].filter(Boolean).join("\n");
}
