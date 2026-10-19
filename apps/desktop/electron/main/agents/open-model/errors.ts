/** Provider retry notices, OpenCode turn and runtime errors, and safe provider error text. */
import type { ProviderRoomTurnResult } from "../provider-adapter.js";
import { redactCredentialText } from "../provider-evidence.js";
import { messageError, record, type OpenCodeMessage } from "../opencode-server-client.js";

/**
 * Notice that OpenCode is waiting to re-send a failed model request, shown on
 * the desktop that hosts the agent. The daemon classifies stream events by
 * kind and method: a `provider_event` with this method is ordinary working
 * activity. Under typed authority, which Open Model runs under, that is a
 * record and nothing else. It never changes a turn's outcome or a schedule.
 * An `error` kind, or a method that reads as a lifecycle boundary, could mark
 * the turn failed or idle.
 */
export const OPEN_MODEL_PROVIDER_RETRY_METHOD = "letagents/providerRetry";

/** Shown in the chat view, so it carries no provider text. */
export function openModelProviderRetrySummary(attempt: number): string {
  return `The model provider returned an error. Retrying (attempt ${attempt}).`;
}

export type OpenCodeRetryStatus = { attempt: number; message: string | null; next: number | null };

export function openCodeRetryStatus(value: unknown): OpenCodeRetryStatus | null {
  const status = record(value);
  if (status?.type !== "retry") return null;
  const attempt = status.attempt;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) return null;
  return {
    attempt,
    message: typeof status.message === "string" ? status.message : null,
    next: typeof status.next === "number" && Number.isFinite(status.next) ? status.next : null,
  };
}

export class OpenCodeBoundedTurnError extends Error {
  readonly roomTurnRecoveryOutcome = "ambiguous" as const;
}

/**
 * The fresh OpenCode server did not finish starting inside the launch budget:
 * either it never answered health checks, or it answered them and then did
 * not prepare its first session. The launch was terminated, nothing durable
 * changed, and another attempt is expected to succeed — the daemon may retry
 * automatically. The phase keeps the two failures distinguishable, because
 * they have different causes.
 */
export class OpenCodeStartTimeoutError extends Error {
  readonly transientProviderStart = true;

  constructor(readonly phase: "health" | "session" = "health") {
    super(phase === "session"
      ? "Timed out waiting for the supervised OpenCode server to prepare its first session."
      : "Timed out waiting for the supervised OpenCode server.");
    this.name = "OpenCodeStartTimeoutError";
  }
}

/**
 * The saved OpenCode process is provably gone — attach returned terminal
 * identity, so resume can never reattach it. This continuation cannot be
 * recovered; the daemon must start a fresh runtime generation rather than
 * retry resume against a corpse. Distinct from an unverifiable process (see
 * resume() below), which may still be alive and is worth a bounded retry.
 */
export class OpenCodeRuntimeGoneError extends Error {
  readonly providerRuntimeGone = true;

  constructor() {
    super("The saved OpenCode process is no longer running.");
    this.name = "OpenCodeRuntimeGoneError";
  }
}

export class OpenCodeTerminalTurnError extends Error {
  // A provider-declared terminal error is authoritative evidence that this
  // exact turn produced no publishable answer. The exact result is checkpointed
  // before this error leaves the adapter so delivery can settle without replay.
  readonly roomTurnRecoveryOutcome = "terminal_failure" as const;

  constructor(
    message: string,
    readonly terminalResult: (Extract<ProviderRoomTurnResult, { providerContinuationId: string }> & {
      outcome: "failed";
    }) | null,
  ) {
    super(message);
    this.name = "OpenCodeTerminalTurnError";
  }
}

export function safeProviderErrorMessage(message: OpenCodeMessage | null): string | null {
  const failure = messageError(message);
  if (!failure) return null;
  const status = failure.statusCode ? ` (HTTP ${failure.statusCode})` : "";
  if (failure.statusCode === 402 || failure.statusCode === 403) {
    // A 402 can announce a promotion ending rather than insufficient credit;
    // a 403 can require account attestation or model access. Preserve the
    // explanation without credentials or arbitrary provider-supplied URLs.
    const detail = redactCredentialText(failure.message ?? "").value
      .replace(/https?:\/\/\S+/gi, "provider settings")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);
    if (failure.statusCode === 402) {
      return `Open Model request was rejected by the provider${status}${detail ? `: ${detail}` : ". The provider did not include an explanation."}`;
    }
    return `Open Model access was denied by the provider${status}${detail ? `: ${detail}` : ". Check the provider's account requirements and model permissions, then retry the unfinished work in LetAgents."}`;
  }
  if (failure.statusCode === 401) {
    return `Open Model authentication or model access was rejected by the provider${status}. Check the API key and model access, then retry the unfinished work in LetAgents.`;
  }
  if (failure.statusCode === 429) {
    return `Open Model was rate-limited by the model provider${status}. Wait for the provider limit to reset, then retry the unfinished work in LetAgents.`;
  }
  const detail = redactCredentialText(failure.message ?? "").value
    .replace(/https?:\/\/\S+/gi, "provider settings")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
  return `Open Model request failed at the model provider${status}${detail ? `: ${detail}` : "."}`;
}
