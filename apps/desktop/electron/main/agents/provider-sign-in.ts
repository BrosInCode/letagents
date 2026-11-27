import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execProviderFile } from "../../../../../shared/provider-executable.mjs";
import { signalTree, spawnTree } from "../../../../../shared/process-tree.mjs";
import { plainTerminalText } from "../../../../../shared/live-command-output.mjs";
import type {
  DesktopAgentProviderId,
  DesktopProviderSignInUpdate,
} from "../../ipc-types.js";
import { clearProbeCache } from "#provider-runtime/provider-probe-cache.js";
import { getDesktopAgentProvider } from "./provider-registry.js";
import { providerCli } from "./provider-cli.js";

/** A sign-in that is not done in this time ends as failed. */
export const PROVIDER_SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_SIGN_IN_POLL_MS = 3_000;
const STATUS_CHECK_TIMEOUT_MS = 15_000;
/** The parser needs only the first screen of output; later output keeps the newest part. */
const OUTPUT_LIMIT_CHARS = 64_000;
const MESSAGE_LIMIT_CHARS = 300;

/**
 * How the app signs in to one provider. "process": the provider's own login
 * command runs as a child with pipes. "terminal": the provider has no login
 * command (Antigravity), so the app opens Terminal on the provider and checks
 * the sign-in until it passes.
 */
export type ProviderSignInPlan = {
  mode: "process" | "terminal";
  providerName: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The provider's own status check: true when it is signed in. */
  verify: () => Promise<boolean>;
};

export interface ParsedSignInOutput {
  url: string | null;
  code: string | null;
  acceptsCode: boolean;
  lastLine: string | null;
}

const URL_PATTERN = /https:\/\/[^\s"'<>`]+/g;
const DEVICE_CODE_PATTERN = /(?<![A-Za-z0-9-])[A-Z0-9]{4}-[A-Z0-9]{4,5}(?![A-Za-z0-9-])/g;
const PASTE_PROMPT_PATTERN = /\bpaste\b[^\n]*\bcode\b/i;

/** Reads what a provider's login command printed for the user: its link, its device code, and a paste prompt. */
export function parseSignInOutput(raw: string): ParsedSignInOutput {
  const text = plainTerminalText(raw);
  const url = text.match(URL_PATTERN)?.[0]?.replace(/[).,;:!?\]]+$/, "") ?? null;
  const code = text.replace(URL_PATTERN, " ")
    .match(DEVICE_CODE_PATTERN)
    ?.find((candidate) => /[A-Z]/.test(candidate)) ?? null;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const lastLine = [...lines].reverse().find((line) => !PASTE_PROMPT_PATTERN.test(line)) ?? null;
  return {
    url,
    code,
    acceptsCode: PASTE_PROMPT_PATTERN.test(text),
    lastLine: lastLine ? lastLine.slice(0, MESSAGE_LIMIT_CHARS) : null,
  };
}

function runStatusCheck(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execProviderFile(command, args, { env, timeout: STATUS_CHECK_TIMEOUT_MS }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
    child.stdin?.end();
  });
}

async function cursorSignedIn(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await runStatusCheck(command, ["status", "--format", "json"], env);
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    return parsed.isAuthenticated === true || parsed.status === "authenticated";
  } catch {
    return result.ok && !/not (?:logged|signed) in|unauthenticated|login required/i.test(`${result.stdout}\n${result.stderr}`);
  }
}

/**
 * Cursor's managed profiles copy the sign-in from the source home
 * (LETAGENTS_CURSOR_SOURCE_HOME, else the user's home), so the login writes
 * there. A Cursor key in the environment would replace the browser sign-in.
 */
export function cursorSignInEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  const sourceHome = base.LETAGENTS_CURSOR_SOURCE_HOME?.trim();
  if (sourceHome) env.HOME = sourceHome;
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_AUTH_TOKEN;
  return env;
}

