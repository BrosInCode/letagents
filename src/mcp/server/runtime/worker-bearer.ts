export const LETAGENTS_AGENT_SESSION_BEARER_ENV = "LETAGENTS_AGENT_SESSION_BEARER";
export const LETAGENTS_SUPERVISED_BOUNDED_TURNS_ENV = "LETAGENTS_SUPERVISED_BOUNDED_TURNS";

export type WorkerBearerRuntime =
  | { mode: "owner" }
  | { mode: "worker"; bearer: string }
  | { mode: "invalid"; error: string };

export class WorkerBearerRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerBearerRuntimeConfigurationError";
  }
}

export function getWorkerBearerRuntime(): WorkerBearerRuntime {
  const bearer = process.env.LETAGENTS_AGENT_SESSION_BEARER?.trim();
  if (!bearer) {
    return { mode: "owner" };
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

  if (process.env.LETAGENTS_TOKEN?.trim()) {
    return {
      mode: "invalid",
      error: "Worker bearer mode refuses LETAGENTS_TOKEN. Remove the owner token from this process before starting the worker.",
    };
  }

  return { mode: "worker", bearer };
}

export function requireValidWorkerBearerRuntime(): WorkerBearerRuntime {
  const runtime = getWorkerBearerRuntime();
  if (runtime.mode === "invalid") {
    throw new WorkerBearerRuntimeConfigurationError(runtime.error);
  }
  return runtime;
}

export function workerModeDisabledToolResult(
  toolDescription = "This owner-auth onboarding tool",
): Record<string, unknown> | null {
  const runtime = getWorkerBearerRuntime();
  if (runtime.mode === "invalid") {
    return { success: false, error: "worker_bearer_configuration_invalid", message: runtime.error };
  }
  if (runtime.mode === "worker") {
    return {
      success: false,
      error: "worker_bearer_mode",
      message: `${toolDescription} is disabled while LETAGENTS_AGENT_SESSION_BEARER is configured.`,
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
