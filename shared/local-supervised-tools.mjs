// One catalog for supervised local discovery and storage dispatch. Aliases share
// an operation; handler completeness is checked when the local executor loads.
const operations = Object.freeze({
  get_current_room: "get_current_room", read_messages: "read_messages",
  send_message: "send_message", send_thread_message: "send_message",
  post_status: "send_message", post_reasoning: "send_message",
  get_board: "get_board", create_task: "add_task", add_task: "add_task",
  claim_task: "claim_task", complete_task: "update_task", update_task: "update_task",
  release_task_lease: "change_task_lease", handoff_task_lease: "change_task_lease",
  claim_task_review: "claim_task_review", get_room_artifacts: "get_room_artifacts",
  publish_room_artifact: "publish_room_artifact", get_message_thread: "get_message_thread",
});

export function localSupervisedRoomToolOperation(name) {
  return Object.hasOwn(operations, name) ? operations[name] : null;
}

export function localSupervisedRoomToolAvailable(name) {
  // Turn controls are handled by the daemon. Local room moves are unsupported.
  return name === "complete_room_turn" || name === "set_reply_thread" || localSupervisedRoomToolOperation(name) !== null;
}

export function defineLocalSupervisedToolHandlers(handlers) {
  const required = new Set(Object.values(operations));
  if (Object.keys(handlers).length !== required.size
    || Object.keys(handlers).some(name => !required.has(name))
    || [...required].some(name => typeof handlers[name] !== "function")) {
    throw new Error("Local room handlers do not match the advertised tool contract.");
  }
  return Object.freeze(handlers);
}
