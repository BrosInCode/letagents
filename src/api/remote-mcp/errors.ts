/** Thrown when a request would exceed the in-flight caps. */
export class RemoteMcpBusyError extends Error {
  constructor(readonly status: 429 | 503, message: string) {
    super(message);
    this.name = "RemoteMcpBusyError";
  }
}

/** Thrown when a session's saved state would exceed its size limit. */
export class RemoteMcpStateTooLargeError extends Error {
  constructor() {
    super("This remote MCP session's saved state is too large. Start a new session.");
    this.name = "RemoteMcpStateTooLargeError";
  }
}
