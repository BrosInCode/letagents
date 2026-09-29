import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProviderSpawnRequest } from "./provider-adapter.js";

export const OPEN_MODEL_OPENCODE_PROVIDER_ID = "letagents-open-model";
export const OPENCODE_SERVER_USERNAME = "opencode";
// A supervised room turn needs enough room for tool work and a useful final
// response, but it must not reserve the very large generation budgets exposed
// by arbitrary OpenRouter models. Providers commonly authorize or bill against
// the requested maximum before generating the first token.
export const SUPERVISED_OPEN_MODEL_OUTPUT_TOKEN_LIMIT = 8_192;

export type OpenCodeConfig = Record<string, unknown>;
export type SupervisedOpenCodePermissionProfileId = "full_access" | "ask_before_write";

export function supervisedOpenCodePermissionPolicy(
  profileId: SupervisedOpenCodePermissionProfileId,
): Record<string, "allow" | "ask"> {
  return profileId === "ask_before_write"
    ? { "*": "allow", edit: "ask", bash: "ask" }
    : { "*": "allow" };
}

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

const OPENCODE_PLUGIN_SDK_PACKAGE = "@opencode-ai/plugin";

/** File operations the config seed performs; replaceable so tests can fail one. */
export interface OpenCodeConfigSeedFileSystem {
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
  link: typeof link;
  unlink: typeof unlink;
}

/**
 * Marks a fresh runtime's OpenCode config directory as already provisioned.
 *
 * OpenCode installs its plugin SDK (~61MB) into every config directory that
 * has no `node_modules`, or whose lockfile does not lock the SDK by name, and
 * a configured plugin makes the first session wait for that install. Each
 * supervised runtime owns a fresh config directory, so every launch paid a
 * registry round trip that took seconds on a warm npm cache, tens of seconds
 * on a cold one, and over a minute when the registry was unreachable.
 *
 * The credential-boundary plugin imports nothing, so the SDK is dead weight
 * here. Existing files are never overwritten; only missing ones are added.
 * Each is staged and published with a hard link, so a write that fails or is
 * killed partway cannot leave a truncated file that every later launch would
 * preserve. A filesystem without hard links gets a direct write instead,
 * which keeps the seed at the cost of that guarantee.
 * The contract smoke proves against the pinned binary that this seed
 * suppresses the install.
 *
 * Only the runtime's own config directory is covered. OpenCode also installs
 * into a project's `.opencode` directories and into `~/.opencode`, which
 * belong to the user and may hold tools that need the SDK.
 */
export async function seedOpenCodeConfigHome(
  configHome: string,
  openCodeVersion: string,
  fileSystem: OpenCodeConfigSeedFileSystem = { mkdir, writeFile, link, unlink },
): Promise<void> {
  const directory = join(configHome, "opencode");
  await fileSystem.mkdir(join(directory, "node_modules"), { recursive: true, mode: 0o700 });
  const dependencies = { [OPENCODE_PLUGIN_SDK_PACKAGE]: openCodeVersion };
  const seeds: Array<[string, unknown]> = [
    ["package.json", { dependencies }],
    ["package-lock.json", {
      name: "opencode",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { dependencies } },
    }],
  ];
  for (const [name, value] of seeds) {
    const target = join(directory, name);
    const content = `${JSON.stringify(value, null, 2)}\n`;
    const exclusive = { encoding: "utf8", mode: 0o600, flag: "wx" } as const;
    const staged = join(directory, `.${name}.${randomBytes(6).toString("hex")}.seed`);
    try {
      await fileSystem.writeFile(staged, content, exclusive);
      // A hard link publishes the finished file atomically and, unlike a
      // rename, refuses to replace one that already exists.
      await fileSystem.link(staged, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code !== "ENOTSUP" && code !== "EPERM" && code !== "EXDEV" && code !== "ENOSYS") throw error;
      await fileSystem.writeFile(target, content, exclusive).catch((fallbackError) => {
        if ((fallbackError as NodeJS.ErrnoException).code !== "EEXIST") throw fallbackError;
      });
    } finally {
      await fileSystem.unlink(staged).catch(() => undefined);
    }
  }
}

