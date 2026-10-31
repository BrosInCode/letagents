import type { ClaudeStartupDeadline } from "../claude-compaction.js";
import type { ProviderProcessExit } from "../provider-evidence.js";

export class ClaudeBootstrapError extends Error {
  readonly name = "ClaudeBootstrapError";
  readonly reason: ClaudeStartupDeadline | "native_exit" | "transport_error" | "failed_response";
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  /** The account's usage limit rejected the turn; retrying only helps after it resets. */
  readonly providerQuotaExhausted?: true;
  /** When Claude said that usage limit resets (epoch ms); absent when it did not say. */
  readonly providerQuotaResetsAtMs?: number;
  /** Claude reported a service-side failure that a fresh attempt may clear. */
  readonly transientProviderStart?: true;

  constructor(
    readonly phase: "init" | "bootstrap_turn",
    failure: ProviderProcessExit | { type: ClaudeStartupDeadline | "failed_response" },
    observations: string,
    apiError: string | null = null,
    limitResetsAtMs: number | null = null,
    /** Plain words for the owner, in place of the boundary that was observed. */
    said: string | null = null,
  ) {
    const reason = failure.type === "exit" ? "native_exit"
      : failure.type === "error" ? "transport_error" : failure.type;
    const prefix = phase === "init" ? "Claude CLI did not report its stream-json init message"
      : "Claude CLI did not complete its daemon-safe bootstrap turn";
    // Preserve the observed boundary without copying native error/result text
    // into supervisor diagnostics. Transport loss is not a physical death proof.
    super(said !== null ? [said, observations].filter(Boolean).join(" ")
      : `${prefix} (${reason}${failure.type === "exit" ? `; exit code ${failure.code ?? "unknown"}; signal ${failure.signal ?? "none"}` : ""}). ${observations}`);
    this.reason = reason;
    if (failure.type === "exit") {
      this.exitCode = failure.code;
      this.signal = failure.signal;
    }
    // Only an explicit API rejection of the bootstrap turn is classified. A
    // deadline stays unretried: a stalled resume can spend tokens each time.
    if (reason === "failed_response" && apiError === "rate_limit") {
      this.providerQuotaExhausted = true;
      if (limitResetsAtMs !== null) this.providerQuotaResetsAtMs = limitResetsAtMs;
    }
    if (reason === "failed_response" && (apiError === "overloaded" || apiError === "server_error")) this.transientProviderStart = true;
  }
}

export class ClaudeRoomTurnRecoveryError extends Error {
  readonly roomTurnRecoveryOutcome = "ambiguous" as const;
}

export class ClaudeRoomTurnObservationDetachedError extends Error {}
