import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { desktopRuntimeEnvironment } from "../desktop-shell-environment.js";

import { codexOwnerIsolationOverrides } from "../../../../../shared/codex-owner-isolation.mjs";
import { CODEX_TOKEN_SERVICE_OVERRIDES, codexHomeForSandboxedLaunch } from "./codex-agent-home.js";
import { codexHomeHarnessOverrides, runCodexMcpListForLaunch } from "./codex-home-harness.js";
import { managedAgentCommitEnvironment } from "./managed-agent-commit-identity.js";
import { isRentalCredentialIsolationRequested, rentalIsolatedChildEnvironment } from "./rental-child-environment.js";
import { withoutRoomAuthority } from "./room-authority-environment.js";

const DEFAULT_SERVER_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CAPTURED_OUTPUT_CHARS = 12_000;
const MAX_DIAGNOSTIC_OUTPUT_CHARS = 4_000;
const EXIT_OUTPUT_CLOSE_TIMEOUT_MS = 500;
const MIN_PARTIAL_REDACTION_CHARS = 6;
const EXIT_AFTER_TIMEOUT_GRACE_MS = EXIT_OUTPUT_CLOSE_TIMEOUT_MS + 100;

export type CodexAppServerExit =
  | { type: "error"; error: Error; output?: CodexAppServerOutput }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null; output?: CodexAppServerOutput };

export interface CodexAppServerOutput {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface CodexAppServerLaunch {
  pid: number | null;
  exited: Promise<CodexAppServerExit>;
  /** The Codex home this launch was given in place of the owner's. */
  codexHome?: string;
  /** What the owner is to be told about this launch. */
  notices?: readonly string[];
  /**
   * For a launch whose sandbox lets a command write the project: why a folder
   * the Codex config lets it write too, as named at this launch, may not be
   * written now. Null while there is none. Asked again before each turn.
   */
  writableFoldersCheck?: () => string | null;
}

interface CodexAppServerLaunchOptions {
  /**
   * Where the app-server starts, and the project whose Git config decides
   * the commit identity. The name is historical: the launch passes Codex no
   * project trust.
   */
  trustedProjectPath?: string | null;
  configOverrides?: string[];
  env?: Record<string, string>;
  /** GIT_AUTHOR_* and GIT_COMMITTER_* resolved for this project before launch. */
  commitEnvironment?: Record<string, string>;
  /**
   * The owner lets this agent use their own Codex setup, so a managed launch
   * leaves their extensions on. Only an exact `true` does, and never for a
   * rental. The caller must give the room's server its own environment in
   * `configOverrides`: the process environment then carries none of it.
   */
  homeHarness?: boolean;
  /**
   * The agent's access level has a sandbox. A managed launch then gives Codex
   * a home without the owner's saved command rules, which let a matching
   * command out of the sandbox, or does not start.
   */
  sandboxed?: boolean;
  /** That sandbox lets a command write the project, so the folders the Codex config adds to it are checked. */
  writableSandbox?: boolean;
  /** The Codex home for this launch, in place of the owner's. A managed launch sets it. */
  codexHome?: string;
}

function readyUrlFromServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/readyz";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function isCodexAppServerReady(serverUrl: string): Promise<boolean> {
  try {
    const response = await fetch(readyUrlFromServerUrl(serverUrl), {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForCodexAppServer(
  serverUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isCodexAppServerReady(serverUrl)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function describeCodexAppServerExit(exit: CodexAppServerExit): string {
  const output = formatCodexAppServerOutput(exit.output);
  const suffix = output ? `: ${output}` : "";
  if (exit.type === "error") {
    return `${exit.error.message}${suffix}`;
  }
  if (exit.signal) {
    return `signal ${exit.signal}${suffix}`;
  }
  return `code ${exit.code ?? "unknown"}${suffix}`;
}

export async function waitForLaunchedCodexAppServer(
  serverUrl: string,
  launch: CodexAppServerLaunch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  let exit: CodexAppServerExit | null = null;
  let exitSettled = false;
  const exitPromise = launch.exited.then((value) => {
    exit = value;
    exitSettled = true;
    return false;
  });
  const ready = await Promise.race([
    waitForCodexAppServer(serverUrl, timeoutMs),
    exitPromise,
  ]);
  if (ready) {
    return true;
  }
  if (exit) {
    throw new Error(`Codex app-server exited before it became ready: ${describeCodexAppServerExit(exit)}`);
  }
  await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(resolve, EXIT_AFTER_TIMEOUT_GRACE_MS)),
  ]);
  if (exitSettled && exit) {
    throw new Error(`Codex app-server exited before it became ready: ${describeCodexAppServerExit(exit)}`);
  }
  return false;
}

async function allocateLoopbackServerUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DEFAULT_SERVER_HOST, () => resolve());
  });

  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  if (!address || typeof address === "string") {
    throw new Error("Unable to allocate a loopback Codex app-server port.");
  }

  return `ws://${DEFAULT_SERVER_HOST}:${address.port}`;
}

