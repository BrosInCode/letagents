import type { DaemonActivityEvent } from "./types.js";
import { isAgentInspectorLiveDisplayEvent } from "./provider-stream-policy.js";
import { redactCredentialText } from "./credential-redaction.js";
import {
  LIVE_BACKGROUND_COMMAND_METHOD,
  LIVE_OUTPUT_TAIL_CHARS,
  liveBackgroundLatestKey,
  liveOutputLatestKey,
  liveOutputTail,
  plainShellCommand,
  plainTerminalText,
  type LiveBackgroundCommandStatus,
} from "../../../shared/live-command-output.mjs";

/** Raw output kept per running command for its live tail: more than one tail, so a cut lands on a line start. */
const LIVE_OUTPUT_RAW_CHARS = LIVE_OUTPUT_TAIL_CHARS * 2;
const TERMINAL_TOOL_STATUSES = new Set(["completed", "error", "failed", "interrupted"]);
/** Codex commands that one agent leaves running between turns; more are not followed. */
const MAX_CODEX_BACKGROUND = 16;
/** The longest command a background event carries. */
const MAX_BACKGROUND_COMMAND_CHARS = 2_000;

type CodexCommandOutput = {
  turn: string; text: string; truncated: boolean; redacted: boolean; unavailable: boolean;
  command: unknown; cwd: unknown; tail: string; tailCut: boolean; liveHidden: boolean; startedAt: string | null;
};

/** How the daemon puts a live display event on the feed: as one more event, or as the newest value of a key. */
export type LiveDisplayFeedPlacement =
  | { kind: "append"; endsLatestKey: string | null }
  | { kind: "latest"; key: string; sticky: boolean; immediate: boolean };

/**
 * A live output event is the newest value of its command's key. A background
 * command's state is too, and the size limit keeps it while the command runs.
 * The final event of a tool call ends the paced output of the same call.
 */
