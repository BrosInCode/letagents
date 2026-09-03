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
  if (message.type !== "tool_call") return [];
  if (message.subtype !== "started" && message.subtype !== "completed") return [];
  if (typeof message.call_id !== "string" || !message.call_id.trim()) return [];
  const toolCalls = record(message.tool_call);
  if (!toolCalls) return [];
  // Metadata may also be object-valued. Exactly one documented tool envelope
  // is required so a new or malformed native variant cannot choose a card
  // arbitrarily while typed execution evidence correctly remains unavailable.
  const toolEntries = Object.entries(toolCalls)
    .filter(([key, value]) => /ToolCall$/.test(key) && record(value));
  if (toolEntries.length !== 1) return [];
  const [tool, rawCall] = toolEntries[0]!;
  const call = record(rawCall)!;
  const result = record(call.result);
  const failure = result && (Object.hasOwn(result, "error")
    ? result.error
    : Object.hasOwn(result, "failure") ? result.failure : undefined);
  const completed = message.subtype === "completed";
  const error = completed ? toolError(failure) : null;
  const output = completed && result && Object.hasOwn(result, "success")
    ? result.success
    : completed && failure === undefined ? call.result ?? null : null;
  return [{
    method: "item/toolCall/updated",
    kind: "tool_lifecycle",
    payload: {
      callID: `cursor:${exactTurnNamespace}:${message.call_id.trim()}`,
      tool,
      status: error ? "error" : completed ? "completed" : "running",
      input: call.args ?? null,
      output,
      error,
    },
  }];
}
