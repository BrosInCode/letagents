import {
  cursorNativeToolEnvelope,
  cursorNativeToolTerminalResult,
} from "./cursor-native-tool.js";

type CursorLiveDisplayProjection = {
  method: "item/agentMessage/delta" | "item/toolCall/updated";
  kind: "text_delta" | "tool_lifecycle";
  payload: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toolError(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  try { return JSON.stringify(value, null, 2); }
  catch { return "Cursor reported an unreadable tool error."; }
}

/** Project already-redacted Cursor evidence into provider-neutral display events. */
export function cursorLiveDisplayProjections(
  safeProviderPayload: unknown,
  exactTurnNamespace: string,
  eventNamespace: string,
): CursorLiveDisplayProjection[] {
  const message = record(safeProviderPayload);
  if (!message || !exactTurnNamespace) return [];
  if (message.type === "assistant") {
    const body = record(message.message);
    if (body?.role !== "assistant") return [];
    const delta = typeof body.content === "string"
      ? body.content
      : Array.isArray(body.content)
        ? body.content.flatMap((candidate) => {
          const block = record(candidate);
          return block?.type === "text" && typeof block.text === "string" && block.text
            ? [block.text]
            : [];
        }).join("")
        : "";
    return delta
      ? [{
        method: "item/agentMessage/delta",
        kind: "text_delta",
        payload: {
          partId: `cursor:${exactTurnNamespace}:assistant:${eventNamespace}`,
          delta,
        },
      }]
      : [];
  }
  const nativeTool = cursorNativeToolEnvelope(message);
  if (!nativeTool) return [];
  const { executionId, subtype, tool, call } = nativeTool;
  const terminal = subtype === "completed" ? cursorNativeToolTerminalResult(nativeTool) : null;
  if (subtype === "completed" && !terminal) return [];
  const error = terminal && terminal.outcome !== "succeeded"
    ? toolError(terminal.detail)
    : null;
  const output = terminal?.outcome === "succeeded" ? terminal.detail : null;
  return [{
    method: "item/toolCall/updated",
    kind: "tool_lifecycle",
    payload: {
      callID: `cursor:${exactTurnNamespace}:${executionId}`,
      tool,
      status: terminal
        ? terminal.outcome === "succeeded" ? "completed" : "error"
        : "running",
      input: call.args ?? null,
      output,
      error,
    },
  }];
}
