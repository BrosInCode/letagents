export const CLAUDE_NO_ROOM_REPLY_SENTINEL = "LETAGENTS_NO_ROOM_REPLY";

export type ClaudeEvidenceRecord = Record<string, unknown>;

export type ClaudeExactTurnResult =
  | {
    turnId: string;
    outcome: "reply";
    text: string;
    evidence: "stream" | "transcript";
  }
  | {
    turnId: string;
    outcome: "no_reply";
    text: null;
    evidence: "stream" | "transcript";
  }
  | {
    turnId: string;
    outcome: "unreadable";
    text: null;
    evidence: "none";
  };

export type ClaudeExactTurnFailure = {
  turnId: string;
  error: string;
};

function record(value: unknown): ClaudeEvidenceRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ClaudeEvidenceRecord
    : null;
}

function sessionIdOf(value: ClaudeEvidenceRecord): string | null {
  const candidate = value.session_id ?? value.sessionId;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function exactTextResult(
  turnId: string,
  text: string,
  evidence: "stream" | "transcript",
): ClaudeExactTurnResult {
  const normalized = text.trim();
  if (!normalized) {
    return { turnId, outcome: "unreadable", text: null, evidence: "none" };
  }
  if (normalized === CLAUDE_NO_ROOM_REPLY_SENTINEL) {
    return { turnId, outcome: "no_reply", text: null, evidence };
  }
  return { turnId, outcome: "reply", text: normalized, evidence };
}

export function exactClaudeCommandLifecycleState(
  event: ClaudeEvidenceRecord,
  turnId: string,
  sessionId: string,
): string | null {
  if (
    event.type !== "command_lifecycle"
    || event.command_uuid !== turnId
    || sessionIdOf(event) !== sessionId
  ) {
    return null;
  }
  return typeof event.state === "string" && event.state.trim()
    ? event.state.trim()
    : null;
}

export function exactClaudeStreamTerminal(
  event: ClaudeEvidenceRecord,
  turnId: string,
  sessionId: string,
): ClaudeExactTurnResult | ClaudeExactTurnFailure | null {
  if (
    event.type !== "result"
    || event.user_message_uuid !== turnId
    || sessionIdOf(event) !== sessionId
  ) {
    return null;
  }
  if (event.subtype !== "success" || event.is_error !== false) {
    const errors = Array.isArray(event.errors)
      ? event.errors.filter((value): value is string => typeof value === "string")
      : [];
    return {
      turnId,
      error: errors.join("; ") || `Claude command ended ${String(event.subtype ?? "without success")}.`,
    };
  }
  return exactTextResult(
    turnId,
    typeof event.result === "string" ? event.result : "",
    "stream",
  );
}

function assistantText(row: ClaudeEvidenceRecord): string[] {
  if (row.type !== "assistant") return [];
  const message = record(row.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.flatMap((item) => {
    const part = record(item);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  });
}

function userText(row: ClaudeEvidenceRecord): string[] {
  if (row.type !== "user") return [];
  const message = record(row.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.flatMap((item) => {
    const part = record(item);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  });
}

/**
 * Recover one completed Claude command from its session JSONL.
 *
 * Claude persists the caller-supplied user UUID verbatim. When the session log
 * contains its final assistant API message, `stop_reason=end_turn` is the exact
 * terminal boundary. Recovery deliberately refuses an absent or partial
 * assistant message instead of guessing that it completed.
 */
export function recoverExactClaudeTurnFromSession(
  rows: ClaudeEvidenceRecord[],
  turnId: string,
  sessionId: string,
): ClaudeExactTurnResult | null {
  const sourceIndex = rows.findIndex((row) =>
    row.type === "user"
    && row.uuid === turnId
    && sessionIdOf(row) === sessionId
  );
  if (sourceIndex < 0) return null;

  const nextCommandOffset = rows.slice(sourceIndex + 1).findIndex((row) =>
    row.type === "user"
    && row.uuid !== turnId
    && sessionIdOf(row) === sessionId
    && userText(row).length > 0
  );
  const boundaryIndex = nextCommandOffset < 0
    ? rows.length
    : sourceIndex + nextCommandOffset + 1;
  const turnRows = rows
    .slice(sourceIndex + 1, boundaryIndex)
    .filter((row) => sessionIdOf(row) === sessionId);

  const terminalMessageId = turnRows.reduce<string | null>((terminal, row) => {
    if (terminal || row.type !== "assistant") return terminal;
    const message = record(row.message);
    const messageId = message?.id;
    return message?.stop_reason === "end_turn"
      && typeof messageId === "string"
      && messageId.trim()
      ? messageId
      : null;
  }, null);
  if (!terminalMessageId) return null;

  const text = turnRows.flatMap((row) => {
    const messageId = record(row.message)?.id;
    return messageId === terminalMessageId ? assistantText(row) : [];
  }).join("");
  if (!text.trim()) {
    return { turnId, outcome: "unreadable", text: null, evidence: "none" };
  }

  return exactTextResult(turnId, text, "transcript");
}
