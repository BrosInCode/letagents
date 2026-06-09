/**
 * Command Broker — p5.3
 *
 * Runs renter-visible verification commands in the materialized rental
 * workspace. Commands are argv-only and policy checked before execution.
 */

import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { promisify } from "util";
import { and, eq } from "drizzle-orm";

import { rental_workspace_manifests } from "../db/schema.js";
import { evaluateCommandPolicy } from "./command-broker-policy.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface CommandBrokerManifest {
  id: string;
  session_id: string;
  workspace_path: string | null;
  retention_status: string;
}

export interface CommandBrokerDeps {
  getActiveManifest(sessionId: string): Promise<CommandBrokerManifest | null>;
}

export interface RunWorkspaceCommandInput {
  sessionId: string;
  argv: string[];
  timeoutMs?: number;
}

export interface RunWorkspaceCommandResult {
  success: boolean;
  argv?: string[];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  manifestId?: string;
  error?: string;
}

export function createDefaultCommandBrokerDeps(): CommandBrokerDeps {
  return {
    async getActiveManifest(sessionId) {
      const { db } = await import("../db/client.js");
      const [row] = await db
        .select()
        .from(rental_workspace_manifests)
        .where(
          and(
            eq(rental_workspace_manifests.session_id, sessionId),
            eq(rental_workspace_manifests.retention_status, "active"),
          ),
        );
      return (row as CommandBrokerManifest | undefined) ?? null;
    },
  };
}

export async function runWorkspaceCommand(
  deps: CommandBrokerDeps,
  input: RunWorkspaceCommandInput,
): Promise<RunWorkspaceCommandResult> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return { success: false, error: "sessionId is required" };

  const argv = normalizeArgv(input.argv);
  if ("error" in argv) return { success: false, error: argv.error };

  const policy = evaluateCommandPolicy(argv.argv);
  if (!policy.allowed) {
    return {
      success: false,
      argv: argv.argv,
      error: `command_blocked:${policy.reason ?? "policy"}`,
    };
  }

  const manifest = await deps.getActiveManifest(sessionId);
  const ready = await resolveWorkspace(manifest);
  if ("error" in ready) return { success: false, argv: argv.argv, error: ready.error };

  const timeout = normalizeTimeout(input.timeoutMs);
  try {
    const env = await buildCommandEnvironment(ready.workspaceRoot);
    const result = await execFileAsync(argv.argv[0]!, argv.argv.slice(1), {
      cwd: ready.workspaceRoot,
      timeout,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env,
    });
    return {
      success: true,
      argv: argv.argv,
      exitCode: 0,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr),
      timedOut: false,
      manifestId: ready.manifest.id,
    };
  } catch (err) {
    const error = err as {
      code?: number | string;
      signal?: string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      success: false,
      argv: argv.argv,
      exitCode: typeof error.code === "number" ? error.code : null,
      stdout: truncateOutput(error.stdout ?? ""),
      stderr: truncateOutput(error.stderr ?? ""),
      timedOut: error.killed === true || error.signal === "SIGTERM",
      manifestId: ready.manifest.id,
      error: error.message ?? "command_failed",
    };
  }
}

async function buildCommandEnvironment(workspaceRoot: string): Promise<NodeJS.ProcessEnv> {
  const home = path.join(workspaceRoot, ".letagents-command-home");
  const tmp = path.join(workspaceRoot, ".letagents-command-tmp");
  const npmCache = path.join(workspaceRoot, ".letagents-npm-cache");
  await Promise.all([
    fs.mkdir(home, { recursive: true }),
    fs.mkdir(tmp, { recursive: true }),
    fs.mkdir(npmCache, { recursive: true }),
  ]);

  return {
    PATH: process.env.PATH ?? "",
    CI: "1",
    NO_COLOR: "1",
    HOME: home,
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
    npm_config_cache: npmCache,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

function normalizeArgv(argv: unknown): { argv: string[] } | { error: string } {
  if (!Array.isArray(argv)) return { error: "argv must be an array" };
  const normalized = argv.map((part) => (
    typeof part === "string" ? part.trim() : ""
  ));
  if (normalized.length === 0 || normalized.some((part) => !part)) {
    return { error: "argv entries must be non-empty strings" };
  }
  return { argv: normalized };
}

async function resolveWorkspace(
  manifest: CommandBrokerManifest | null,
): Promise<
  | { manifest: CommandBrokerManifest; workspaceRoot: string }
  | { error: string }
> {
  if (!manifest || manifest.retention_status !== "active") {
    return { error: "workspace_not_ready" };
  }
  if (!manifest.workspace_path) return { error: "workspace_path_missing" };
  try {
    const workspaceRoot = await fs.realpath(manifest.workspace_path);
    const stat = await fs.stat(workspaceRoot);
    if (!stat.isDirectory()) return { error: "workspace_path_not_directory" };
    return { manifest, workspaceRoot };
  } catch {
    return { error: "workspace_path_missing" };
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function truncateOutput(value: string): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= MAX_OUTPUT_BYTES) return value;
  return `${buffer.subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n[output truncated]`;
}
