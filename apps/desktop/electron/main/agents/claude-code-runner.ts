import {
  query,
  type CanUseTool,
  type HookCallback,
  type HookJSONOutput,
  type Options,
  type PermissionResult,
  type PreToolUseHookInput,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  isAutoAllowedManagedAgentTool,
  MANAGED_AGENT_AUTO_ALLOWED_TOOL_NAMES,
} from "./managed-agent-permissions.js";
import { MANAGED_AGENT_ROOM_TOOL_NAMES } from "./managed-agent-room-tools-protocol.js";

export interface ClaudeCodeTurnInput {
  prompt: string;
  cwd: string;
  claudeSessionId?: string | null;
  claudeBin?: string | null;
  model?: string | null;
  abortController?: AbortController;
  canUseTool?: CanUseTool;
}

export interface ClaudeCodeTurnResult {
  sessionId: string | null;
  text: string | null;
  status: "success" | "error";
  error: string | null;
  recentItems: Array<Record<string, unknown>>;
}

export interface ClaudeCodeRunner {
  runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult>;
}

const CLAUDE_CODE_EXTRA_BLOCKED_TOOL_NAMES = [
  "rental_run_command",
  "propose",
  "provision",
  "wait_for_messages",
  "accept_task",
  "register_agent_session",
  "disconnect_agent_session",
  "join_room",
  "join_code",
  "join_project",
  "create_room",
  "create_project",
  "start_local_codex_session",
  "stop_local_codex_session",
] as const;

export const CLAUDE_CODE_BLOCKED_TOOL_NAMES = [
  ...CLAUDE_CODE_EXTRA_BLOCKED_TOOL_NAMES,
  ...MANAGED_AGENT_ROOM_TOOL_NAMES,
] as const;

export const productionClaudeCodeRunner: ClaudeCodeRunner = {
  async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
    const abortController = input.abortController ?? new AbortController();
    const executable = input.claudeBin?.trim();
    let activeQuery: Query | null = null;
    let sessionId: string | null = input.claudeSessionId?.trim() || null;
    let resultText: string | null = null;
    let errorText: string | null = null;
    const recentItems: Array<Record<string, unknown>> = [];
    const interruptActiveQuery = (): void => {
      void activeQuery?.interrupt().catch(() => undefined);
    };

    try {
      activeQuery = query({
        prompt: input.prompt,
        options: buildClaudeCodeQueryOptions({
          ...input,
          abortController,
          claudeSessionId: sessionId,
          claudeBin: executable || undefined,
        }),
      });
      if (abortController.signal.aborted) {
        interruptActiveQuery();
      } else {
        abortController.signal.addEventListener("abort", interruptActiveQuery, { once: true });
      }

      for await (const message of activeQuery) {
        sessionId = sessionIdFromSdkMessage(message) ?? sessionId;
        const summary = summarizeSdkMessage(message);
        if (summary) {
          recentItems.push(summary);
          if (recentItems.length > 12) {
            recentItems.shift();
          }
        }
        if (message.type === "result") {
          if (message.subtype === "success") {
            resultText = message.result;
          } else {
            errorText = resultErrorText(message);
          }
        }
      }

      if (errorText) {
        return {
          sessionId,
          text: null,
          status: "error",
          error: errorText,
          recentItems,
        };
      }

      return {
        sessionId,
        text: resultText,
        status: "success",
        error: null,
        recentItems,
      };
    } catch (error) {
      return {
        sessionId,
        text: null,
        status: "error",
        error: abortController.signal.aborted
          ? "Claude Code turn was interrupted."
          : error instanceof Error ? error.message : String(error),
        recentItems,
      };
    } finally {
      abortController.signal.removeEventListener("abort", interruptActiveQuery);
      activeQuery?.close();
    }
  },
};

export function buildClaudeCodeQueryOptions(input: ClaudeCodeTurnInput): Options {
  return {
    cwd: input.cwd,
    resume: input.claudeSessionId?.trim() || undefined,
    model: input.model?.trim() || undefined,
    permissionMode: "default",
    pathToClaudeCodeExecutable: input.claudeBin?.trim() || undefined,
    strictMcpConfig: true,
    mcpServers: {},
    disallowedTools: [...CLAUDE_CODE_BLOCKED_TOOL_NAMES],
    canUseTool: input.canUseTool ?? claudeCodeDefaultCanUseTool,
    hooks: {
      PreToolUse: [{
        hooks: [claudeCodePreToolUseGuard],
      }],
    },
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP: "letagents-desktop/claude-code-runtime",
    },
  };
}

export const CLAUDE_CODE_AUTO_ALLOWED_TOOL_NAMES = MANAGED_AGENT_AUTO_ALLOWED_TOOL_NAMES;

