import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isAbsolute } from "node:path";
import { z, type ZodRawShape } from "zod";

import { registerTools } from "./register-tools.js";
import {
  runWithDaemonToolExecutionContext,
  type DaemonToolExecutionContext,
} from "./runtime/daemon-tool-context.js";
import { runWithSupervisedRoomAuthority } from "./runtime/supervised-room-authority.js";
import { durableCompletionResult, supervisedToolIsMutation } from "./supervised-tool-facade.js";

type ToolHandler = {
  callback: (input: unknown, extra: { requestId: string }) => Promise<CallToolResult> | CallToolResult;
  inputSchema: ZodRawShape | null;
};

const handlersByProvider = new Map<string, Map<string, ToolHandler>>();
const SUPERVISED_PROVIDERS = new Set(["claude-code", "cursor", "codex", "open-model"]);
const WORKSPACE_SCOPED_TOOLS = new Set(["check_repo", "check_repo_visibility", "initialize_repo"]);

function handlersForProvider(provider: string): Map<string, ToolHandler> {
  const normalizedProvider = provider.trim().toLowerCase();
  const existing = handlersByProvider.get(normalizedProvider);
  if (existing) return existing;

  const handlers = new Map<string, ToolHandler>();
  const recorder = {
    tool(name: string, ...registration: unknown[]) {
      const callback = registration.at(-1);
      if (typeof callback !== "function") throw new Error(`Tool ${name} has no callback.`);
      const schemaCandidate = registration.at(-2);
      const inputSchema = schemaCandidate && typeof schemaCandidate === "object" && !Array.isArray(schemaCandidate)
        ? schemaCandidate as ZodRawShape
        : null;
      handlers.set(name, { callback: callback as ToolHandler["callback"], inputSchema });
      return {};
    },
  } as unknown as McpServer;
  registerTools(recorder, "supervised_room_turn", normalizedProvider || null, { executionOwner: "daemon" });
  handlersByProvider.set(normalizedProvider, handlers);
  return handlers;
}

export type ExecuteDaemonToolInput = DaemonToolExecutionContext & {
  provider: string;
  toolName: string;
  input: unknown;
  requestId: string;
};

export type ExecuteDaemonToolResult = {
  liveResult: CallToolResult;
  durableResult: CallToolResult;
};

function validateExecutionContext(input: ExecuteDaemonToolInput): ExecuteDaemonToolInput {
  const provider = input.provider.trim().toLowerCase();
  const roomId = input.roomId.trim();
  const toolName = input.toolName.trim();
  const requestId = input.requestId.trim();
  if (!SUPERVISED_PROVIDERS.has(provider)) throw new Error(`Unsupported supervised provider: ${input.provider}`);
  if (!roomId || roomId.length > 1_024 || /[\u0000-\u001f\u007f]/.test(roomId)) {
    throw new Error("Daemon tool room authority is malformed.");
  }
  if (input.agentSession.room_id !== roomId || input.agentSession.session_kind !== "worker"
    || input.agentSession.runtime.trim().toLowerCase() !== provider || input.agentSession.ended_at) {
    throw new Error("Daemon tool worker session does not match its active room authority.");
  }
  if (!input.bearer.trim()) throw new Error("Daemon tool worker bearer is required.");
  if (!isAbsolute(input.cwd)) throw new Error("Daemon tool workspace must be an absolute path.");
  if (!toolName || !requestId) throw new Error("Daemon tool name and request id are required.");
  let apiUrl: URL;
  try {
    apiUrl = new URL(input.apiUrl);
  } catch {
    throw new Error("Daemon tool API URL is malformed.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (apiUrl.username || apiUrl.password
    || (apiUrl.protocol !== "https:"
      && !(apiUrl.protocol === "http:" && loopbackHosts.has(apiUrl.hostname.toLowerCase())))) {
    throw new Error("Daemon tool API URL must use HTTPS or an exact HTTP loopback host.");
  }
  return { ...input, provider, roomId, toolName, requestId, apiUrl: apiUrl.origin };
}

/**
 * Execute one already-authorized supervised tool inside daemon-owned,
 * request-scoped authority. The daemon owns journaling around this call; this
 * module only supplies the exact public MCP implementation from the pinned
 * runtime, without recursively crossing the supervisor bridge.
 */
export async function executeDaemonTool(input: ExecuteDaemonToolInput): Promise<ExecuteDaemonToolResult> {
  const context = validateExecutionContext(input);
  const tool = handlersForProvider(context.provider).get(context.toolName);
  if (!tool) throw new Error(`Unsupported supervised tool: ${context.toolName}`);
  const parsedInput = tool.inputSchema
    ? await z.object(tool.inputSchema).parseAsync(context.input)
    : context.input;
  const authorizedInput = WORKSPACE_SCOPED_TOOLS.has(context.toolName)
    && parsedInput && typeof parsedInput === "object" && !Array.isArray(parsedInput)
    ? { ...parsedInput, cwd: context.cwd }
    : parsedInput;
  const liveResult = await runWithDaemonToolExecutionContext(context, () =>
    runWithSupervisedRoomAuthority(context.roomId, () =>
      tool.callback(authorizedInput, { requestId: context.requestId })));
  return {
    liveResult,
    durableResult: durableCompletionResult(liveResult, supervisedToolIsMutation(context.toolName)),
  };
}

export { supervisedToolIsMutation };
