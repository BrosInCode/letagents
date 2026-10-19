import type { ThreadReadResult, ThreadReadTurn } from "./codex-rpc-client.js";

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
