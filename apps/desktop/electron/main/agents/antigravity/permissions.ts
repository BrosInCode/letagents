/**
 * Antigravity permission requests in the shape the daemon's approval path
 * already serves for Claude Code: `{ id, request: { subtype: "can_use_tool",
 * tool_name, input, tool_use_id } }`. agy's commands become `Bash`, its file
 * writes `Write`, its edits `Edit` and its fetches `WebFetch`, so approval
 * cards, "Always allowed" rules and automatic review read them the same way.
 */
import type { ClaudeNativePermissionRequest } from "../../../../shared/provider-permissions.js";
import { acpRecord, acpString, type AcpJsonRecord } from "./acp-connection.js";

export type AntigravityNativePermissionRequest = ClaudeNativePermissionRequest;

/** One request agy waits on, until the owner answers it or the turn ends. */
export type AntigravityPendingPermission = {
  native: AntigravityNativePermissionRequest;
  turnId: string;
  toolCallId: string;
  options: unknown;
  dispatching: boolean;
  settle: (answer: AcpJsonRecord) => void;
};

export function antigravityPermissionTool(toolCall: AcpJsonRecord): { tool_name: string; input: Record<string, unknown> } {
  const name = acpString(toolCall.name) ?? "";
  const kind = acpString(toolCall.kind);
  const raw = acpRecord(toolCall.rawInput) ?? acpRecord(toolCall.args) ?? {};
  const location = acpString(acpRecord((toolCall.locations as unknown[] | undefined)?.[0])?.path);
  const filePath = acpString(raw.TargetFile) ?? acpString(raw.Path) ?? acpString(raw.AbsolutePath) ?? location;
  if (kind === "execute" || name === "run_command") {
    const command = acpString(raw.CommandLine) ?? acpString(raw.command) ?? acpString(toolCall.title) ?? "";
    const cwd = acpString(raw.Cwd);
    return { tool_name: "Bash", input: { command, ...(cwd ? { cwd } : {}) } };
  }
  if (name === "write_file" && filePath) {
    return { tool_name: "Write", input: { file_path: filePath, ...(typeof raw.Content === "string" ? { content: raw.Content } : {}) } };
  }
  if (kind === "edit" && filePath) {
    return { tool_name: "Edit", input: {
      file_path: filePath,
      ...(typeof raw.TargetContent === "string" ? { old_string: raw.TargetContent } : {}),
      ...(typeof raw.ReplacementContent === "string" ? { new_string: raw.ReplacementContent } : {}),
    } };
  }
  if (kind === "fetch") {
    const url = acpString(raw.Url) ?? acpString(raw.url) ?? acpString(toolCall.title) ?? "";
    return { tool_name: "WebFetch", input: { url } };
  }
  return { tool_name: name || kind || "tool", input: { ...raw } };
}

export function antigravityNativePermission(id: string | number, toolCall: AcpJsonRecord): AntigravityNativePermissionRequest {
  const { tool_name, input } = antigravityPermissionTool(toolCall);
  return {
    id: String(id),
    request: { subtype: "can_use_tool", tool_name, input, tool_use_id: acpString(toolCall.toolCallId) ?? String(id) },
  };
}

/** The agy option that carries an answer, by option kind; null when agy offers none of that kind. */
export function antigravityPermissionOption(options: unknown, reply: "once" | "reject"): string | null {
  if (!Array.isArray(options)) return null;
  for (const kind of reply === "once" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"]) {
    for (const option of options) {
      const record = acpRecord(option);
      if (record?.kind === kind && typeof record.optionId === "string") return record.optionId;
    }
  }
  return null;
}
