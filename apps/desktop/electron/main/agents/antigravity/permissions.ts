/**
 * Antigravity permission requests in the shape the daemon's approval path
 * already serves for Claude Code: `{ id, request: { subtype: "can_use_tool",
 * tool_name, input, tool_use_id } }`. agy's commands become `Bash`, its file
 * writes `Write`, its edits `Edit` and its fetches `WebFetch`, so approval
 * cards, "Always allowed" rules and automatic review read them the same way.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
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

/** A path as written and as the file system resolves it (`/tmp` is `/private/tmp` on macOS). */
export function antigravityPathForms(path: string): string[] {
  const forms = new Set([resolve(path)]);
  try { forms.add(realpathSync(path)); } catch { /* a path that does not exist has one form */ }
  return [...forms];
}

/** The file a tool call names: its input's path, or its first location. */
export function antigravityToolPath(toolCall: AcpJsonRecord | null): string | null {
  if (!toolCall) return null;
  const raw = acpRecord(toolCall.rawInput) ?? acpRecord(toolCall.args) ?? {};
  const location = acpString(acpRecord((toolCall.locations as unknown[] | undefined)?.[0])?.path);
  return acpString(raw.TargetFile) ?? acpString(raw.Path) ?? acpString(raw.AbsolutePath) ?? location ?? null;
}

export function antigravityPermissionTool(toolCall: AcpJsonRecord): { tool_name: string; input: Record<string, unknown> } {
  const name = acpString(toolCall.name) ?? "";
  const kind = acpString(toolCall.kind);
  const raw = acpRecord(toolCall.rawInput) ?? acpRecord(toolCall.args) ?? {};
  const filePath = antigravityToolPath(toolCall);
  if (kind === "execute" || name === "run_command") {
    const command = acpString(raw.CommandLine) ?? acpString(raw.command) ?? acpString(toolCall.title) ?? "";
    const cwd = acpString(raw.Cwd);
    return { tool_name: "Bash", input: { command, ...(cwd ? { cwd } : {}) } };
  }
  if (name === "write_file" && filePath) {
    return { tool_name: "Write", input: { file_path: filePath, ...(typeof raw.Content === "string" ? { content: raw.Content } : {}) } };
  }
  if (kind === "edit" && filePath) {
    // agy 1.5.15 sends `Target`/`Replacement`, and the same change as a `diff` content block.
    const diff = (Array.isArray(toolCall.content) ? toolCall.content : []).map(acpRecord).find((block) => block?.type === "diff") ?? null;
    const oldText = [raw.Target, raw.TargetContent, diff?.oldText].find((value): value is string => typeof value === "string");
    const newText = [raw.Replacement, raw.ReplacementContent, diff?.newText].find((value): value is string => typeof value === "string");
    return { tool_name: "Edit", input: {
      file_path: filePath,
      ...(oldText !== undefined ? { old_string: oldText } : {}),
      ...(newText !== undefined ? { new_string: newText } : {}),
    } };
  }
  if ((kind === "read" || name === "read_file" || name === "view_file") && filePath) {
    return { tool_name: "Read", input: { file_path: filePath } };
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
