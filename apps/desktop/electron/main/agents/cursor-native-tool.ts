import { nativeExecutionId } from "./provider-execution-observer.js";

const CURSOR_NATIVE_OPERATIONS = {
  shellToolCall: "command",
  readToolCall: "file_read",
  writeToolCall: "file_change",
} as const;

export type CursorNativeToolEnvelope = {
  executionId: string;
  subtype: "started" | "completed";
  tool: keyof typeof CURSOR_NATIVE_OPERATIONS;
  operation: (typeof CURSOR_NATIVE_OPERATIONS)[keyof typeof CURSOR_NATIVE_OPERATIONS];
  call: Record<string, unknown>;
};

type CursorNativeToolTerminalVariant =
  | "success"
  | "error"
  | "failure"
  | "timeout"
  | "rejected"
  | "permissionDenied"
  | "spawnError";

export type CursorNativeToolTerminalResult = {
  variant: CursorNativeToolTerminalVariant;
  detail: Record<string, unknown>;
  outcome: "succeeded" | "failed" | "denied_before_start";
  sideEffects: "none" | "possible";
  exitCode?: number;
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
    subtype: message.subtype,
    tool: tool as CursorNativeToolEnvelope["tool"],
    operation: CURSOR_NATIVE_OPERATIONS[tool as CursorNativeToolEnvelope["tool"]],
    call,
  };
}

/** Operation-specific terminal contract shared by typed facts and local live display. */
export function cursorNativeToolTerminalResult(
  nativeTool: CursorNativeToolEnvelope,
): CursorNativeToolTerminalResult | null {
  if (nativeTool.subtype !== "completed") return null;
  const result = record(nativeTool.call.result);
  if (!result) return null;
  const variants = (nativeTool.operation === "command"
    ? ["success", "failure", "timeout", "rejected", "permissionDenied", "spawnError"] as const
    : ["success", "error", "failure"] as const)
    .filter((key) => Object.hasOwn(result, key));
  if (variants.length !== 1) return null;
  const variant = variants[0]!;
  const detail = record(result[variant]);
  if (!detail) return null;

  if (nativeTool.operation === "command") {
    // Cursor 2026.07.09's ShellResult uses foreground success/failure records
    // with an int32 exitCode (protobuf JSON emits default zero). A background
    // handoff or timeout is not command completion.
    if (result.isBackground !== undefined && typeof result.isBackground !== "boolean") return null;
    if (result.isBackground === true || variant === "timeout") return null;
    if (variant === "rejected" || variant === "permissionDenied" || variant === "spawnError") {
      return {
        variant,
        detail,
        outcome: variant === "spawnError" ? "failed" : "denied_before_start",
        sideEffects: "none",
      };
    }
    if (!Number.isInteger(detail.exitCode)
      || (detail.exitCode as number) < -2_147_483_648
      || (detail.exitCode as number) > 2_147_483_647) return null;
    const exitCode = detail.exitCode as number;
    return {
      variant,
      detail,
      outcome: variant === "success" && exitCode === 0 ? "succeeded" : "failed",
      sideEffects: "possible",
      exitCode,
    };
  }

  return {
    variant,
    detail,
    outcome: variant === "success" ? "succeeded" : "failed",
    sideEffects: nativeTool.operation === "file_read" ? "none" : "possible",
  };
}