export function liveDisplayFeedPlacement(event: Pick<DaemonActivityEvent, "method" | "payload">): LiveDisplayFeedPlacement {
  const outputKey = liveOutputLatestKey(event);
  if (outputKey) return { kind: "latest", key: outputKey, sticky: false, immediate: false };
  const backgroundKey = liveBackgroundLatestKey(event);
  if (backgroundKey) {
    const running = record(event.payload)?.status === "running";
    return { kind: "latest", key: backgroundKey, sticky: running, immediate: !running };
  }
  const payload = record(event.payload);
  const callId = event.method === "item/toolCall/updated" && typeof payload?.callID === "string" ? payload.callID : null;
  const terminal = callId !== null && typeof payload?.status === "string" && TERMINAL_TOOL_STATUSES.has(payload.status);
  return { kind: "append", endsLatestKey: terminal ? `output:${callId}` : null };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function id(value: unknown): string | null {
  return typeof value === "string" && value.trim() && !/[\r\n\0]/.test(value) ? value : null;
}

function errorMessage(value: unknown): string | null {
  const message = typeof value === "string" ? value : record(value)?.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function toolResultError(value: unknown): string | null {
  const content = record(value)?.content;
  if (!Array.isArray(content)) return null;
  const text = content.flatMap((block) => {
    const part = record(block);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  }).join("\n").trim();
  return text || null;
}

/** Add a fragment to a command's live tail; a broken text boundary hides the tail for good. */
function appendLiveTail(output: { tail: string; tailCut: boolean; liveHidden: boolean }, delta: string, broken: boolean): void {
  output.liveHidden ||= broken;
  output.tail = output.liveHidden ? "" : output.tail + delta;
  if (output.tail.length > LIVE_OUTPUT_RAW_CHARS) {
    output.tail = output.tail.slice(-LIVE_OUTPUT_RAW_CHARS);
    output.tailCut = true;
  }
}

/**
 * How a Codex background command ended. Codex ends a session that was terminated (the owner's Stop, or the
 * agent's own clean-up) with exit code -1 and no exit status of its own.
 */
function codexBackgroundEnd(status: unknown, exitCode: number | null): LiveBackgroundCommandStatus {
  if (status === "interrupted" || status === "cancelled" || exitCode === -1) return "stopped";
  if (status === "failed" || status === "declined" || (exitCode !== null && exitCode !== 0)) return "failed";
  return "completed";
}

/** Display-only projection of already-redacted evidence from one exact installation. */
export class ProviderLiveDisplay {
  private claudeTurn: string | null = null;
  private readonly texts = new Map<string, string>();
  private readonly tools = new Map<string, { name: string; completed: boolean; running?: boolean }>();
  private readonly commandOutputs = new Map<string, CodexCommandOutput>();
  /**
   * Codex commands that still ran when their turn ended: exec sessions that the agent left running. Codex goes
   * on reporting their output and their end between turns, under the turn that started them.
   */
  private readonly codexBackground = new Map<string, CodexCommandOutput & { itemId: string }>();

  private readonly finishedTurns = new Set<string>();

  constructor(private readonly continuation: string) {}

  project(event: DaemonActivityEvent, nativePhase?: "turn_active" | "turn_terminal" | null): DaemonActivityEvent[] {
    const payload = record(event.payload);
    const emit = (method: string, kind: DaemonActivityEvent["kind"], value: Record<string, unknown>): DaemonActivityEvent =>
      ({ ...event, method, kind, summary: "", payload: value });
    if (event.provider === "codex") {
      const nativeTurnId = record(payload?.turn)?.id;
      const turnId = id(payload?.turnId ?? nativeTurnId);
      if (payload?.threadId !== this.continuation || !turnId
        || (payload.turnId !== undefined && nativeTurnId !== undefined && payload.turnId !== nativeTurnId)) return [];
      const commandKey = (itemId: string) => JSON.stringify([turnId, itemId]);
      if (event.method === "item/commandExecution/outputDelta" && id(payload.itemId) && typeof payload.delta === "string") {
        const background = this.codexBackground.get(commandKey(payload.itemId as string));
        if (background) {
          appendLiveTail(background, payload.delta, event.payload_redacted || event.payload_truncated);
          return [this.codexBackgroundCommand(event, background)];
        }
        const output = this.commandOutputs.get(commandKey(payload.itemId as string));
        if (!output) return [];
        // Redaction or upstream truncation breaks the original text boundary.
        // Joining later fragments could reveal a suffix of an already-masked secret.
        const broken = event.payload_redacted || event.payload_truncated;
        output.unavailable ||= broken;
        output.redacted ||= event.payload_redacted;
        output.truncated ||= event.payload_truncated;
        const combined = output.unavailable ? "" : output.text + payload.delta;
        output.truncated ||= combined.length > 6_000;
        output.unavailable ||= combined.length > 6_000;
        output.text = output.unavailable ? "" : combined;
        appendLiveTail(output, payload.delta, broken);
        return [this.codexLiveOutput(event, turnId, payload.itemId as string, output)];
      }
      if (/^turn\/(completed|failed|interrupted|cancelled|stopped)$/.test(event.method)) {
        // A command that still runs when its turn ends runs in the background: the agent no longer waits for it.
        const background: DaemonActivityEvent[] = [];
        for (const [key, output] of this.commandOutputs) {
          if (output.turn !== turnId) continue;
          this.commandOutputs.delete(key);
          const itemId = JSON.parse(key)[1] as string;
          if (this.codexBackground.size >= MAX_CODEX_BACKGROUND) continue;
          const command = { ...output, itemId };
          this.codexBackground.set(key, command);
          background.push(this.codexBackgroundCommand(event, command));
        }
        return [...background, ...(isAgentInspectorLiveDisplayEvent(event) ? [event] : [])];
      }
      const item = record(payload.item);
      if ((event.method === "item/started" || event.method === "item/completed") && item && id(item.id)) {
        const key = commandKey(item.id as string);
        if (item.type === "commandExecution" && event.method === "item/started" && !this.commandOutputs.has(key)) {
          // Bound unfinished commands independently of the lifetime of the provider session.
          if (this.commandOutputs.size >= 128) this.commandOutputs.delete(this.commandOutputs.keys().next().value!);
          this.commandOutputs.set(key, {
            turn: turnId, text: "", truncated: false, redacted: false, unavailable: false,
            command: item.command, cwd: item.cwd, tail: "", tailCut: false, liveHidden: false,
            startedAt: event.observed_at ?? null,
          });
        }
        const streamed = item.type === "commandExecution" ? this.commandOutputs.get(key) : undefined;
        if (event.method === "item/completed") this.commandOutputs.delete(key);
        const background = event.method === "item/completed" && item.type === "commandExecution" ? this.codexBackground.get(key) : undefined;
        if (background) {
          this.codexBackground.delete(key);
          const exitCode = Number.isInteger(item.exitCode) ? Number(item.exitCode) : null;
          const end = codexBackgroundEnd(item.status, exitCode);
          // The call's own row ends too: a command that the owner stopped reads as interrupted, not failed.
          return [
            this.codexBackgroundCommand(event, background, { status: end, exitCode, endedAt: event.observed_at ?? null }),
            { ...emit("item/toolCall/updated", "tool_lifecycle", {
              callID: `codex:${this.continuation}:${turnId}:${item.id}`, tool: "shellToolCall",
              status: end === "stopped" ? "interrupted" : end === "failed" ? "error" : "completed",
              input: { command: item.command, cwd: item.cwd },
              output: null,
              error: end === "failed" ? (exitCode !== null ? `Command exited with code ${exitCode}.` : "The command failed.") : null,
            }) },
          ];
        }
        const failed = item.status === "failed" || item.status === "declined" || Boolean(item.error)
          || record(item.result)?.isError === true
          || (item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0);
        const tool = item.type === "commandExecution" ? "shellToolCall" : item.type === "fileChange" ? "editToolCall"
          : item.type === "mcpToolCall" && typeof item.tool === "string" ? item.tool : null;
        const fallbackOutput = streamed?.text ? redactCredentialText(streamed.text) : null;
        const explicitError = errorMessage(item.error);
        const failureMessage = event.method !== "item/completed" || !failed ? null : explicitError
          ?? (item.type === "mcpToolCall" ? toolResultError(item.result) : null)
          ?? (item.type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0
            ? `Command exited with code ${item.exitCode}.` : "The tool failed without providing an error message.");
        // Re-sanitize only newly composed text. The input and result are already
        // bounded/redacted; sanitizing their duplicated envelope can erase its call ID.
        const failure = failureMessage ? redactCredentialText(failureMessage, explicitError ? 8_192 : 1_200) : null;
        if (tool) return [{ ...emit("item/toolCall/updated", "tool_lifecycle", {
          callID: `codex:${this.continuation}:${turnId}:${item.id}`, tool,
          status: event.method === "item/started" ? "running"
            : item.status === "interrupted" || item.status === "cancelled" ? "interrupted"
            : failed ? "error" : "completed",
          input: item.type === "commandExecution" ? { command: item.command, cwd: item.cwd }
            : item.type === "fileChange" ? { changes: item.changes } : item.arguments ?? null,
          output: item.aggregatedOutput ?? fallbackOutput?.value ?? item.result ?? null,
          error: failure?.value ?? null,
        }), payload_truncated: event.payload_truncated || Boolean(streamed?.truncated || fallbackOutput?.truncated || failure?.truncated),
          payload_redacted: event.payload_redacted || Boolean(streamed?.redacted || fallbackOutput?.redacted || failure?.redacted) }];
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
    if (payload.type === "system" && payload.subtype === "task_started" && payload.task_type === "local_bash"
      && payload.is_backgrounded === false && turn && id(payload.tool_use_id)) {
      // Claude Code reports no start for a tool call, but a shell command that runs for a while
      // becomes a task. Its call has started: the card says it runs, not that it was requested.
      const tool = this.tools.get(payload.tool_use_id as string);
      if (!tool || tool.completed || tool.running || tool.name !== "shellToolCall") return [];
      tool.running = true;
      return [emit("item/toolCall/updated", "tool_lifecycle", {
        callID: `claude:${this.continuation}:${turn}:${payload.tool_use_id}`, tool: tool.name, status: "running",
      })];
    }
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

  /** A Codex command that runs in the background, as one live value of it: the same event as Claude Code's. */
  private codexBackgroundCommand(
    event: DaemonActivityEvent,
    command: CodexCommandOutput & { itemId: string },
    end?: { status: LiveBackgroundCommandStatus; exitCode: number | null; endedAt: string | null },
  ): DaemonActivityEvent {
    const tail = liveOutputTail(plainTerminalText(command.tail), { cut: command.tailCut, final: Boolean(end) });
    const shown = command.liveHidden ? null : redactCredentialText(tail.text, LIVE_OUTPUT_TAIL_CHARS);
    const text = typeof command.command === "string" ? plainShellCommand(command.command) : "";
    const shownCommand = redactCredentialText(text, MAX_BACKGROUND_COMMAND_CHARS);
    return {
      ...event,
      method: LIVE_BACKGROUND_COMMAND_METHOD,
      kind: "tool_lifecycle",
      summary: "",
      payload: {
        taskId: command.itemId,
        toolUseId: command.itemId,
        command: shownCommand.value,
        description: null,
        status: end?.status ?? "running",
        output: shown?.value ?? "",
        outputTruncated: tail.cut || command.liveHidden,
        exitCode: end ? end.exitCode : null,
        startedAt: command.startedAt,
        endedAt: end ? end.endedAt : null,
      },
      payload_truncated: tail.cut || Boolean(shown?.truncated || shownCommand.truncated),
      payload_redacted: Boolean(shown?.redacted || shownCommand.redacted),
    };
  }

  /** The newest output of a running Codex command, as one live value of its call. */
  private codexLiveOutput(
    event: DaemonActivityEvent,
    turnId: string,
    itemId: string,
    output: { command: unknown; cwd: unknown; tail: string; tailCut: boolean; liveHidden: boolean },
  ): DaemonActivityEvent {
    const tail = liveOutputTail(plainTerminalText(output.tail), { cut: output.tailCut });
    const shown = output.liveHidden ? null : redactCredentialText(tail.text, LIVE_OUTPUT_TAIL_CHARS);
    return {
      ...event,
      method: "item/toolCall/updated",
      kind: "tool_lifecycle",
      summary: "",
      payload: {
        callID: `codex:${this.continuation}:${turnId}:${itemId}`,
        tool: "shellToolCall",
        status: "running",
        input: { command: output.command, cwd: output.cwd },
        output: shown?.value ?? null,
        outputTruncated: tail.cut,
        outputHidden: output.liveHidden,
        outputProgress: true,
      },
      payload_truncated: tail.cut || Boolean(shown?.truncated),
      payload_redacted: Boolean(shown?.redacted),
    };
  }
}
