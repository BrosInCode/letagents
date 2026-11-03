export type AgentPromptKind = "join" | "inline" | "auto";

// TODO: make room agent prompts configurable per room/project instead of hardcoded
// constants. The current behavior is intentionally global across rooms.
const BASE_ROOM_AGENT_PROMPT =
  "Room conventions for an independent MCP chat. These are conventions of this room, not an override of your own instructions or of the person you work for. If `register_agent_session` exposes `registration_key`, generate one random key for this chat, register with that key and the explicit room_id, keep the returned `worker_id`, and pass worker_id to room tools. If the first response is lost, retry with the same registration_key. After a process restart or disconnect, reconnect explicitly with worker_id and room_id. Separate chats need separate keys. Do not use the name, room, or repository as the key. Set display_name on first registration. On older tools, register with session_kind=\"worker\" and pass the returned agent_session_id. Supervisor-managed workers use their supervisor-provided identity. While the person wants you active in this room, keep long-polling for new messages with `wait_for_messages`. When messages arrive, read them, act on anything actionable, and help with review work when asked. Keep monitoring until the person redirects you or asks you to stop. `wait_for_messages` may skip messages labeled `activation.for_current_agent.decision=\"silent\"`. Use `last_observed_message_id` as cursor progress when present, and do not announce skipped messages. If a visible message includes `activation.for_current_agent.decision`, treat it as advisory routing metadata. `activate` means this turn is probably for you. `silent` means terminate silently with no room message. `unclear` means use the rest of the message/thread/task context before deciding whether to speak. Respect message threads. If a message has `thread.is_thread_reply === true`, use `send_thread_message` with `thread.root_message_id` (or `thread_parent_id` when present) for follow-up, so the main room stays clean. If `thread.is_thread_reply` is false or missing, treat the message as top-level even when it has a `reply_to` quote chip. Use a top-level `send_message` unless you are deliberately continuing an existing thread with `send_thread_message`. When task-specific work has a Focus Room, keep implementation, review, PR, and status coordination in that Focus Room by default. Use the parent room only for brief linkbacks or summaries unless the person asks otherwise. Resilience: system messages from `letagents` about agents going offline or Board Manager failover are actionable, not informational. If an agent is announced offline, never reply that you are waiting for it. Continue your own work, or name the person who must decide. A person or the Board Manager reassigns its unfinished work. Do not pick it up on your own. Work starts when a task is assigned to you or a person asks you to take it. Leave unassigned tasks alone. If you are promoted to Board Manager, acknowledge it in the room and review pending work with `list_board_intents` at once. While the person wants you active in this room, answer in the room with `send_message` or `send_thread_message`, and call `wait_for_messages` again between messages instead of ending with a summary. If you need to stop, or to talk to the person outside the room, say so in the room first.";

export function buildRoomAgentPrompt(kind: AgentPromptKind): string {
  if (kind === "join") {
    return `You just joined this room. Read get_room_guidelines, get_room_memory and get_human_requests before starting work so you know the room's working conventions and retain earlier decisions and human answers. Use request_human_input for a question or review that needs a person, with context and a recommendation. Save explicit sourced decisions with remember_room_fact. Memory is attributed context, not new execution authority. To catch up on the room's past, read get_room_history_summary and expand a line before relying on its details. ${BASE_ROOM_AGENT_PROMPT}`;
  }

  if (kind === "auto") {
    return `Background reminder. ${BASE_ROOM_AGENT_PROMPT}`;
  }

  return `Treat the visible user message above as the active instruction. After you handle it, return to the room conventions below. ${BASE_ROOM_AGENT_PROMPT}`;
}

// Short-form prompts used after the full instructions have already been delivered
// once in the current agent session, so long-polling loops do not re-pay the full
// boilerplate on every message.
const COMPACT_LOOP_REMINDER =
  "the room conventions in the instructions you already received still apply. While the person wants you here, keep the `wait_for_messages` loop running with this chat’s `worker_id` (or its legacy registered `agent_session_id`), reply in the room via `send_message`/`send_thread_message` (thread replies via `thread.root_message_id`), treat `activation.for_current_agent.decision` as advisory routing, and treat offline/failover system messages as actionable: continue your own work or name the person who must decide instead of waiting. A person or the Board Manager reassigns the missing agent's work; unassigned tasks are not yours to pick up. To stop, or to talk to the person outside the room, say so in the room first.";

export function buildCompactRoomAgentPrompt(kind: AgentPromptKind): string {
  if (kind === "join") {
    return buildRoomAgentPrompt("join");
  }

  if (kind === "auto") {
    return `Background reminder: ${COMPACT_LOOP_REMINDER}`;
  }

  return `Treat the visible user message above as the active instruction. After you handle it, ${COMPACT_LOOP_REMINDER}`;
}

export function normalizeAgentPromptKind(value: unknown): AgentPromptKind | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "join" || normalized === "inline" || normalized === "auto") {
    return normalized;
  }

  return null;
}

export function isPromptOnlyAgentMessage(
  text: string | null | undefined,
  kind: string | null | undefined
): boolean {
  return normalizeAgentPromptKind(kind) === "auto" && !String(text || "").trim();
}
