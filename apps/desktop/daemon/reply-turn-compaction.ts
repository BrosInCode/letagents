import type { ProviderActionStreamEvent } from "./provider-action-port.js";

export type ReplyTurnCompactionProof = {
  providerContinuationId: string;
  providerTurnId: string;
  /** A completion or retirement observed while authority is checked cancels this hint. */
  isCompacting(): boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function identity(value: unknown): string | null {
  return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value) ? value : null;
}

/**
 * A scheduling hint from the current handle's native Codex stream. This is
 * neither lifecycle authority nor a completion: delivery must separately
 * prove its exact durable binding before yielding the reserved reply slot.
 */
export class ReplyTurnCompactionObserver {
  private admittedTurn: string | null = null;
  private compacting: { turn: string; item: string } | null = null;
  private terminalTurn: string | null = null;
  private closed = false;
  private attempted = false;

  constructor(private readonly scope: { workAttemptId: string; providerContinuationId: string },
    private readonly onCompaction: (proof: ReplyTurnCompactionProof) => void) {}

  /** A native event can race the turn/start response and its durable checkpoint. */
  admit(providerTurnId: string): void {
    this.admittedTurn = providerTurnId;
    if (this.terminalTurn === providerTurnId) this.close();
    this.maybeYield();
  }

  observe(event: ProviderActionStreamEvent): void {
    if (this.closed || event.provider !== "codex" || event.workAttemptId !== this.scope.workAttemptId
      || event.providerContinuationId !== this.scope.providerContinuationId
      || event.payloadTruncated || event.payloadRedacted || event.lifecycleProjectionOnly) return;
    if (event.method !== "item/started" && event.method !== "item/completed"
      && !/^turn\/(?:completed|interrupted|failed|cancelled|stopped)$/.test(event.method)) return;
    const params = record(event.payload);
    const turn = record(params?.turn);
    const providerTurnId = identity(params?.turnId ?? turn?.id);
    if (!params || params.threadId !== this.scope.providerContinuationId || !providerTurnId
      || (params.turnId !== undefined && turn?.id !== undefined && params.turnId !== turn.id)) return;
    if (/^turn\/(?:completed|interrupted|failed|cancelled|stopped)$/.test(event.method)) {
      this.terminalTurn = providerTurnId;
      if (this.compacting?.turn === providerTurnId) this.compacting = null;
      if (this.admittedTurn === providerTurnId) this.close();
      return;
    }
    if (event.method !== "item/started" && event.method !== "item/completed") return;
    const item = record(params.item);
    const itemId = identity(item?.id);
    if (item?.type !== "contextCompaction" || !itemId) return;
    if (event.method === "item/completed") {
      if (this.compacting?.turn === providerTurnId && this.compacting.item === itemId) this.compacting = null;
      return;
    }
    // Only one native turn runs on this handle. A mismatched event cannot
    // replace the exact admitted turn's evidence.
    if (this.admittedTurn && this.admittedTurn !== providerTurnId) return;
    this.compacting = { turn: providerTurnId, item: itemId };
    this.maybeYield();
  }

  close(): void { this.closed = true; this.compacting = null; }

  private maybeYield(): void {
    const current = this.compacting;
    if (this.closed || this.attempted || !current || current.turn !== this.admittedTurn) return;
    this.attempted = true; // Lost hints use the existing release deadline, never a new retry loop.
    this.onCompaction({ providerContinuationId: this.scope.providerContinuationId, providerTurnId: current.turn,
      isCompacting: () => !this.closed && this.compacting?.turn === current.turn && this.compacting.item === current.item });
  }
}
