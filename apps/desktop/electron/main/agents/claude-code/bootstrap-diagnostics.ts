import { parseStreamLine } from "./stream-messages.js";
import type { ClaudeCliChild, ClaudeStreamMessage } from "./types.js";

const CLAUDE_API_ERROR_CATEGORIES = new Set([
  "authentication_failed", "oauth_org_not_allowed", "billing_error", "rate_limit",
  "overloaded", "invalid_request", "model_not_found", "server_error", "unknown", "max_output_tokens",
]);
/** Year 2100: a later value is a millisecond timestamp or garbage, not a reset time in seconds. */
const CLAUDE_MAX_RESET_EPOCH_SECONDS = 4_102_444_800;
const CLAUDE_RESULT_CATEGORIES = new Set([
  "success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries",
]);
const CLAUDE_STARTUP_SYSTEM_TYPES = new Set([
  "init", "api_retry", "compact_boundary", "control_request_progress", "hook_started", "hook_progress",
  "commands_changed", "background_tasks_changed", "files_persisted", "elicitation_complete", "informational",
  "local_command_output", "memory_recall", "mirror_error", "model_refusal_fallback", "model_refusal_no_fallback",
  "notification", "permission_denied", "plugin_install", "task_notification", "task_progress", "task_started",
  "task_updated", "thinking_tokens", "worker_shutting_down",
]);
const CLAUDE_STARTUP_LINE_TYPES = new Set([
  "assistant", "result", "user", "auth_status", "stream_event", "tool_progress", "tool_use_summary",
  "control_request", "control_cancel_request",
]);

function claudeStartupLineType(message: ClaudeStreamMessage): string {
  // Values outside these finite enums never enter the diagnostic, including
  // unknown keys/subtypes, hook output, tool names, IDs and native error text.
  if (message.type === "command_lifecycle") {
    return `command_lifecycle.${message.state === "started" ? "started" : "unlisted"}`;
  }
  if (message.type !== "system") {
    return typeof message.type === "string" && CLAUDE_STARTUP_LINE_TYPES.has(message.type) ? message.type : "unlisted";
  }
  if (message.subtype === "status") {
    const status = message.status === null ? "cleared"
      : message.status === "compacting" || message.status === "requesting" ? message.status : "unlisted";
    const compact = message.compact_result === undefined ? ""
      : message.compact_result === "success" || message.compact_result === "failed"
        ? `.compact_${message.compact_result}` : ".compact_unlisted";
    return `system.status.${status}${compact}`;
  }
  if (message.subtype === "hook_response") {
    const outcome = message.outcome === "success" || message.outcome === "error" || message.outcome === "cancelled"
      ? message.outcome : "unlisted";
    return `system.hook_response.${outcome}`;
  }
  if (message.subtype === "session_state_changed") {
    const state = message.state === "idle" || message.state === "running" || message.state === "requires_action"
      ? message.state : "unlisted";
    return `system.session_state_changed.${state}`;
  }
  return typeof message.subtype === "string" && CLAUDE_STARTUP_SYSTEM_TYPES.has(message.subtype)
    ? `system.${message.subtype}` : "system.unlisted";
}

/** Bounded observations from this child's startup, never an inferred root cause. */
export class ClaudeBootstrapDiagnostics {
  private readonly startedAt = performance.now();
  private initializedAt: number | null = null;
  private stdoutLines = 0;
  private matchedSessionLines = 0;
  private apiRetries = 0;
  private assistantMessages = 0;
  private resultMessages = 0;
  private authMessages = 0;
  private authenticating: boolean | null = null;
  private lastApiRetry: string | null = null;
  private assistantError: string | null = null;
  private limitResetsAtMs: number | null = null;
  private result: string | null = null;
  private uncorrelatedResult: string | null = null;
  private readonly lineTypes = new Map<string, number>();
  private lastLineType: string | null = null;
  private lastLineMs = 0;

  constructor(private readonly sessionId: string, private readonly turnId: string, private readonly budgetMs: number) {}

  initialized(): void { this.initializedAt = performance.now(); }

