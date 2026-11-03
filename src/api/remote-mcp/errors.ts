/** Thrown when a request would exceed the in-flight caps. */
export class RemoteMcpBusyError extends Error {
  constructor(readonly status: 429 | 503, message: string) {
    super(message);
    this.name = "RemoteMcpBusyError";
  }
}

/** Thrown when a session's or credential's saved state would exceed its size limit. */
export class RemoteMcpStateTooLargeError extends Error {
  constructor() {
    super("The saved remote MCP state is too large. End workers you no longer use with disconnect_agent_session, then retry.");
    this.name = "RemoteMcpStateTooLargeError";
  }
}
