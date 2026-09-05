import type { DaemonActivityEvent } from "./types.js";
import { isAgentInspectorLiveDisplayEvent } from "./provider-stream-policy.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function id(value: unknown): string | null {
  return typeof value === "string" && value.trim() && !/[\r\n\0]/.test(value) ? value : null;
}

/** Display-only projection of already-redacted evidence from one exact installation. */
export class ProviderLiveDisplay {
  private claudeTurn: string | null = null;
  private readonly texts = new Map<string, string>();
  private readonly tools = new Map<string, { name: string; completed: boolean }>();

  private readonly finishedTurns = new Set<string>();

  constructor(private readonly continuation: string) {}

  project(event: DaemonActivityEvent, nativePhase?: "turn_active" | "turn_terminal" | null): DaemonActivityEvent[] {
    const payload = record(event.payload);
    const emit = (method: string, kind: DaemonActivityEvent["kind"], value: Record<string, unknown>): DaemonActivityEvent =>
      ({ ...event, method, kind, summary: "", payload: value });
    if (event.provider === "codex") {
      if (payload?.threadId !== this.continuation || !id(payload.turnId)) return [];
      const item = record(payload.item);
      if ((event.method === "item/started" || event.method === "item/completed") && item && id(item.id)) {
        const tool = item.type === "commandExecution" ? "shellToolCall" : item.type === "fileChange" ? "editToolCall"
          : item.type === "mcpToolCall" && typeof item.tool === "string" ? item.tool : null;
        if (tool) return [emit("item/toolCall/updated", "tool_lifecycle", {
          callID: `codex:${this.continuation}:${payload.turnId}:${item.id}`, tool,
          status: event.method === "item/started" ? "running"
            : item.status === "interrupted" || item.status === "cancelled" ? "interrupted"
            : item.status === "failed" || item.status === "declined" || item.error
              || (item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0) ? "error" : "completed",
          input: item.type === "commandExecution" ? { command: item.command, cwd: item.cwd }
            : item.type === "fileChange" ? { changes: item.changes } : item.arguments ?? null,
          output: item.aggregatedOutput ?? item.result ?? null,
          error: typeof item.error === "string" ? item.error : item.error ? "Provider reported a tool error."
            : item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0 ? `Command exited with code ${item.exitCode}.` : null,
        })];
      }
      if (event.method === "item/agentMessage/delta" && id(payload.itemId)) {
        return [emit(event.method, event.kind, { ...payload, partId: `codex:${this.continuation}:${payload.turnId}:${payload.itemId}` })];
      }
    }
    if (event.provider !== "claude-code") return isAgentInspectorLiveDisplayEvent(event) ? [event] : [];
    if (!payload || payload.session_id !== this.continuation || payload.parent_tool_use_id != null) return [];
    if (payload.type === "command_lifecycle" && payload.state === "started" && nativePhase === "turn_active" && id(payload.command_uuid)) {
      if (this.finishedTurns.has(payload.command_uuid as string)) return [];
      if (this.claudeTurn !== payload.command_uuid) {
        this.claudeTurn = payload.command_uuid as string;
        this.texts.clear(); this.tools.clear();
      }
      return [];
    }
    const turn = this.claudeTurn;
    if (payload.type === "result") {
      const terminalTurn = id(payload.user_message_uuid);
      if (!terminalTurn || (turn && terminalTurn !== turn) || (!turn && nativePhase !== "turn_terminal")) return [];
      if (this.finishedTurns.has(terminalTurn)) return [];
      this.finishedTurns.add(terminalTurn);
      if (this.finishedTurns.size > 64) this.finishedTurns.delete(this.finishedTurns.values().next().value!);
      const previousTexts = terminalTurn === turn ? [...this.texts.values()] : [];
      const alreadyDisplayed = previousTexts.includes(String(payload.result)) || previousTexts.join("") === payload.result;
      const result = !alreadyDisplayed && payload.subtype === "success" && payload.is_error === false && typeof payload.result === "string"
        ? [emit("item/agentMessage/delta", "text_delta", { partId: `claude:${this.continuation}:${terminalTurn}:result`, delta: payload.result })] : [];
      this.claudeTurn = null;
      // A replayed terminal has no new native terminal edge, and cannot reopen display ownership.
      return result;
    }
    if (!turn || (payload.user_message_uuid != null && payload.user_message_uuid !== turn)) return [];
    const body = record(payload.message);
    if (!body || !Array.isArray(body.content)) return [];
    const result: DaemonActivityEvent[] = [];
    for (const [index, value] of body.content.entries()) {
      const block = record(value);
      if (!block) continue;
      if (payload.type === "assistant" && body.role === "assistant" && block.type === "text" && typeof block.text === "string") {
        const messageId = id(body.id) ?? id(payload.uuid);
        if (!messageId) continue;
        const partId = `claude:${this.continuation}:${turn}:${messageId}:${index}`;
        const previous = this.texts.get(partId) ?? "";
        if (!block.text.startsWith(previous) || this.texts.size >= 128 && !this.texts.has(partId)) continue;
        this.texts.set(partId, block.text);
        const delta = block.text.slice(previous.length);
        if (delta) {
              result.push(emit("item/agentMessage/delta", "text_delta", { partId, delta }));
        }
      } else if (payload.type === "assistant" && block.type === "tool_use" && id(block.id) && typeof block.name === "string") {
        if (this.tools.has(block.id as string) || this.tools.size >= 256) continue;
        const names: Record<string, string> = { Bash: "shellToolCall", Read: "readToolCall", Edit: "editToolCall",
          MultiEdit: "editToolCall", Write: "writeToolCall", Grep: "grepToolCall", Glob: "globToolCall" };
        const name = names[block.name] ?? block.name;
        this.tools.set(block.id as string, { name, completed: false });
        result.push(emit("item/toolCall/updated", "tool_lifecycle", {
          callID: `claude:${this.continuation}:${turn}:${block.id}`, tool: name, status: "pending", input: block.input ?? null,
        }));
      } else if (payload.type === "user" && block.type === "tool_result" && id(block.tool_use_id)) {
        const tool = this.tools.get(block.tool_use_id as string);
        if (!tool || tool.completed || (block.is_error !== undefined && typeof block.is_error !== "boolean")
          || !(typeof block.content === "string" || Array.isArray(block.content))) continue;
        tool.completed = true;
        result.push(emit("item/toolCall/updated", "tool_lifecycle", {
          callID: `claude:${this.continuation}:${turn}:${block.tool_use_id}`, tool: tool.name,
          status: block.is_error ? "error" : "completed", output: block.is_error ? null : block.content ?? null,
          error: block.is_error ? typeof block.content === "string" ? block.content : "Provider reported a tool error." : null,
        }));
      }
    }
    return result;
  }
}
