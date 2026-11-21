import type { RpcNotification, ThreadReadTurnItem } from "./codex-rpc-client.js";

const CODEX_RUNTIME_STREAM_SOURCE = "codex_app_server";

export type CodexRuntimeReasoningStatus = "idle" | "working" | "reviewing" | "blocked";

export type CodexRuntimeReasoningSummary = {
  summary: string;
  status: CodexRuntimeReasoningStatus;
  checking: string;
  next_action: string;
};

const codexReasoningStreams = new Map<string, Map<number, string>>();

function statusForCodexRuntimeMethod(method: string): CodexRuntimeReasoningStatus {
  if (/blocked|error|failed/i.test(method)) return "blocked";
  if (/completed|finished|done|stopped|interrupted/i.test(method)) return "idle";
  return "working";
}

function notificationRecord(notification: RpcNotification): Record<string, unknown> {
  return notification.params && typeof notification.params === "object"
    ? notification.params as Record<string, unknown>
    : {};
}

function compactRuntimeParam(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const item = typeof record.item === "object" && record.item
    ? record.item as Record<string, unknown>
    : record;
  const type = typeof item.type === "string" ? item.type : null;
  const name = typeof item.name === "string"
    ? item.name
    : typeof item.command === "string"
      ? item.command
      : null;
  if (type && name) return `${type}: ${name}`;
  return type || name;
}

function reasoningStreamKey(record: Record<string, unknown>): string | null {
  const threadId = typeof record.threadId === "string" ? record.threadId : "";
  const turnId = typeof record.turnId === "string" ? record.turnId : "";
  const item = record.item && typeof record.item === "object"
    ? record.item as Record<string, unknown>
    : null;
  const itemId = typeof record.itemId === "string"
    ? record.itemId
    : typeof item?.id === "string"
      ? item.id
      : "";
  return threadId && turnId && itemId ? `${threadId}:${turnId}:${itemId}` : null;
}

function ensureReasoningStream(key: string): Map<number, string> {
  const existing = codexReasoningStreams.get(key);
  if (existing) return existing;
  const next = new Map<number, string>();
  codexReasoningStreams.set(key, next);
  return next;
}

function coerceReasoningSummaryParts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .map((part) => part.trim())
    .filter(Boolean);
}