export function isBlockedClaudeCodeTool(toolName: string | null | undefined): boolean {
  const normalized = normalizeToolName(toolName);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("mcp__letagents__")) {
    return true;
  }
  const tail = normalized.split("__").pop() ?? normalized;
  return CLAUDE_CODE_BLOCKED_TOOL_NAMES.some((blocked) =>
    tail === blocked || normalized === blocked
  );
}

export function isAutoAllowedClaudeCodeTool(toolName: string | null | undefined): boolean {
  return isAutoAllowedManagedAgentTool(toolName);
}

export function allowClaudeCodeToolUse(
  input: Record<string, unknown>,
  toolUseID: string,
): PermissionResult {
  return {
    behavior: "allow",
    updatedInput: input,
    toolUseID,
  };
}

export const claudeCodeDefaultCanUseTool: CanUseTool = async (
  toolName,
  input,
  options,
): Promise<PermissionResult> => {
  if (isBlockedClaudeCodeTool(toolName)) {
    return {
      behavior: "deny",
      message: "Managed Claude Code sessions may not call LetAgents room, rental, or provisioning tools.",
      toolUseID: options.toolUseID,
    };
  }
  if (isAutoAllowedClaudeCodeTool(toolName)) {
    return allowClaudeCodeToolUse(input, options.toolUseID);
  }
  return {
    behavior: "deny",
    message: "Managed Claude Code needs a LetAgents Desktop approval before using this tool, but no approval bridge is available.",
    toolUseID: options.toolUseID,
  };
};

export const claudeCodePreToolUseGuard: HookCallback = async (
  input,
  toolUseID,
): Promise<HookJSONOutput> => {
  if (!isPreToolUseInput(input) || !isBlockedClaudeCodeTool(input.tool_name)) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "defer",
      },
    };
  }

  return {
    decision: "block",
    reason: "LetAgents Desktop owns room coordination and blocks rental/provisioning tools in managed Claude Code sessions.",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Managed Claude Code sessions may not call LetAgents room, rental, or provisioning tools.",
    },
    systemMessage: "Blocked a tool call that managed Claude Code sessions are not allowed to use.",
    stopReason: `Blocked tool call: ${input.tool_name}`,
    suppressOutput: true,
  };
};

function sessionIdFromSdkMessage(message: SDKMessage): string | null {
  const value = (message as { session_id?: unknown }).session_id;
  return typeof value === "string" && value.trim() ? value : null;
}

function isPreToolUseInput(input: unknown): input is PreToolUseHookInput {
  return Boolean(
    input &&
    typeof input === "object" &&
    (input as { hook_event_name?: unknown }).hook_event_name === "PreToolUse" &&
    typeof (input as { tool_name?: unknown }).tool_name === "string",
  );
}

function normalizeToolName(toolName: string | null | undefined): string {
  return String(toolName ?? "").trim().toLowerCase();
}

function summarizeSdkMessage(message: SDKMessage): Record<string, unknown> | null {
  if (message.type === "assistant") {
    const text = assistantText(message);
    return text ? { type: "assistant", text } : { type: "assistant" };
  }
  if (message.type === "result") {
    return summarizeResultMessage(message);
  }
  if (message.type === "system" && message.subtype === "init") {
    return summarizeSystemMessage(message);
  }
  if (message.type === "tool_use_summary") {
    return {
      type: "tool_use_summary",
      summary: (message as { summary?: unknown }).summary ?? null,
    };
  }
  return null;
}

function assistantText(message: SDKAssistantMessage): string | null {
  const content = (message.message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : null;
  }

  const text = content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? candidate.text
        : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || null;
}

function summarizeResultMessage(message: SDKResultMessage): Record<string, unknown> {
  if (message.subtype === "success") {
    return {
      type: "result",
      subtype: message.subtype,
      stopReason: message.stop_reason,
      numTurns: message.num_turns,
      text: message.result,
    };
  }
  return {
    type: "result",
    subtype: message.subtype,
    stopReason: message.stop_reason,
    numTurns: message.num_turns,
    error: resultErrorText(message),
  };
}

function summarizeSystemMessage(message: SDKSystemMessage): Record<string, unknown> {
  return {
    type: "system",
    subtype: message.subtype,
    claudeCodeVersion: message.claude_code_version,
    cwd: message.cwd,
    model: message.model,
    permissionMode: message.permissionMode,
  };
}

function resultErrorText(message: Exclude<SDKResultMessage, { subtype: "success" }>): string {
  const errors = Array.isArray(message.errors)
    ? message.errors.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  return errors.join("\n") || `Claude Code ended with ${message.subtype}.`;
}
