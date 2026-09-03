import { nativeExecutionId } from "./provider-execution-observer.js";

const CURSOR_NATIVE_OPERATIONS = {
  shellToolCall: "command",
  readToolCall: "file_read",
  writeToolCall: "file_change",
} as const;

export type CursorNativeToolEnvelope = {
  executionId: string;
  tool: keyof typeof CURSOR_NATIVE_OPERATIONS;
  operation: (typeof CURSOR_NATIVE_OPERATIONS)[keyof typeof CURSOR_NATIVE_OPERATIONS];
  call: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Exact structural contract shared by typed facts and local live display. */
export function cursorNativeToolEnvelope(message: Record<string, unknown>): CursorNativeToolEnvelope | null {
  if (message.type !== "tool_call"
    || (message.subtype !== "started" && message.subtype !== "completed")
    || !nativeExecutionId(message.call_id)) return null;
  const calls = record(message.tool_call);
  if (!calls) return null;
  const toolKeys = Object.keys(calls).filter((key) => key.endsWith("ToolCall"));
  if (toolKeys.length !== 1) return null;
  const tool = toolKeys[0]!;
  if (!Object.hasOwn(CURSOR_NATIVE_OPERATIONS, tool)) return null;
  const call = record(calls[tool]);
  if (!call) return null;
  return {
    executionId: message.call_id,
    tool: tool as CursorNativeToolEnvelope["tool"],
    operation: CURSOR_NATIVE_OPERATIONS[tool as CursorNativeToolEnvelope["tool"]],
    call,
  };
}
