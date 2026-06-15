import type {
  DesktopManagedAgentDeliveryMode,
  DesktopManagedAgentStopInput,
  DesktopManagedAgentSessionStatus,
} from "../../ipc-types.js";
import type {
  ThreadReadResult,
  ThreadReadTurn,
  ThreadReadTurnItem,
} from "./codex-rpc-client.js";

export const STARTUP_POLL_INTERVAL_MS = 500;
const DEFAULT_STARTUP_OBSERVATION_MS = 8_000;
const MAX_PUBLIC_ITEM_TEXT_LENGTH = 420;
const INTERNAL_ITEM_TYPE_PATTERN = /(reason|thought|think|chain|tool|exec|patch|diff|command|event|system|debug|log|trace|plan)/i;

function compactPublicText(value: string | null | undefined): string | null {
  const compact = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) {
    return null;
  }

  return compact.length > MAX_PUBLIC_ITEM_TEXT_LENGTH
    ? `${compact.slice(0, MAX_PUBLIC_ITEM_TEXT_LENGTH - 3).trimEnd()}...`
    : compact;
}

export function extractTurnStatus(turn: ThreadReadTurn | null | undefined): string | null {
  if (!turn) {
    return null;
  }

  if (typeof turn.status === "string") {
    return turn.status;
  }

  if (turn.status && typeof turn.status === "object" && "status" in turn.status) {
    return typeof turn.status.status === "string" ? turn.status.status : null;
  }

  return null;
}

export function extractThreadStatus(thread: ThreadReadResult["thread"] | undefined): string | null {
  if (!thread?.status) {
    return null;
  }

  if (typeof thread.status === "string") {
    return thread.status;
  }

  return typeof thread.status.type === "string" ? thread.status.type : null;
}

export function isActiveCodexTurnStatus(status: string | null | undefined): boolean {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized === "inprogress" ||
    normalized === "active" ||
    normalized === "running" ||
    normalized === "queued" ||
    normalized === "pending" ||
    normalized === "cancelling";
}

export function summarizeItems(items: ThreadReadTurnItem[] | undefined): Array<Record<string, unknown>> {
  const publicItems: Array<Record<string, unknown>> = [];

  for (const item of items ?? []) {
    const type = String(item.type ?? "unknown");
    const phase = String(item.phase ?? "");
    if (INTERNAL_ITEM_TYPE_PATTERN.test(type) || INTERNAL_ITEM_TYPE_PATTERN.test(phase)) {
      continue;
    }

    if (item.type === "agentMessage") {
      const text = compactPublicText(item.text);
      if (text) {
        publicItems.push({ type: "agentMessage", phase: item.phase ?? null, text });
      }
      continue;
    }

    if (item.type === "userMessage") {
      const text = compactPublicText((item.content ?? []).map((part) => part.text ?? "").join("\n"));
      if (text) {
        publicItems.push({ type: "userMessage", text });
      }
      continue;
    }

    if (type !== "unknown") {
      publicItems.push({ type });
    }
  }

  return publicItems.slice(-6);
}

export function deriveCodexLiveSessionStatus(
  currentStatus: DesktopManagedAgentSessionStatus,
  serverReachable: boolean,
  threadStatus: string | null,
  turnStatus: string | null,
): DesktopManagedAgentSessionStatus {
  if (threadStatus === "systemError" || threadStatus === "error" || turnStatus === "failed") {
    return "failed";
  }

  if (turnStatus === "completed") {
    return "completed";
  }

  if (turnStatus === "interrupted") {
    return "interrupted";
  }

  if (isActiveCodexTurnStatus(turnStatus) || threadStatus === "active") {
    return "running";
  }

  if (!serverReachable) {
    return currentStatus === "completed" || currentStatus === "interrupted"
      ? currentStatus
      : "unknown";
  }

  if (currentStatus === "starting") {
    return "starting";
  }

  return currentStatus;
}

export function isTerminalCodexSessionStatus(status: DesktopManagedAgentSessionStatus): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

export function codexSessionStatusAfterTurnInterrupt(
  deliveryMode: DesktopManagedAgentDeliveryMode,
  serverReachable: boolean,
  shutdownServer: boolean,
): DesktopManagedAgentSessionStatus {
  if (deliveryMode === "desktop_events" && !shutdownServer) {
    return serverReachable ? "running" : "unknown";
  }
  return "interrupted";
}

export function codexSessionStatusAfterStopAttempt(
  deliveryMode: DesktopManagedAgentDeliveryMode,
  serverReachable: boolean,
  shutdownServer: boolean,
  interruptSucceeded: boolean,
): DesktopManagedAgentSessionStatus {
  if (serverReachable && !interruptSucceeded && !shutdownServer) {
    return "unknown";
  }

  return codexSessionStatusAfterTurnInterrupt(deliveryMode, serverReachable, shutdownServer);
}

export function shouldShutdownManagedAgentOnStop(
  input: DesktopManagedAgentStopInput = {},
): boolean {
  return input.stopMode === "worker" || Boolean(input.shutdownServer);
}

export function parseStartupObservationMs(): number {
  const parsed = Number.parseInt(process.env.LETAGENTS_CODEX_STARTUP_OBSERVATION_MS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STARTUP_OBSERVATION_MS;
  }

  return parsed;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isLikelyMaterializingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("not materialized yet");
}