function reasoningSummaryFromStream(stream: Map<number, string>): string {
  return [...stream.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function visibleItemType(item: ThreadReadTurnItem | null | undefined): string {
  return String(item?.type ?? "");
}

function visibleItemText(item: ThreadReadTurnItem | null | undefined): string {
  return String(item?.text ?? "").trim();
}

export function summarizeCodexReasoningNotification(
  notification: RpcNotification,
): CodexRuntimeReasoningSummary | null {
  const method = notification.method.trim();
  if (!method.startsWith("item/reasoning/") && method !== "item/started" && method !== "item/completed") {
    return null;
  }

  const record = notificationRecord(notification);
  const item = record.item && typeof record.item === "object"
    ? record.item as Record<string, unknown>
    : null;
  const itemType = typeof item?.type === "string" ? item.type : "";
  if ((method === "item/started" || method === "item/completed") && itemType !== "reasoning") {
    return null;
  }

  const key = reasoningStreamKey(record);
  if (!key) {
    return null;
  }

  if (method === "item/reasoning/summaryTextDelta") {
    const summaryIndex = typeof record.summaryIndex === "number" ? record.summaryIndex : 0;
    const delta = typeof record.delta === "string" ? record.delta : "";
    const stream = ensureReasoningStream(key);
    stream.set(summaryIndex, `${stream.get(summaryIndex) ?? ""}${delta}`);
    const summary = reasoningSummaryFromStream(stream);
    return {
      summary: summary || "Codex reasoning summary is streaming.",
      status: "working",
      checking: `${CODEX_RUNTIME_STREAM_SOURCE}: readable reasoning summary`,
      next_action: "Continue streaming the Codex reasoning summary.",
    };
  }

  if (method === "item/reasoning/summaryPartAdded") {
    const summaryIndex = typeof record.summaryIndex === "number" ? record.summaryIndex : 0;
    const stream = ensureReasoningStream(key);
    stream.set(summaryIndex, stream.get(summaryIndex) ?? "");
    return {
      summary: reasoningSummaryFromStream(stream) || "Codex started a new reasoning summary section.",
      status: "working",
      checking: `${CODEX_RUNTIME_STREAM_SOURCE}: reasoning summary section ${summaryIndex + 1}`,
      next_action: "Continue streaming the Codex reasoning summary.",
    };
  }

  if (method === "item/reasoning/textDelta") {
    return {
      summary: "Codex raw reasoning text is streaming.",
      status: "working",
      checking: "Raw reasoning text is available from Codex app-server but hidden by LetAgents by default.",
      next_action: "Wait for readable reasoning summary deltas or other runtime progress.",
    };
  }

  const stream = ensureReasoningStream(key);
  const summaryParts = coerceReasoningSummaryParts(item?.summary);
  if (summaryParts.length) {
    summaryParts.forEach((part, index) => stream.set(index, part));
  }
  const summary = reasoningSummaryFromStream(stream);
  const completed = method === "item/completed";
  if (completed) {
    codexReasoningStreams.delete(key);
  }

  return {
    summary: summary || (completed ? "Codex reasoning summary completed." : "Codex reasoning summary started."),
    status: completed ? "idle" : "working",
    checking: `${CODEX_RUNTIME_STREAM_SOURCE}: readable reasoning item`,
    next_action: completed ? "Waiting for the next Codex runtime event." : "Streaming readable Codex reasoning.",
  };
}

export function summarizeCodexRuntimeNotification(
  notification: RpcNotification,
): CodexRuntimeReasoningSummary {
  const reasoningSummary = summarizeCodexReasoningNotification(notification);
  if (reasoningSummary) {
    return reasoningSummary;
  }

  const method = notification.method.trim();
  const detail = compactRuntimeParam(notification.params);
  const readableMethod = method.replaceAll("/", " ");
  const status = statusForCodexRuntimeMethod(method);
  const suffix = detail ? ` (${detail})` : "";

  if (/^thread\//i.test(method)) {
    return {
      summary: `Codex ${readableMethod}${suffix}`,
      status,
      checking: `${CODEX_RUNTIME_STREAM_SOURCE}: ${method}`,
      next_action: status === "idle" ? "Waiting for the next room event." : "Continuing the Codex worker turn.",
    };
  }

  if (/^turn\//i.test(method)) {
    return {
      summary: `Codex ${readableMethod}${suffix}`,
      status,
      checking: `${CODEX_RUNTIME_STREAM_SOURCE}: ${method}`,
      next_action: status === "idle" ? "Turn finished; waiting for room activity." : "Streaming turn progress.",
    };
  }

  if (/^item\//i.test(method)) {
    return {
      summary: `Codex ${readableMethod}${suffix}`,
      status,
      checking: detail ? `Handling ${detail}.` : `${CODEX_RUNTIME_STREAM_SOURCE}: ${method}`,
      next_action: status === "idle" ? "Waiting for the next runtime item." : "Continuing runtime work.",
    };
  }

  return {
    summary: `Codex runtime event: ${readableMethod}${suffix}`,
    status,
    checking: `${CODEX_RUNTIME_STREAM_SOURCE}: ${method}`,
    next_action: status === "idle" ? "Waiting for the next runtime event." : "Continuing runtime work.",
  };
}

export function summarizeCodexRuntimeSnapshot(input: {
  turnStatus?: unknown;
  threadStatus?: unknown;
  recentItems?: ThreadReadTurnItem[];
}): CodexRuntimeReasoningSummary | null {
  const recentItems = input.recentItems ?? [];
  const latestItem = [...recentItems].reverse().find((item) => {
    const type = visibleItemType(item);
    return type === "agentMessage" || type === "userMessage";
  });
  const latestText = visibleItemText(latestItem);
  const latestType = visibleItemType(latestItem);
  const turnStatus = typeof input.turnStatus === "string" ? input.turnStatus : "";
  const threadStatus = typeof input.threadStatus === "string" ? input.threadStatus : "";
  const status = statusForCodexRuntimeMethod(`${threadStatus} ${turnStatus} ${latestType}`);

  if (latestText) {
    return {
      summary: latestType === "agentMessage" ? latestText : "Codex worker received room input.",
      status,
      checking: latestType === "agentMessage"
        ? "Latest Codex worker message from app-server snapshot."
        : latestText,
      next_action: status === "idle" ? "Waiting for the next room event." : "Continuing the Codex worker turn.",
    };
  }

  if (turnStatus || threadStatus) {
    const statusText = [threadStatus && `thread ${threadStatus}`, turnStatus && `turn ${turnStatus}`]
      .filter(Boolean)
      .join(", ");
    return {
      summary: `Codex worker ${statusText}.`,
      status,
      checking: `${CODEX_RUNTIME_STREAM_SOURCE}: snapshot`,
      next_action: status === "idle" ? "Waiting for the next room event." : "Monitoring Codex worker progress.",
    };
  }

  return null;
}
