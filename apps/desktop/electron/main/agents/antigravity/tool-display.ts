/**
 * How one agy tool call reads in the owner's live feed. The feed already
 * describes shell, file and search calls by the names other providers use
 * (`bash`, `readToolCall`, …), and LetAgents room tools by their bare name;
 * agy's own names (`run_command`, `write_file`, `mcp_letagents_get_board`)
 * are mapped onto those, so the row shows "Ran a shell command · ls".
 * Display only: nothing decides on these values.
 */
import { acpRecord, acpString, type AcpJsonRecord } from "./acp-connection.js";
import { ANTIGRAVITY_ROOM_SERVER_NAME } from "./launch.js";

export type AntigravityToolDisplay = { tool: string; input: unknown };

const ROOM_TOOL_PREFIX = `mcp_${ANTIGRAVITY_ROOM_SERVER_NAME}_`;

export function antigravityToolDisplay(update: AcpJsonRecord): AntigravityToolDisplay {
  const name = acpString(update.name) ?? "";
  const kind = acpString(update.kind);
  const input = acpRecord(update.rawInput) ?? acpRecord(update.args);
  const path = acpString(input?.Path) ?? acpString(input?.TargetFile) ?? acpString(input?.AbsolutePath) ?? acpString(input?.absolute_path)
    ?? acpString(acpRecord((update.locations as unknown[] | undefined)?.[0])?.path);
  if (name.startsWith(ROOM_TOOL_PREFIX)) {
    const args = input ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "toolSummary")) : null;
    return { tool: name.slice(ROOM_TOOL_PREFIX.length), input: args };
  }
  if (name === "call_mcp_tool" && input?.ServerName === ANTIGRAVITY_ROOM_SERVER_NAME && typeof input.ToolName === "string") {
    return { tool: input.ToolName, input: acpRecord(input.Arguments) };
  }
  if (kind === "execute" || name === "run_command") {
    const command = acpString(input?.CommandLine) ?? acpString(input?.command);
    return { tool: "bash", input: command ? { command } : input };
  }
  if (kind === "read") return { tool: "readToolCall", input: path ? { path } : input };
  if (kind === "search") {
    const pattern = acpString(input?.Query) ?? acpString(input?.Pattern) ?? acpString(input?.query);
    return { tool: "grepToolCall", input: { ...(pattern ? { pattern } : {}), ...(path ? { path } : {}) } };
  }
  if (kind === "edit" || kind === "delete" || kind === "move") {
    return { tool: name === "write_file" ? "writeToolCall" : "editToolCall", input: path ? { path, changes: [{ path }] } : input };
  }
  return { tool: name || kind || "tool", input };
}
