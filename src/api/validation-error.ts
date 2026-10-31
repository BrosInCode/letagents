/**
 * Thrown when request-supplied input fails validation. Route handlers map this
 * to a 400 with the message exposed to the client; any other error is treated
 * as internal and returns a 500 with a generic message.
 */
export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

/** No message was committed: retry the same outgoing identity once its root is routed. */
export class MessageRoutingPendingError extends Error {
  constructor() {
    super("The original message is still being routed. Please try again shortly.");
    this.name = "MessageRoutingPendingError";
  }
}
