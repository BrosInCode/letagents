/**
 * Room tools that only read. A supervised agent's every other tool call is a
 * mutation: the MCP facade asks the daemon to journal it, and the daemon
 * checks that the call it journals was declared as one. Both read this list,
 * so they cannot disagree about which is which.
 */
export const SUPERVISED_READ_ONLY_TOOLS = new Set([
  "search_gifs",
  "get_current_room",
  "check_repo",
  "check_repo_visibility",
  "read_messages",
  "get_room_history_summary",
  "expand_room_history_summary",
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
  // Removed in letagents 0.12.46; kept so a daemon and an older pinned MCP runtime classify it alike.
  "status_local_codex_session",
  "rental_list_requests",
  "ask_list_files",
  "ask_read_file",
  "ask_search",
]);
