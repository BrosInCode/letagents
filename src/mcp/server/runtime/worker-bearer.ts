export const LETAGENTS_AGENT_SESSION_BEARER_ENV = "LETAGENTS_AGENT_SESSION_BEARER";
export const LETAGENTS_SUPERVISED_BOUNDED_TURNS_ENV = "LETAGENTS_SUPERVISED_BOUNDED_TURNS";

export type WorkerBearerRuntime =
  | { mode: "owner" }
  | { mode: "worker"; bearer: string }
  /**
   * A daemon-supervised bounded turn has no credential in its environment.
   * Each request borrows the current exact-generation worker credential over
   * the local supervisor bridge instead.
   */
  | { mode: "supervised" }
  | { mode: "invalid"; error: string };

export class WorkerBearerRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerBearerRuntimeConfigurationError";
  }
}

export function getWorkerBearerRuntime(): WorkerBearerRuntime {
  const bearer = process.env.LETAGENTS_AGENT_SESSION_BEARER?.trim();
  const supervised = process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS?.trim() === "1";
  if (!bearer && !supervised) return { mode: "owner" };

  if (bearer && supervised) {
    return {
      mode: "invalid",
      error: "Daemon-supervised bounded turns refuse LETAGENTS_AGENT_SESSION_BEARER; credentials must be borrowed from the exact supervisor generation.",
    };
  }

  const apiUrl = process.env.LETAGENTS_API_URL?.trim();
  if (!apiUrl) {
    return {
      mode: "invalid",
      error: "Worker bearer mode requires an explicit LETAGENTS_API_URL.",
    };
  }
  try {
    const parsed = new URL(apiUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    if (parsed.protocol === "http:" && !loopbackHosts.has(parsed.hostname.toLowerCase())) {
      return {
        mode: "invalid",
        error: "Worker bearer mode requires HTTPS unless LETAGENTS_API_URL uses an exact loopback host.",
      };
    }
  } catch {
    return {
      mode: "invalid",
      error: "Worker bearer mode requires LETAGENTS_API_URL to be a valid HTTP(S) URL.",
    };
  }

  if (bearer && process.env.LETAGENTS_TOKEN?.trim()) {
    return {
      mode: "invalid",
      error: "Worker bearer mode refuses LETAGENTS_TOKEN. Remove the owner token from this process before starting the worker.",
    };
  }

  return bearer ? { mode: "worker", bearer } : { mode: "supervised" };
}

export function requireValidWorkerBearerRuntime(): WorkerBearerRuntime {
  const runtime = getWorkerBearerRuntime();
  if (runtime.mode === "invalid") {
    throw new WorkerBearerRuntimeConfigurationError(runtime.error);
  }
  return runtime;
}

export function isSupervisedBoundedTurn(): boolean {
  return requireValidWorkerBearerRuntime().mode === "supervised";
}

export function workerModeDisabledToolResult(
  toolDescription = "This owner-auth onboarding tool",
): Record<string, unknown> | null {
  const runtime = getWorkerBearerRuntime();
  if (runtime.mode === "invalid") {
    return { success: false, error: "worker_bearer_configuration_invalid", message: runtime.error };
  }
  if (runtime.mode === "worker" || runtime.mode === "supervised") {
    return {
      success: false,
      error: runtime.mode === "worker" ? "worker_bearer_mode" : "supervised_bounded_mode",
      message: runtime.mode === "worker"
        ? `${toolDescription} is disabled while LETAGENTS_AGENT_SESSION_BEARER is configured.`
        : `${toolDescription} is disabled during a daemon-supervised bounded turn.`,
    };
  }
  return null;
}

/**
 * Supervised room delivery belongs to the desktop daemon. A bounded provider
 * turn must never recreate the permanent MCP polling loop, even if its prompt
 * asks it to do so.
 */
export function supervisedBoundedDeliveryDisabledToolResult(
  toolName = "wait_for_messages",
): Record<string, unknown> | null {
  if (process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS?.trim() !== "1") {
    return null;
  }
  return {
    success: false,
    error: "supervised_bounded_delivery",
    message: `${toolName} is disabled because supervised room delivery is owned by the desktop daemon.`,
  };
}
