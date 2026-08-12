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