export async function resolveCodexAppServerUrl(
  explicitServerUrl?: string | null,
  options: { dedicated?: boolean } = {},
): Promise<string> {
  if (explicitServerUrl?.trim()) {
    return explicitServerUrl.trim();
  }

  // Dedicated servers carry per-session launch config (e.g. BYOK model
  // providers), so they must not reuse a shared app-server URL.
  if (!options.dedicated) {
    const configuredServerUrl = process.env.LETAGENTS_CODEX_SERVER_URL?.trim();
    if (configuredServerUrl) {
      return configuredServerUrl;
    }
  }

  return allocateLoopbackServerUrl();
}

function createCodexAppServerOutputCapture(
  redactions: string[],
): {
  append: (source: "stdout" | "stderr", chunk: string | Buffer) => void;
  snapshot: () => CodexAppServerOutput;
} {
  const output: CodexAppServerOutput = {
    stdout: "",
    stderr: "",
    truncated: false,
  };

  const append = (source: "stdout" | "stderr", chunk: string | Buffer) => {
    if (output[source].length >= MAX_CAPTURED_OUTPUT_CHARS) {
      output.truncated = true;
      return;
    }

    const raw = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const remaining = MAX_CAPTURED_OUTPUT_CHARS - output[source].length;
    output[source] += raw.slice(0, remaining);
    if (raw.length > remaining) {
      output.truncated = true;
    }
  };

  return {
    append,
    snapshot: () => ({
      stdout: redactCodexAppServerOutput(output.stdout, redactions),
      stderr: redactCodexAppServerOutput(output.stderr, redactions),
      truncated: output.truncated,
    }),
  };
}

function codexAppServerRedactionFragments(redactions: string[]): string[] {
  const fragments = new Set<string>();
  for (const value of redactions) {
    if (value.length < 4) continue;
    fragments.add(value);

    if (value.length <= MIN_PARTIAL_REDACTION_CHARS) continue;
    const maxPartialLength = Math.min(value.length - 1, 64);
    for (let length = maxPartialLength; length >= MIN_PARTIAL_REDACTION_CHARS; length -= 1) {
      const prefix = value.slice(0, length);
      const suffix = value.slice(-length);
      if (/[^A-Za-z0-9]/.test(prefix)) {
        fragments.add(prefix);
      }
      if (/[^A-Za-z0-9]/.test(suffix)) {
        fragments.add(suffix);
      }
    }
  }

  return [...fragments].sort((a, b) => b.length - a.length);
}

function decodeUrlComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function pushUrlSecretRedactions(rawValue: string, redactions: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    return;
  }

  const hasUserInfo = Boolean(parsed.username || parsed.password);
  const sensitiveQueryValues: string[] = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    if (/(api[_-]?key|token|secret|password|authorization|auth|key)/i.test(key) && value) {
      sensitiveQueryValues.push(value);
      const decodedValue = decodeUrlComponent(value);
      if (decodedValue && decodedValue !== value) {
        sensitiveQueryValues.push(decodedValue);
      }
    }
  }

  if (!hasUserInfo && sensitiveQueryValues.length === 0) {
    return;
  }

  redactions.push(rawValue, parsed.toString());
  for (const value of [parsed.username, parsed.password]) {
    if (!value) continue;
    redactions.push(value);
    const decodedValue = decodeUrlComponent(value);
    if (decodedValue && decodedValue !== value) {
      redactions.push(decodedValue);
    }
  }
  redactions.push(...sensitiveQueryValues);
}

function parseCodexConfigOverrideValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function redactCodexAppServerOutput(output: string, redactions: string[]): string {
  let sanitized = output.replace(
    /(authorization:\s*bearer\s+)[^\s"']+/gi,
    "$1[redacted]",
  );
  sanitized = sanitized.replace(/\bsk-or-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
  sanitized = sanitized.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");

  for (const value of codexAppServerRedactionFragments(redactions)) {
    sanitized = sanitized.split(value).join("[redacted]");
  }

  return sanitized;
}

export function firstRedactedCodexAppServerOutputLine(
  stdout: string,
  stderr: string,
  redactions: string[],
): string | null {
  const line = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  return line ? redactCodexAppServerOutput(line, redactions) : null;
}

function formatCodexAppServerOutput(output?: CodexAppServerOutput): string | null {
  if (!output) return null;
  const stderr = output.stderr.trim();
  const stdout = output.stdout.trim();
  const text = stderr || stdout;
  if (!text) {
    return output.truncated ? "process output was truncated before diagnostics were captured" : null;
  }

  const clipped = text.length > MAX_DIAGNOSTIC_OUTPUT_CHARS
    ? `${text.slice(0, MAX_DIAGNOSTIC_OUTPUT_CHARS).trimEnd()}...`
    : text;
  const source = stderr ? "stderr" : "stdout";
  const truncated = output.truncated || text.length > MAX_DIAGNOSTIC_OUTPUT_CHARS
    ? " (truncated)"
    : "";
  return `${source}${truncated}: ${clipped}`;
}

export function sensitiveCodexAppServerEnvValues(env?: NodeJS.ProcessEnv): string[] {
  if (!env) return [];
  return [...new Set(Object.entries(env).flatMap(([key, value]) => {
    if (
      value &&
      /(api[_-]?key|token|secret|password|authorization|auth)/i.test(key)
    ) {
      return [value];
    }
    return [];
  }))];
}

export function sensitiveCodexAppServerConfigValues(configOverrides?: string[]): string[] {
  const redactions: string[] = [];
  for (const override of configOverrides ?? []) {
    const separatorIndex = override.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = override.slice(0, separatorIndex).trim();
    const value = parseCodexConfigOverrideValue(override.slice(separatorIndex + 1));
    if (!value) continue;

    if (/(api[_-]?key|token|secret|password|authorization|auth)/i.test(key)) {
      redactions.push(value);
    }
    if (/(^|[._-])(base[_-]?url|url|endpoint)$/i.test(key)) {
      pushUrlSecretRedactions(value, redactions);
    }
  }
  return [...new Set(redactions)];
}

function sensitiveCodexAppServerLaunchValues(
  env: NodeJS.ProcessEnv,
  options: CodexAppServerLaunchOptions,
): string[] {
  return [
    ...sensitiveCodexAppServerEnvValues(env),
    ...sensitiveCodexAppServerConfigValues(options.configOverrides),
  ];
}

function unrefReadableStream(stream: unknown): void {
  (stream as { unref?: () => void } | null)?.unref?.();
}

function childExitPromise(
  child: ChildProcess,
  outputCapture?: ReturnType<typeof createCodexAppServerOutputCapture>,
): Promise<CodexAppServerExit> {
  return new Promise((resolve) => {
    let settled = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let close: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let closeTimeout: NodeJS.Timeout | null = null;
    const settle = (exit: CodexAppServerExit) => {
      if (settled) return;
      settled = true;
      if (closeTimeout) {
        clearTimeout(closeTimeout);
      }
      resolve(exit);
    };
    const settleExit = (output = outputCapture?.snapshot()) => {
      if (!exit) return;
      settle({
        type: "exit",
        code: exit.code,
        signal: exit.signal,
        output,
      });
    };

    child.once("error", (error) => {
      settle({ type: "error", error, output: outputCapture?.snapshot() });
    });
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      if (close) {
        settleExit();
        return;
      }
      closeTimeout = setTimeout(() => {
        settleExit(outputCapture
          ? { stdout: "", stderr: "", truncated: true }
          : undefined);
      }, EXIT_OUTPUT_CLOSE_TIMEOUT_MS);
      closeTimeout.unref?.();
    });
    child.once("close", (code, signal) => {
      close = { code, signal };
      if (!exit) return;
      settleExit();
    });
  });
}