/** The command, arguments and environment for one provider's sign-in: the same program and environment its preflight uses. */
export function resolveProviderSignInPlan(
  providerId: DesktopAgentProviderId,
  options: { base?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): ProviderSignInPlan {
  const provider = getDesktopAgentProvider(providerId);
  const providerName = provider?.name ?? providerId;
  if (!provider || !["codex", "claude-code", "cursor", "antigravity"].includes(providerId)) {
    throw new Error(`${providerName} has no sign-in that LetAgents can run.`);
  }
  const cli = providerCli(providerId, provider.runtimeCommand, options.base);
  if (providerId === "codex") {
    // The browser sign-in, answered on localhost: device-code sign-in is off
    // by default in ChatGPT's security settings, so many accounts refuse it.
    return {
      mode: "process", providerName, command: cli.command, args: ["login"], env: cli.env,
      verify: async () => (await runStatusCheck(cli.command, ["login", "status"], cli.env)).ok,
    };
  }
  if (providerId === "claude-code") {
    return {
      mode: "process", providerName, command: cli.command, args: ["auth", "login"], env: cli.env,
      verify: async () => (await runStatusCheck(cli.command, ["auth", "status"], cli.env)).ok,
    };
  }
  if (providerId === "cursor") {
    const env = cursorSignInEnvironment(cli.env);
    return {
      mode: "process", providerName, command: cli.command, args: ["login"], env,
      verify: () => cursorSignedIn(cli.command, env),
    };
  }
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("Run `agy` in a terminal once and sign in with Google, then choose Check again.");
  }
  return {
    mode: "terminal", providerName, command: cli.command, args: [], env: cli.env,
    verify: async () => {
      // The same keychain and token-file check as preflight. Loaded late:
      // the preflight module loads the whole setup surface.
      const { antigravitySignInKnownMissing } = await import("./providers.js");
      return !(await antigravitySignInKnownMissing());
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Opens macOS Terminal on the provider, with the provider's home and PATH. The script deletes itself when it runs. */
async function openTerminalSignIn(plan: ProviderSignInPlan): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), "letagents-sign-in-"));
  const script = join(folder, `Sign in to ${plan.providerName}.command`);
  const keys = ["HOME", "PATH", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "AGY_CLI_DISABLE_AUTO_UPDATE"];
  writeFileSync(script, [
    "#!/bin/sh",
    `rm -rf -- ${shellQuote(folder)}`,
    ...keys.flatMap((key) => plan.env[key] ? [`export ${key}=${shellQuote(plan.env[key]!)}`] : []),
    `exec ${shellQuote(plan.command)} ${plan.args.map(shellQuote).join(" ")}`.trimEnd(),
    "",
  ].join("\n"), { mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/open", ["-a", "Terminal", script], (error) => (error ? reject(error) : resolve()));
  });
}

function spawnSignInProcess(plan: ProviderSignInPlan): ChildProcess {
  // Its own process group on POSIX, so a cancel also ends what the login started.
  return spawnTree(plan.command, plan.args, {
    env: plan.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  }, { env: plan.env });
}

function stopSignInProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try { signalTree(pid, "SIGTERM", { child }); } catch { /* already gone */ }
  setTimeout(() => {
    try { signalTree(pid, "SIGKILL", { child, groupOnly: true }); } catch { /* already gone */ }
  }, 2_000).unref();
}

export interface ProviderSignInDependencies {
  resolvePlan: (providerId: DesktopAgentProviderId) => ProviderSignInPlan | Promise<ProviderSignInPlan>;
  spawnProcess: (plan: ProviderSignInPlan) => ChildProcess;
  stopProcess: (child: ChildProcess) => void;
  openTerminal: (plan: ProviderSignInPlan) => Promise<void>;
  /** Runs after a verified sign-in, before the signed_in update: the next preflight must probe again. */
  onSignedIn: (providerId: DesktopAgentProviderId) => void;
  timeoutMs: number;
  pollIntervalMs: number;
}

interface SignInSession {
  providerId: DesktopAgentProviderId;
  update: DesktopProviderSignInUpdate;
  plan: ProviderSignInPlan | null;
  child: ChildProcess | null;
  output: string;
  /** Output after the last submitted code: a new paste prompt means the provider asks again. */
  outputSinceCode: string;
  timeout: NodeJS.Timeout | null;
  poll: NodeJS.Timeout | null;
  finished: boolean;
}

