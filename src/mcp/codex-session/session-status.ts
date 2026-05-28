import type { CodexLiveSessionState } from "../local-state.js";
import type {
  ThreadReadResult,
  ThreadReadTurn,
  ThreadReadTurnItem,
} from "./rpc-client.js";

const DEFAULT_STARTUP_OBSERVATION_MS = 8_000;
export const STARTUP_POLL_INTERVAL_MS = 500;

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

export function summarizeItems(items: ThreadReadTurnItem[] | undefined): Array<Record<string, unknown>> {
  return (items ?? []).slice(-6).map((item) => {
    if (item.type === "agentMessage") {
      return { type: item.type, phase: item.phase, text: item.text ?? null };
    }

    if (item.type === "userMessage") {
      return {
        type: item.type,
        text: (item.content ?? []).map((part) => part.text ?? "").join("\n"),
      };
    }

    return { type: item.type ?? "unknown" };
  });
}

export function deriveCodexLiveSessionStatus(
  session: CodexLiveSessionState,
  serverReachable: boolean,
  threadStatus: string | null,
  turnStatus: string | null
): CodexLiveSessionState["status"] {
  if (threadStatus === "systemError" || threadStatus === "error" || turnStatus === "failed") {
    return "failed";
  }

  if (turnStatus === "completed") {
    return "completed";
  }

  if (turnStatus === "interrupted") {
    return "interrupted";
  }

  if (turnStatus === "inProgress" || threadStatus === "active") {
    return "running";
  }

  if (!serverReachable) {
    return session.status === "completed" || session.status === "interrupted"
      ? session.status
      : "unknown";
  }

  if (session.status === "starting") {
    return "starting";
  }

  return session.status;
}

export function isTerminalCodexSessionStatus(status: CodexLiveSessionState["status"]): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
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