export function codexAppServerLaunchArgs(
  serverUrl: string,
  options: CodexAppServerLaunchOptions = {},
): string[] {
  const args = ["app-server"];
  for (const override of options.configOverrides ?? []) {
    args.push("-c", override);
  }
  args.push("--listen", serverUrl);
  return args;
}

/**
 * The exact environment a launch gives the Codex app-server, and the commit
 * identity it carries. Rental children keep only their isolated variables and
 * never carry the owner's identity.
 */
export function codexAppServerEnvironment(
  options: Pick<CodexAppServerLaunchOptions, "env" | "commitEnvironment" | "homeHarness" | "codexHome"> = {},
): { env: NodeJS.ProcessEnv; commitEnvironment: Record<string, string>; rental: boolean } {
  const runtimeEnv = desktopRuntimeEnvironment();
  const configuredEnv = options.env && Object.keys(options.env).length
    ? { ...runtimeEnv, ...options.env }
    : runtimeEnv;
  const custodialPolling = configuredEnv.LETAGENTS_EXECUTION_PROFILE === "supervised_mcp_polling";
  const rental = isRentalCredentialIsolationRequested(configuredEnv);
  const commitEnvironment = rental ? {} : options.commitEnvironment ?? {};
  const env = rental
    ? rentalIsolatedChildEnvironment(configuredEnv)
    : { ...configuredEnv, ...commitEnvironment };
  if (rental || configuredEnv.LETAGENTS_SUPERVISED_BOUNDED_TURNS === "1" || custodialPolling) {
    // A custodial supervised worker borrows exact-generation authority from the
    // daemon. Ambient desktop owner or fixed worker credentials would bypass
    // that fence and would also leak into provider-started shell commands.
    delete env.LETAGENTS_TOKEN;
    delete env.LETAGENTS_AGENT_SESSION_BEARER;
    if (custodialPolling) {
      delete env.LETAGENTS_SUPERVISED_BOUNDED_TURNS;
      delete env.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID;
    }
  }
  // Codex hands its own environment to every hook, the notifier and every
  // command. With the owner's setup on those are the owner's programs, so the
  // room agent's coordinates stay out of it; the room's server has its own copy.
  const launchEnv = { ...(options.homeHarness === true && !rental ? withoutRoomAuthority(env) : env) };
  // Codex sends its sign-in tokens where these say. No launch inherits one, whatever this process was started with.
  for (const key of CODEX_TOKEN_SERVICE_OVERRIDES) delete launchEnv[key];
  // Set last, so a rental's isolated environment carries it too.
  if (options.codexHome) launchEnv.CODEX_HOME = options.codexHome;
  return { env: launchEnv, commitEnvironment, rental };
}

/**
 * Codex builds each command's environment from its shell policy, which an
 * owner may set to drop inherited variables. Setting the identity there as
 * well keeps it on every command the agent runs.
 */
export function codexCommitIdentityOverrides(commitEnvironment: Record<string, string>): string[] {
  return Object.entries(commitEnvironment)
    .map(([key, value]) => `shell_environment_policy.set.${key}=${JSON.stringify(value)}`);
}

