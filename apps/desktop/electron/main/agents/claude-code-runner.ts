import {
  query,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeCodeTurnInput {
  prompt: string;
  cwd: string;
  claudeSessionId?: string | null;
  claudeBin?: string | null;
  abortController?: AbortController;
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

export const productionClaudeCodeRunner: ClaudeCodeRunner = {
  async runTurn(input: ClaudeCodeTurnInput): Promise<ClaudeCodeTurnResult> {
    const abortController = input.abortController ?? new AbortController();
    const executable = input.claudeBin?.trim();
    let activeQuery: Query | null = null;
    let sessionId: string | null = input.claudeSessionId?.trim() || null;
    let resultText: string | null = null;
    let errorText: string | null = null;
    const recentItems: Array<Record<string, unknown>> = [];

    try {
      activeQuery = query({
        prompt: input.prompt,
        options: {
          cwd: input.cwd,
          resume: sessionId || undefined,
          abortController,
          permissionMode: "default",
          pathToClaudeCodeExecutable: executable || undefined,
          env: {
            ...process.env,
            CLAUDE_AGENT_SDK_CLIENT_APP: "letagents-desktop/claude-code-runtime",
          },
        },
      });

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
      activeQuery?.close();
    }
  },
};

function sessionIdFromSdkMessage(message: SDKMessage): string | null {
  const value = (message as { session_id?: unknown }).session_id;
  return typeof value === "string" && value.trim() ? value : null;
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
