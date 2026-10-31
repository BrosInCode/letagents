export class SupervisorDaemonProtocolMismatchError extends Error {
  constructor(readonly clientVersion: number, readonly daemonVersion: number, message: string) {
    super(message);
  }
}

export class SupervisorDaemonRequestTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`Supervisor daemon request timed out: ${method}`);
  }
}

export function isConnectionUnavailable(error: unknown): boolean {
  return ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}