export function launchCodexAppServer(
  serverUrl: string,
  codexBin: string,
  options: CodexAppServerLaunchOptions = {},
): CodexAppServerLaunch {
  const { env, commitEnvironment } = codexAppServerEnvironment(options);
  options = {
    ...options,
    configOverrides: [...codexCommitIdentityOverrides(commitEnvironment), ...(options.configOverrides ?? [])],
  };
  const outputCapture = createCodexAppServerOutputCapture(
    sensitiveCodexAppServerLaunchValues(env, options),
  );
  const child = spawn(codexBin, codexAppServerLaunchArgs(serverUrl, options), {
    cwd: options.trustedProjectPath?.trim() || undefined,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  child.stdout?.on("data", (chunk) => outputCapture.append("stdout", chunk));
  child.stderr?.on("data", (chunk) => outputCapture.append("stderr", chunk));
  unrefReadableStream(child.stdout);
  unrefReadableStream(child.stderr);
  const exited = childExitPromise(child, outputCapture);
  child.unref();
  return {
    pid: child.pid ?? null,
    exited,
    ...(options.codexHome ? { codexHome: options.codexHome } : {}),
  };
}

/**
 * Launch a managed agent's app-server without the owner's Codex extensions:
 * no plugins, app connectors, computer or browser use, hooks, memories,
 * notifier or personal skills, and no MCP server but the room's own, like
 * Claude's --strict-mcp-config. Codex itself names the servers, from the
 * owner's config and the config of any project that config trusts; a launch
 * that cannot get that list, or whose project changes the LetAgents server,
 * fails. The launch passes no project trust of its own. A project
 * that would commit as the host's global Git identity commits as the owner's
 * GitHub noreply identity instead. When the owner has turned their own setup
 * on for this agent, only the extensions are left alone; the rest holds.
 * At a sandboxed access level, with or without that setup, Codex gets a home
 * without the owner's saved command rules.
 */
export async function launchManagedCodexAppServer(
  serverUrl: string,
  codexBin: string,
  options: CodexAppServerLaunchOptions = {},
): Promise<CodexAppServerLaunch> {
  const { env: ownerHomeEnv, rental } = codexAppServerEnvironment({ ...options, codexHome: undefined });
  const trustedProjectPath = options.trustedProjectPath?.trim() || undefined;
  // Decided before anything else is asked of Codex, so every listing below reads the home the launch will.
  const home = options.sandboxed === true
    ? await codexHomeForSandboxedLaunch(codexBin, { cwd: trustedProjectPath, env: ownerHomeEnv, writableSandbox: options.writableSandbox === true })
    : null;
  const codexHome = home?.codexHome ?? undefined;
  const env = codexHome ? { ...ownerHomeEnv, CODEX_HOME: codexHome } : ownerHomeEnv;
  // The launch's own directory and overrides, so the server list matches.
  const view = { cwd: trustedProjectPath, env, configOverrides: options.configOverrides ?? [] };
  const [isolation, commitEnvironment] = await Promise.all([
    // Either way, a listing that fails says why and never its command line.
    options.homeHarness === true && !rental
      ? codexHomeHarnessOverrides(codexBin, view)
      : codexOwnerIsolationOverrides(codexBin, view, runCodexMcpListForLaunch),
    rental ? {} : managedAgentCommitEnvironment(trustedProjectPath),
  ]);
  const launch = launchCodexAppServer(serverUrl, codexBin, {
    ...options,
    commitEnvironment,
    configOverrides: [...isolation, ...(options.configOverrides ?? [])],
    codexHome,
  });
  return { ...launch, ...(home?.notices.length ? { notices: home.notices } : {}), ...(home?.writableFoldersCheck ? { writableFoldersCheck: home.writableFoldersCheck } : {}) };
}

export function terminateSpawnedProcess(pid: number): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGTERM");
      return;
    }
  } catch {
    // Fall through to direct process termination.
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}
