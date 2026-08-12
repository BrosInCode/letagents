import type { ProviderSpawnRequest } from "./provider-adapter.js";

export const OPEN_MODEL_OPENCODE_PROVIDER_ID = "letagents-open-model";
export const OPENCODE_SERVER_USERNAME = "opencode";
// A supervised room turn needs enough room for tool work and a useful final
// response, but it must not reserve the very large generation budgets exposed
// by arbitrary OpenRouter models. Providers commonly authorize or bill against
// the requested maximum before generating the first token.
export const SUPERVISED_OPEN_MODEL_OUTPUT_TOKEN_LIMIT = 8_192;

export type OpenCodeConfig = Record<string, unknown>;

const INHERITED_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

const SUPERVISOR_COORDINATE_KEYS = [
  "LETAGENTS_SUPERVISOR_ENTRY_ID",
  "LETAGENTS_SUPERVISOR_DAEMON_SOCKET",
  "LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID",
  "LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID",
  "LETAGENTS_SUPERVISOR_AGENT_SESSION_ID",
  "LETAGENTS_SUPERVISOR_ROOM_ID",
] as const;

/**
 * Production credential boundary installed into the exact OpenCode runtime.
 * The contract smoke imports this same source, so evidence cannot drift from
 * the plugin that supervised agents actually execute.
 */
export function credentialBoundaryPluginSource(): string {
  return [
    "export default async () => ({",
    '  "shell.env": (_input, output) => {',
    '    output.env.OPENCODE_AUTH_CONTENT = "";',
    '    output.env.OPENCODE_CONFIG_CONTENT = "";',
    '    output.env.OPENCODE_SERVER_PASSWORD = "";',
    '    output.env.OPENCODE_SERVER_USERNAME = "";',
    "  },",
    "});",
    "",
  ].join("\n");
}

export function supervisedOpenCodeMcpEnvironment(
  request: ProviderSpawnRequest,
  apiUrl: string,
): Record<string, string> {
  const environment: Record<string, string> = {
    LETAGENTS_API_URL: apiUrl,
    LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
    LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
    LETAGENTS_SUPERVISOR_ENTRY_ID: request.supervisorEntryId || "",
    LETAGENTS_SUPERVISOR_DAEMON_SOCKET: request.supervisorSocketPath || "",
    LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID: request.workAttemptId,
    LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID:
      request.supervisorExecutionGenerationId || "",
    LETAGENTS_SUPERVISOR_AGENT_SESSION_ID:
      request.supervisorWorkerSession?.agentSessionId || "",
    LETAGENTS_SUPERVISOR_ROOM_ID: request.roomId,
    LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME:
      request.agentDisplayName?.trim() || "Open Model agent",
    LETAGENTS_SUPERVISOR_PROVIDER: "open-model",
    // An OpenCode-managed MCP process inherits the server environment unless
    // explicitly overridden. Empty values are a second fence behind shell.env.
    OPENCODE_AUTH_CONTENT: "",
    OPENCODE_CONFIG_CONTENT: "",
    OPENCODE_SERVER_PASSWORD: "",
    OPENCODE_SERVER_USERNAME: "",
  };
  for (const key of SUPERVISOR_COORDINATE_KEYS) {
    if (!environment[key]) {
      throw new Error(`Open Model supervised launch is missing ${key}.`);
    }
  }
  return environment;
}

export function openCodeConfig(input: {
  model: string;
  baseUrl: string;
  pluginUrl: string;
  cwd: string;
  mcpCommand: string[];
  mcpEnvironment: Record<string, string>;
}): OpenCodeConfig {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    formatter: false,
    lsp: false,
    model: `${OPEN_MODEL_OPENCODE_PROVIDER_ID}/${input.model}`,
    plugin: [input.pluginUrl],
    permission: { "*": "allow" },
    provider: {
      [OPEN_MODEL_OPENCODE_PROVIDER_ID]: {
        id: OPEN_MODEL_OPENCODE_PROVIDER_ID,
        name: "LetAgents Open Model",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { baseURL: input.baseUrl },
        models: {
          [input.model]: {
            id: input.model,
            name: input.model,
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            release_date: "2025-01-01",
            limit: {
              context: 1_000_000,
              output: SUPERVISED_OPEN_MODEL_OUTPUT_TOKEN_LIMIT,
            },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
      },
    },
    mcp: {
      letagents: {
        type: "local",
        command: input.mcpCommand,
        cwd: input.cwd,
        environment: input.mcpEnvironment,
        enabled: true,
      },
    },
  };
}

export function openCodeAuthContent(apiKey: string | null): string {
  return apiKey
    ? JSON.stringify({
      [OPEN_MODEL_OPENCODE_PROVIDER_ID]: { type: "api", key: apiKey },
    })
    : "{}";
}

export function minimalOpenCodeEnvironment(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return {
    ...environment,
    // The supervised provider is fully declared in OPENCODE_CONFIG_CONTENT,
    // so OpenCode's models.dev catalog refresh is dead weight: on degraded
    // networks it stalls startup and floods the log with fetch timeouts.
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    ...extra,
  };
}

export function parseConfiguredOpenModel(config: OpenCodeConfig): string | null {
  const model = typeof config.model === "string" ? config.model : "";
  const prefix = `${OPEN_MODEL_OPENCODE_PROVIDER_ID}/`;
  return model.startsWith(prefix) && model.length > prefix.length
    ? model.slice(prefix.length)
    : null;
}