/**
 * Keeps the owner's global `~/.claude/CLAUDE.md` out of a supervised agent.
 *
 * OpenCode puts one global instruction file into every system prompt: its own
 * `AGENTS.md` in the config directory when that file exists, otherwise the
 * owner's `~/.claude/CLAUDE.md`. An empty `AGENTS.md` in the runtime's own
 * config directory takes that place, and OpenCode adds nothing to the prompt
 * for an empty file. OpenCode looks again on every turn, so the file also
 * takes effect on a runtime that is already running.
 *
 * Project instruction files are untouched, including a project's `CLAUDE.md`
 * when it has no `AGENTS.md`. `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` would
 * drop both.
 *
 * Only that one file is covered. OpenCode still reads what the owner keeps
 * under `~/.opencode`. Its climb out of a workspace that is not a Git
 * repository is narrowed by `workspaceOpenCodeEnvironment`.
 *
 * The file is made empty on every call, whatever was there. Anything else
 * at that path is replaced, not written through, so a link named `AGENTS.md`
 * is never followed into a file that belongs to the owner. A file or a link
 * is replaced by a rename, which leaves no moment without a file for a
 * running OpenCode to fall through to the owner's. A directory has to be
 * removed first. The contract smoke proves the effect against the pinned
 * binary.
 */
export async function shieldOwnerInstructions(configHome: string): Promise<void> {
  const directory = join(configHome, "opencode");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, "AGENTS.md");
  const existing = await lstat(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  // A second name for the same file would let its other owner fill it.
  if (existing?.isFile() && existing.size === 0 && existing.nlink === 1) return;
  const staged = join(directory, `.AGENTS.md.${randomBytes(6).toString("hex")}.shield`);
  try {
    await writeFile(staged, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(staged, target).catch(async (error) => {
      // A rename replaces a file or a link, but not a directory.
      if (!existing?.isDirectory()) throw error;
      await rm(target, { recursive: true, force: true });
      await rename(staged, target);
    });
  } finally {
    await unlink(staged).catch(() => undefined);
  }
}

/**
 * Keeps OpenCode inside a room's scratch workspace.
 *
 * OpenCode looks for project files from the working directory up to the
 * root of its Git repository. A scratch workspace has no repository, so the
 * search climbs to the file system root: it reads `AGENTS.md`, `CLAUDE.md`,
 * `opencode.json` and `.opencode` directories from every directory above,
 * and the workspace lies under the owner's home. A scratch workspace has no
 * project files of its own, so the search is switched off for it.
 *
 * The setting does not cover plugins. OpenCode 1.18.20 has a second search
 * with no switch, and it still imports plugins from a `.opencode` directory
 * above the workspace and plugins named by an `opencode.json` there, inside
 * the server process. Only a project root at or above the workspace stops
 * that search, and for OpenCode a project root is a Git repository.
 *
 * A Git worktree is untouched: there the search stops at the repository root.
 * The kind is never guessed. A launch that does not say which it is would
 * otherwise be treated as a repository and left open.
 */
export function workspaceOpenCodeEnvironment(
  workspaceKind: ProviderSpawnRequest["workspaceKind"],
): Record<string, string> {
  if (workspaceKind === "room_scratch") return { OPENCODE_DISABLE_PROJECT_CONFIG: "1" };
  if (workspaceKind === "git_worktree") return {};
  throw new Error("Open Model launch requires an explicit workspace kind.");
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
  permissionProfileId?: SupervisedOpenCodePermissionProfileId;
}): OpenCodeConfig {
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    formatter: false,
    lsp: false,
    model: `${OPEN_MODEL_OPENCODE_PROVIDER_ID}/${input.model}`,
    plugin: [input.pluginUrl],
    permission: supervisedOpenCodePermissionPolicy(input.permissionProfileId ?? "full_access"),
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
    // OpenCode otherwise lists every skill under .claude/skills and
    // .agents/skills (the owner's home and the project) in each system prompt
    // and offers a tool to load them: about 14,000 characters for 18 personal
    // skills on 1.18.20. A supervised room agent takes its instructions from
    // LetAgents. OpenCode's own .opencode skills still load.
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
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
