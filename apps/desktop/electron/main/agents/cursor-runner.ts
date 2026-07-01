import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type CursorReadOnlyMode = "ask" | "plan";
export type CursorSandboxMode = "enabled" | "disabled";

export interface CursorTurnInput {
  prompt: string;
  cwd: string;
  cursorSessionId?: string | null;
  cursorBin?: string | null;
  env?: Record<string, string | undefined>;
  mode?: CursorReadOnlyMode | null;
  force?: boolean;
  sandbox?: CursorSandboxMode | null;
  abortController?: AbortController;
}

export interface CursorTurnResult {
  sessionId: string | null;
  text: string | null;
  status: "success" | "error";
  error: string | null;
  recentItems: Array<Record<string, unknown>>;
}

export interface CursorRunner {
  runTurn(input: CursorTurnInput): Promise<CursorTurnResult>;
}

type CursorStreamEvent = Record<string, unknown> & {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: unknown;
  is_error?: unknown;
};

export interface CursorStreamState {
  sessionId: string | null;
  resultText: string | null;
  errorText: string | null;
  sawFinalResult: boolean;
  recentItems: Array<Record<string, unknown>>;
}

export const productionCursorRunner: CursorRunner = {
  runTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
    return runCursorTurn(input);
  },
};

export function buildCursorAgentArgs(input: CursorTurnInput): string[] {
  const mode = input.mode === null ? null : input.mode ?? "ask";
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--trust",
    "--workspace",
    input.cwd,
  ];
  if (mode) {
    args.push("--mode", mode);
  }
  if (input.force) {
    args.push("--force");
  }
  if (input.sandbox) {
    args.push("--sandbox", input.sandbox);
  }
  const resume = input.cursorSessionId?.trim();
  if (resume) {
    args.push("--resume", resume);
  }
  args.push(input.prompt);
  return args;
}

export async function runCursorTurn(input: CursorTurnInput): Promise<CursorTurnResult> {
  const executable = input.cursorBin?.trim() || process.env.LETAGENTS_CURSOR_AGENT_BIN || "cursor-agent";
  const abortController = input.abortController ?? new AbortController();
  const state: CursorStreamState = {
    sessionId: input.cursorSessionId?.trim() || null,
    resultText: null,
    errorText: null,
    sawFinalResult: false,
    recentItems: [],
  };
  let stderr = "";
  let parseError: string | null = null;

  return new Promise((resolve) => {
    const child = spawn(executable, buildCursorAgentArgs(input), {
      cwd: input.cwd,
      env: buildCursorChildEnv(input.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const interrupt = (): void => {
      child.kill("SIGINT");
    };

    if (abortController.signal.aborted) {
      interrupt();
    } else {
      abortController.signal.addEventListener("abort", interrupt, { once: true });
    }

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      try {
        applyCursorStreamEvent(state, JSON.parse(trimmed) as CursorStreamEvent);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    });

    child.on("error", (error) => {
      abortController.signal.removeEventListener("abort", interrupt);
      resolve({
        sessionId: state.sessionId,
        text: null,
        status: "error",
        error: error.message,
        recentItems: state.recentItems,
      });
    });

    child.on("close", (code, signal) => {
      abortController.signal.removeEventListener("abort", interrupt);
      if (parseError) {
        resolve({
          sessionId: state.sessionId,
          text: null,
          status: "error",
          error: `Cursor emitted malformed stream-json: ${parseError}`,
          recentItems: state.recentItems,
        });
        return;
      }
      if (state.errorText) {
        resolve({
          sessionId: state.sessionId,
          text: null,
          status: "error",
          error: state.errorText,
          recentItems: state.recentItems,
        });
        return;
      }
      if (state.sawFinalResult) {
        resolve({
          sessionId: state.sessionId,
          text: state.resultText,
          status: "success",
          error: null,
          recentItems: state.recentItems,
        });
        return;
      }
      const interrupted = abortController.signal.aborted || code === 130 || signal === "SIGINT";
      resolve({
        sessionId: state.sessionId,
        text: null,
        status: "error",
        error: interrupted
          ? "Cursor turn was interrupted."
          : firstNonEmptyLine(stderr) || `Cursor exited without a final result (code ${code ?? "unknown"}).`,
        recentItems: state.recentItems,
      });
    });
  });
}

export function buildCursorChildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  copyAllowedCursorEnv(env, process.env);
  copyAllowedCursorEnv(env, overrides);
  return env;
}

const CURSOR_CHILD_ENV_ALLOWLIST = new Set([
  "COMSPEC",
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "CURSOR_CONFIG_DIR",
  "CURSOR_DATA_DIR",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_COMPILE_CACHE",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "Path",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

function copyAllowedCursorEnv(
  destination: NodeJS.ProcessEnv,
  source: Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && CURSOR_CHILD_ENV_ALLOWLIST.has(key)) {
      destination[key] = value;
    }
  }
}

export function applyCursorStreamEvent(state: CursorStreamState, event: CursorStreamEvent): void {
  if (typeof event.session_id === "string" && event.session_id.trim()) {
    state.sessionId = event.session_id;
  }
  const summary = summarizeCursorStreamEvent(event);
  if (summary) {
    state.recentItems.push(summary);
    if (state.recentItems.length > 12) {
      state.recentItems.shift();
    }
  }
  if (event.type === "result") {
    state.sawFinalResult = true;
    if (event.subtype === "success" && event.is_error !== true) {
      state.resultText = typeof event.result === "string" ? event.result : null;
      return;
    }
    state.errorText = typeof event.result === "string" && event.result.trim()
      ? event.result
      : `Cursor result subtype was ${String(event.subtype ?? "unknown")}.`;
  }
}

function summarizeCursorStreamEvent(event: CursorStreamEvent): Record<string, unknown> | null {
  if (event.type === "system" && event.subtype === "init") {
    return {
      type: "system",
      subtype: "init",
      model: event.model ?? null,
      permissionMode: event.permissionMode ?? null,
    };
  }
  if (event.type === "assistant") {
    const text = assistantText(event);
    return text ? { type: "assistant", text } : { type: "assistant" };
  }
  if (event.type === "tool_call") {
    const toolCall = event.tool_call;
    return {
      type: "tool_call",
      subtype: event.subtype ?? null,
      callId: event.call_id ?? null,
      tool: cursorToolCallKind(toolCall),
      failed: cursorToolCallFailed(toolCall),
    };
  }
  if (event.type === "result") {
    return {
      type: "result",
      subtype: event.subtype ?? null,
      isError: event.is_error === true,
      text: typeof event.result === "string" ? event.result : null,
    };
  }
  return null;
}

function assistantText(event: CursorStreamEvent): string | null {
  const message = event.message;
  if (!message || typeof message !== "object") {
    return null;
  }
  const content = (message as { content?: unknown }).content;
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

function cursorToolCallKind(toolCall: unknown): string | null {
  if (!toolCall || typeof toolCall !== "object") {
    return null;
  }
  const keys = Object.keys(toolCall);
  return keys.find((key) => key.endsWith("ToolCall")) ?? null;
}

function cursorToolCallFailed(toolCall: unknown): boolean {
  if (!toolCall || typeof toolCall !== "object") {
    return false;
  }
  const values = Object.values(toolCall as Record<string, unknown>);
  return values.some((value) => {
    if (!value || typeof value !== "object") {
      return false;
    }
    const result = (value as { result?: unknown }).result;
    return Boolean(result && typeof result === "object" && "failure" in result);
  });
}

function firstNonEmptyLine(value: string): string | null {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}