/**
 * Runs one provider sign-in at a time per provider and reports each step.
 * Only what the provider prints for the user (its link and device code)
 * leaves this service; nothing is logged or saved.
 */
export class ProviderSignInService {
  private readonly deps: ProviderSignInDependencies;
  private readonly sessions = new Map<DesktopAgentProviderId, SignInSession>();
  private readonly listeners = new Set<(update: DesktopProviderSignInUpdate) => void>();

  constructor(deps: Partial<ProviderSignInDependencies> = {}) {
    this.deps = {
      resolvePlan: (providerId) => resolveProviderSignInPlan(providerId),
      spawnProcess: spawnSignInProcess,
      stopProcess: stopSignInProcess,
      openTerminal: openTerminalSignIn,
      onSignedIn: () => clearProbeCache(),
      timeoutMs: PROVIDER_SIGN_IN_TIMEOUT_MS,
      pollIntervalMs: TERMINAL_SIGN_IN_POLL_MS,
      ...deps,
    };
  }

  onUpdate(listener: (update: DesktopProviderSignInUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  current(providerId: DesktopAgentProviderId): DesktopProviderSignInUpdate | null {
    const session = this.sessions.get(providerId);
    return session ? { ...session.update } : null;
  }

  async start(providerId: DesktopAgentProviderId): Promise<DesktopProviderSignInUpdate> {
    const running = this.sessions.get(providerId);
    if (running && !running.finished) return { ...running.update };
    const session: SignInSession = {
      providerId,
      update: { providerId, state: "starting", url: null, code: null, acceptsCode: false, message: null },
      plan: null,
      child: null,
      output: "",
      outputSinceCode: "",
      timeout: null,
      poll: null,
      finished: false,
    };
    this.sessions.set(providerId, session);
    this.emit(session);
    try {
      session.plan = await this.deps.resolvePlan(providerId);
      if (session.finished) return { ...session.update };
      session.timeout = setTimeout(() => this.finish(session, {
        state: "failed",
        message: `Sign-in to ${session.plan?.providerName ?? providerId} did not finish within ${Math.round(this.deps.timeoutMs / 60_000) || 1} minutes. Try again.`,
      }), this.deps.timeoutMs);
      session.timeout.unref?.();
      if (session.plan.mode === "terminal") await this.startTerminal(session, session.plan);
      else this.startProcess(session, session.plan);
    } catch (error) {
      this.finish(session, { state: "failed", message: error instanceof Error ? error.message : String(error) });
    }
    return { ...session.update };
  }

  submitCode(providerId: DesktopAgentProviderId, rawCode: string): DesktopProviderSignInUpdate {
    const session = this.sessions.get(providerId);
    const stdin = session?.child?.stdin;
    if (!session || session.finished || !stdin || !stdin.writable) {
      throw new Error("No sign-in is waiting for a code.");
    }
    const code = String(rawCode ?? "").trim();
    if (!/^[\x21-\x7e]{1,4096}$/.test(code)) throw new Error("Paste the code exactly as the browser shows it.");
    stdin.write(`${code}\n`);
    session.outputSinceCode = "";
    session.update = { ...session.update, state: "verifying", acceptsCode: false, message: null };
    this.emit(session);
    return { ...session.update };
  }

  cancel(providerId: DesktopAgentProviderId): void {
    const session = this.sessions.get(providerId);
    if (session && !session.finished) this.finish(session, { state: "cancelled", message: null });
  }

  cancelAll(): void {
    for (const providerId of [...this.sessions.keys()]) this.cancel(providerId);
  }

  private startProcess(session: SignInSession, plan: ProviderSignInPlan): void {
    const child = this.deps.spawnProcess(plan);
    session.child = child;
    const read = (chunk: Buffer | string) => {
      if (session.finished) return;
      const text = String(chunk);
      session.output = (session.output + text).slice(-OUTPUT_LIMIT_CHARS);
      session.outputSinceCode = (session.outputSinceCode + text).slice(-OUTPUT_LIMIT_CHARS);
      this.applyOutput(session);
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    // A pipe that closes early is reported by the exit; it must not throw here.
    child.stdin?.on("error", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) => {
      this.finish(session, {
        state: "failed",
        message: error.code === "ENOENT"
          ? `LetAgents could not find the ${plan.providerName} command (${plan.command}).`
          : `${plan.providerName} sign-in could not start: ${error.message}`,
      });
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (session.finished) return;
      session.child = null;
      if (code === 0) {
        void this.verify(session, plan);
        return;
      }
      const { lastLine } = parseSignInOutput(session.output);
      this.finish(session, {
        state: "failed",
        message: lastLine || `${plan.providerName} sign-in ended ${signal ? `by ${signal}` : `with exit code ${code ?? "unknown"}`}.`,
      });
    });
  }

  private applyOutput(session: SignInSession): void {
    const parsed = parseSignInOutput(session.output);
    const acceptsCode = parseSignInOutput(session.outputSinceCode).acceptsCode;
    const previous = session.update;
    const url = previous.url || parsed.url;
    const code = previous.code || parsed.code;
    const waiting = Boolean(url || code || acceptsCode);
    const state = previous.state === "starting" && waiting ? "waiting"
      : previous.state === "verifying" && acceptsCode ? "waiting"
        : previous.state;
    if (state === previous.state && url === previous.url && code === previous.code && acceptsCode === previous.acceptsCode) return;
    session.update = { ...previous, state, url, code, acceptsCode };
    this.emit(session);
  }

  private async startTerminal(session: SignInSession, plan: ProviderSignInPlan): Promise<void> {
    await this.deps.openTerminal(plan);
    if (session.finished) return;
    session.update = {
      ...session.update,
      state: "waiting",
      inTerminal: true,
      message: `Sign in to ${plan.providerName} in the Terminal window. LetAgents checks again every few seconds.`,
    };
    this.emit(session);
    const check = async () => {
      session.poll = null;
      if (session.finished) return;
      const signedIn = await plan.verify().catch(() => false);
      if (session.finished) return;
      if (signedIn) {
        this.succeed(session, plan);
        return;
      }
      session.poll = setTimeout(() => void check(), this.deps.pollIntervalMs);
      session.poll.unref?.();
    };
    session.poll = setTimeout(() => void check(), this.deps.pollIntervalMs);
    session.poll.unref?.();
  }

  private async verify(session: SignInSession, plan: ProviderSignInPlan): Promise<void> {
    session.update = { ...session.update, state: "verifying", acceptsCode: false, message: null };
    this.emit(session);
    const signedIn = await plan.verify().catch(() => false);
    if (session.finished) return;
    if (signedIn) {
      this.succeed(session, plan);
      return;
    }
    this.finish(session, {
      state: "failed",
      message: `The sign-in finished, but ${plan.providerName} still reports that it is signed out. Try again.`,
    });
  }

  private succeed(session: SignInSession, plan: ProviderSignInPlan): void {
    try { this.deps.onSignedIn(session.providerId); } catch { /* the preflight runs either way */ }
    this.finish(session, { state: "signed_in", acceptsCode: false, message: `Signed in to ${plan.providerName}.` });
  }

  private finish(session: SignInSession, patch: Partial<DesktopProviderSignInUpdate>): void {
    if (session.finished) return;
    session.finished = true;
    if (session.timeout) clearTimeout(session.timeout);
    if (session.poll) clearTimeout(session.poll);
    session.timeout = null;
    session.poll = null;
    const child = session.child;
    session.child = null;
    if (child) {
      child.stdin?.destroy();
      if (child.exitCode === null && child.signalCode === null) this.deps.stopProcess(child);
    }
    session.update = { ...session.update, acceptsCode: false, ...patch };
    this.emit(session);
  }

  private emit(session: SignInSession): void {
    for (const listener of this.listeners) {
      try { listener({ ...session.update }); } catch { /* one listener must not stop the others */ }
    }
  }
}

export const desktopProviderSignIn = new ProviderSignInService();
