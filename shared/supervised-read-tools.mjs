/**
 * Room tools that only read. A supervised agent's every other tool call is a
 * mutation: the MCP facade asks the daemon to journal it, and the daemon
 * checks that the call it journals was declared as one. Both read this list,
 * so they cannot disagree about which is which.
 */
export const SUPERVISED_READ_ONLY_TOOLS = new Set([
  "get_current_room",
  "check_repo",
  "check_repo_visibility",
  "read_messages",
  "wait_for_messages",
  "get_board",
  "get_board_settings",
  "get_room_memory",
  "get_human_requests",
  "get_room_guidelines",
  "get_room_artifacts",
  "get_room_events",
  "list_wake_rules",
  "list_board_intents",
  "get_onboarding_status",
  "status_local_codex_session",
  "rental_list_requests",
]);
