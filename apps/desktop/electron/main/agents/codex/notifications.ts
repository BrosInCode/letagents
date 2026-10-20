/** Pure helpers that read Codex app-server notifications: stream kinds, lifecycle status, error summaries and turn keys. */
import type { RpcNotification } from "../codex-rpc-client.js";
import { extractTurnStatus } from "../codex-session-status.js";
import type { ProviderStreamEventKind } from "../provider-adapter.js";
import { safeStreamPayload } from "../provider-evidence.js";

export function isCodexExecutionMethod(method: string): boolean {
  return /^(?:item\/|command\/exec(?:\/|$))/i.test(method);
}

export function streamKind(method: string): ProviderStreamEventKind {
  if (/(?:approval|requestApproval|guardian)/i.test(method)) return "approval";
  // Preserve execution identity even when a command/tool reports failure.
  // Runtime process errors still go through the error classifier below.
  if (isCodexExecutionMethod(method)) {
    if (/(?:mcpToolCall|toolCall|fileChange|webSearch)/i.test(method)) return "tool_lifecycle";
    if (/(?:command|process|terminal)/i.test(method)) return "command_output";
  }
  // A failed turn is still turn lifecycle evidence. Keep its identity ahead of
  // the generic error label so daemon policy cannot mistake it for app-server
  // failure.
  if (/^turn\//.test(method)) return "turn_lifecycle";
  if (/(?:error|warning|failed)/i.test(method)) return "error";
  if (/(?:usage|tokenUsage|rateLimit)/i.test(method)) return "usage";
  if (/(?:mcpToolCall|toolCall|fileChange|webSearch)/i.test(method)) return "tool_lifecycle";
  if (/(?:command|process|terminal)/i.test(method)) return "command_output";
  if (/(?:delta|transcript)/i.test(method)) return "text_delta";
  if (/^item\//.test(method)) return "item_lifecycle";
  return "provider_event";
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function terminalTurnOutcome(
  method: string,
  turn: Record<string, unknown> | null,
): "completed" | "failed" | "interrupted" | null {
  const terminal = /^turn\/(completed|failed|interrupted|cancelled|stopped)$/i.exec(method)?.[1]?.toLowerCase();
  if (!terminal) return null;
  if (terminal === "failed") return "failed";
  if (terminal !== "completed") return "interrupted";
  const status = extractTurnStatus(turn)?.trim().toLowerCase() ?? null;
  if (status === "completed" || status === "failed") return status;
  return /^(?:interrupted|cancelled|stopped)$/.test(status ?? "") ? "interrupted" : null;
}

export function transcriptLifecycleTurn(value: unknown): { id: unknown; status: unknown } | null {
  const turn = recordValue(value);
  return turn ? { id: turn.id, status: turn.status } : null;
}

export function codexLifecycleStatus(value: unknown): "failed" | "idle" | "working" | null {
  const root = recordValue(value);
  if (!root) return null;
  const candidates = [
    root.status,
    root.threadStatus,
    root.turnStatus,
    recordValue(root.thread)?.status,
    recordValue(root.turn)?.status,
  ].flatMap((candidate) => {
    const nested = recordValue(candidate);
    return [candidate, nested?.type, nested?.status];
  });
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    if (/^(?:systemError|error|failed)$/i.test(candidate)) return "failed";
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    if (/^(?:completed|interrupted|idle|stopped)$/i.test(candidate)) return "idle";
    if (/^(?:active|inProgress|running|queued|pending)$/i.test(candidate)) return "working";
  }
  return null;
}

/**
 * The provider's own reason for a failed turn, for the `error` notification
 * the app-server sends before `turn/completed`. It is the one line the owner
 * needs in this agent's activity; the generic summary only said "error". The
 * activity is local to the owner's machine and is never posted to the room.
 */
export function codexErrorActivitySummary(notification: RpcNotification): string | null {
  if (notification.method !== "error") return null;
  const message = recordValue(recordValue(notification.params)?.error)?.message;
  if (typeof message !== "string" || !message.trim()) return null;
  const safe = safeStreamPayload(message.replace(/\s+/g, " ").trim()).payload;
  return typeof safe === "string" ? `Codex error: ${safe}`.slice(0, 500) : null;
}

/**
 * The provider declined the turn's content. Unlike a rate limit or a rejected
 * key, neither a retry nor the owner can make the same content go through.
 */
export function isCodexPolicyRefusal(codexErrorInfo: unknown): boolean {
  return codexErrorInfo === "cyberPolicy" || codexErrorInfo === "misalignmentPolicyViolation";
}

/**
 * How long after a thread reports `systemError` its turn's own ending is
 * awaited before the ending is read from the thread instead. The app-server
 * sends the two within milliseconds of each other.
 */
export const CODEX_SYSTEM_ERROR_SETTLE_MS = 2_000;

/**
 * A thread is between turns when it is `idle`, and also when it is in
 * `systemError`: that is what a failed turn leaves on its thread, and the
 * app-server keeps reporting it until the thread's next turn starts. Waiting
 * for `idle` there waits for the turn this boundary is asked in order to allow.
 */
export function isCodexThreadBetweenTurns(status: string | null): boolean {
  return status === "idle" || status === "systemError";
}

export function hasExplicitCodexSystemError(value: unknown): boolean {
  const root = recordValue(value);
  if (!root) return false;
  const candidates = [root.status, root.threadStatus, recordValue(root.thread)?.status]
    .flatMap((candidate) => {
      const nested = recordValue(candidate);
      return [candidate, nested?.type, nested?.status];
    });
  return candidates.some((candidate) => typeof candidate === "string"
    && /^(?:systemError|error_during_execution)$/i.test(candidate));
}

export function notificationTurnId(value: unknown): string | null {
  const root = recordValue(value);
  const nested = recordValue(root?.turn);
  const candidate = root?.turnId ?? root?.turn_id ?? nested?.id;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

export function notificationThreadId(value: unknown): string | null {
  const root = recordValue(value);
  const nested = recordValue(root?.thread);
  const candidate = root?.threadId ?? root?.thread_id ?? nested?.id;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

export function exactTurnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

export function exactPermissionItemKey(threadId: string, turnId: string, itemId: string): string {
  return JSON.stringify([threadId, turnId, itemId]);
}
