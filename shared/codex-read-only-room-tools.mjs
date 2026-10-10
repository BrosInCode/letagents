/**
 * The room tools a Read-only Codex agent may use, and the only ones.
 *
 * These read what the room says, and say something in it: a message, a
 * status, visible reasoning, a question for a person, and where the final
 * answer goes. Each takes room identifiers and text, never a folder. None
 * changes the task board, joins or creates a room, submits a review, saves
 * room memory, sets a wake rule, or inspects or writes a repository on this
 * Mac. A tool is allowed only by being named here, so one the room server
 * gains later is refused until someone decides about it.
 *
 * Two places keep the list, and both read it from here. Codex is told to run
 * these without asking and to refuse the others, since a Read-only agent has
 * nobody to ask. The background service refuses the others itself, where
 * every room tool call of such an agent passes, so the limit does not rest on
 * what Codex does with an approval mode.
 */
export const CODEX_READ_ONLY_ROOM_TOOLS = new Set([
  // What the room says.
  "read_messages", "get_current_room", "get_room_guidelines", "get_room_memory", "get_human_requests",
  "get_board", "get_board_settings", "list_board_intents", "list_wake_rules", "get_room_artifacts", "get_room_events",
  // What the agent says in it.
  "send_message", "send_thread_message", "post_status", "post_reasoning", "request_human_input", "set_reply_thread",
]);