  /** The allowlisted API error category Claude reported for the bootstrap turn. */
  get apiError(): string | null { return this.assistantError; }

  /** When Claude said the rejecting usage limit resets (epoch ms), if it said so. */
  get usageLimitResetsAtMs(): number | null { return this.limitResetsAtMs; }

  observe(line: string): void {
    this.stdoutLines = Math.min(Number.MAX_SAFE_INTEGER, this.stdoutLines + 1);
    const message = parseStreamLine(line);
    if (!message || message.session_id !== this.sessionId) return;
    this.matchedSessionLines = Math.min(Number.MAX_SAFE_INTEGER, this.matchedSessionLines + 1);
    const lineType = claudeStartupLineType(message);
    this.lineTypes.set(lineType, Math.min(Number.MAX_SAFE_INTEGER, (this.lineTypes.get(lineType) ?? 0) + 1));
    this.lastLineType = lineType;
    // Subscription/diagnostics start is the origin, including pre-init lines.
    this.lastLineMs = Math.max(0, Math.round(performance.now() - this.startedAt));
    // Never include arbitrary error strings, keys, subtypes, IDs or message text.
    const category = typeof message.error === "string" && CLAUDE_API_ERROR_CATEGORIES.has(message.error)
      ? message.error : "unlisted";
    if (message.type === "system" && message.subtype === "api_retry") {
      this.apiRetries = Math.min(Number.MAX_SAFE_INTEGER, this.apiRetries + 1);
      const status = message.error_status === null ? "none"
        : typeof message.error_status === "number" && Number.isInteger(message.error_status)
          && message.error_status >= 100 && message.error_status <= 599 ? message.error_status : "unlisted";
      this.lastApiRetry = `${category} (HTTP ${status})`;
    } else if (message.type === "assistant") {
      this.assistantMessages = Math.min(Number.MAX_SAFE_INTEGER, this.assistantMessages + 1);
      if (message.error !== undefined) this.assistantError = category;
    } else if (message.type === "result") {
      this.resultMessages = Math.min(Number.MAX_SAFE_INTEGER, this.resultMessages + 1);
      const subtype = typeof message.subtype === "string" && CLAUDE_RESULT_CATEGORIES.has(message.subtype)
        ? message.subtype : "unlisted";
      if (message.user_message_uuid === this.turnId) {
        this.result = subtype;
      } else this.uncorrelatedResult = subtype;
    } else if (message.type === "rate_limit_event") {
      // The CLI reports each usage window it reads. Only a rejected one names
      // the reset that matters, as epoch seconds (SDKRateLimitEvent). A value
      // outside the seconds range is not that field, so it is not trusted.
      // With several rejected windows the agent is limited until the latest.
      const info = message.rate_limit_info as { status?: unknown; resetsAt?: unknown } | null | undefined;
      if (info?.status === "rejected" && typeof info.resetsAt === "number" && Number.isSafeInteger(info.resetsAt)
        && info.resetsAt > 0 && info.resetsAt <= CLAUDE_MAX_RESET_EPOCH_SECONDS) {
        this.limitResetsAtMs = Math.max(this.limitResetsAtMs ?? 0, info.resetsAt * 1000);
      }
    } else if (message.type === "auth_status") {
      this.authMessages = Math.min(Number.MAX_SAFE_INTEGER, this.authMessages + 1);
      this.authenticating = typeof message.isAuthenticating === "boolean" ? message.isAuthenticating : null;
    }
  }

  summary(child: ClaudeCliChild, compactionFields: string[] = []): string {
    const failedAt = performance.now();
    const elapsed = (start: number, end: number) => Math.max(0, Math.round(end - start));
    let stderrBytes: number | null = null;
    try {
      const count = child.stderrBytesRead?.();
      if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) stderrBytes = count;
    } catch { /* An unavailable diagnostic must not replace the launch failure. */ }
    const lineTypes: string[] = [];
    for (const [type, count] of this.lineTypes) {
      const item = `${type}:${count}`;
      if (lineTypes.length === 8 || [...lineTypes, item].join(",").length > 180) break;
      lineTypes.push(item);
    }
    // Keep the histogram and its omission count in one field so the outer
    // 512-character cap cannot retain a partial histogram without its marker.
    const omittedTypes = this.lineTypes.size - lineTypes.length;
    if (omittedTypes) lineTypes.push(`omitted_types:${omittedTypes}`);
    const fields = [
      ...compactionFields,
      ...(this.lastApiRetry === null ? [] : [`last_api_retry=${this.lastApiRetry}`]),
      ...(this.assistantError === null ? [] : [`assistant_error=${this.assistantError}`]),
      ...(this.limitResetsAtMs === null ? [] : [`usage_limit_resets_at=${new Date(this.limitResetsAtMs).toISOString()}`]),
      ...(this.result === null ? [] : [`result=${this.result}`]),
      ...(this.uncorrelatedResult === null ? [] : [`uncorrelated_result=${this.uncorrelatedResult}`]),
      ...(this.authMessages === 0 ? [] : [`auth_status_count=${this.authMessages}`, `authenticating=${this.authenticating ?? "unlisted"}`]),
      ...(this.lastLineType === null ? [] : [`last_line_type=${this.lastLineType}`, `last_line_ms=${this.lastLineMs}`]),
      `init_ms=${elapsed(this.startedAt, this.initializedAt ?? failedAt)}`,
      `bootstrap_ms=${this.initializedAt === null ? "not_started" : elapsed(this.initializedAt, failedAt)}`,
      `budget_ms=${this.budgetMs}`, `stdout_lines=${this.stdoutLines}`, `matched_session_lines=${this.matchedSessionLines}`,
      `stderr_bytes=${stderrBytes ?? "unavailable"}`,
      `api_retry_count=${this.apiRetries}`, `assistant_count=${this.assistantMessages}`, `result_count=${this.resultMessages}`,
      ...(lineTypes.length ? [`line_types=${lineTypes.join(",")}`] : []),
    ];
    let omitted = 0;
    for (;;) {
      const summary = `Startup observations: ${fields.join("; ")}${omitted ? `; omitted_fields=${omitted}` : ""}.`;
      if (summary.length <= 512) return summary;
      fields.pop();
      omitted += 1;
    }
  }
}

/**
 * What the owner reads when Claude Code ended the prompt that starts an agent
 * with no call to the model. It repeats nothing of the CLI's text, which can
 * hold a hook's words, a path of the owner's machine, and the prompt.
 *
 * `namesSettingSources`: the launch told Claude Code which settings to read.
 * An access level that does so reads the owner's settings alone with the
 * owner's setup on, and no settings at all with it off: only then is turning
 * the setup off a way out. A launch that names none reads the owner's
 * settings, the project's and the folder's local ones.
 */
export function claudeStartWithoutModelText(input: {
  modelNotCalled: "hook_stopped_prompt" | "unknown"; ownerSetup: boolean; namesSettingSources: boolean;
}): string {
  if (input.modelNotCalled !== "hook_stopped_prompt") {
    return "Claude Code ended the prompt that LetAgents sends to start this agent without a call to the model, so the agent did not start.";
  }
  const stopped = "A UserPromptSubmit hook stopped the prompt that LetAgents sends to start this agent";
  const change = "Change the hook so that it lets this prompt through, then try again.";
  if (input.ownerSetup) {
    // "with your own setup": the desktop shows a start that was refused over the owner's setup in the launch's own words.
    return `${stopped}, so the agent cannot start with your own setup while the hook stops that prompt. `
      + `With your own setup on, Claude Code runs the hooks of your own Claude Code settings and plugins. ${change}`
      + (input.namesSettingSources
        ? " Or turn off \"Use your own Claude Code setup\" for this agent: it then reads none of your Claude Code settings, so their hooks do not run."
        : "");
  }
  return `${stopped}, so the agent cannot start while the hook stops that prompt. `
    + `${input.namesSettingSources ? "" : "This agent runs the hooks of your Claude Code settings and of the project's settings. "}${change}`;
}
