import { desktopRuntimeEnvironment } from "../desktop-shell-environment.js";

export type CursorReadOnlyMode = "ask" | "plan";
export type CursorSandboxMode = "enabled" | "disabled";

export interface CursorTurnInput {
  prompt: string;
  cwd: string;
  cursorSessionId?: string | null;
  cursorBin?: string | null;
  env?: Record<string, string | undefined>;
  model?: string | null;
  mode?: CursorReadOnlyMode | null;
  force?: boolean;
  sandbox?: CursorSandboxMode | null;
  abortController?: AbortController;
}

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
  const model = input.model?.trim();
  if (model) {
    args.push("--model", model);
  }
  const resume = input.cursorSessionId?.trim();
  if (resume) {
    args.push("--resume", resume);
  }
  args.push(input.prompt);
  return args;
}

export function buildCursorChildEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  copyAllowedCursorEnv(env, desktopRuntimeEnvironment());
  copyAllowedCursorEnv(env, overrides);
  return env;
}

export function cursorDaemonChildEnv(
  profileEnv: Record<string, string>, commitEnvironment: Record<string, string> = {},
  fullAccess = false,
): NodeJS.ProcessEnv {
  // Supervised children get the Cursor runtime allowlist plus the commit identity;
  // Electron often carries unrelated GitHub/cloud/npm/database credentials.
  const env = buildCursorChildEnv(profileEnv);
  if (fullAccess) {
    // Preserve existing Git/gh authentication without importing the owner's
    // Cursor configuration or the daemon's room credentials into the profile.
    for (const [key, value] of Object.entries({ ...desktopRuntimeEnvironment(), ...profileEnv })) {
      if (key.startsWith("GIT_") || [
        "GH_CONFIG_DIR", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN",
        "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK",
      ].includes(key)) env[key] = value;
    }
  }
  // A bounded provider turn borrows only the daemon's exact-generation tool
  // authority. Ambient desktop owner/fixed-worker credentials and stale
  // supervisor coordinates must never leak into the Cursor child or its MCPs.
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === "LETAGENTS_TOKEN"
      || normalizedKey === "LETAGENTS_AGENT_SESSION_BEARER"
      || normalizedKey === "CURSOR_API_KEY"
      || normalizedKey === "CURSOR_AUTH_TOKEN"
      || normalizedKey === "NODE_EXTRA_CA_CERTS"
      || normalizedKey === "SSL_CERT_DIR"
      || normalizedKey === "SSL_CERT_FILE"
      || normalizedKey.startsWith("LETAGENTS_SUPERVISOR_")
      || normalizedKey === "LETAGENTS_SUPERVISED_BOUNDED_TURNS"
      || normalizedKey === "LETAGENTS_EXECUTION_PROFILE"
      || normalizedKey === "LETAGENTS_PERMISSION_PROFILE_ID") {
      delete env[key];
    }
  }
  return { ...env, ...commitEnvironment };
}

const CURSOR_CHILD_ENV_ALLOWLIST = new Set([
  // Windows: the private profile's roaming settings folder (managed-profile.ts).
  "APPDATA",
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

/** Windows reads names without case, and a copy of process.env keeps its own spelling (`ComSpec`, `windir`). */
const CURSOR_CHILD_ENV_ALLOWLIST_WITHOUT_CASE = new Set([...CURSOR_CHILD_ENV_ALLOWLIST].map((key) => key.toLowerCase()));

function copyAllowedCursorEnv(
  destination: NodeJS.ProcessEnv,
  source: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (CURSOR_CHILD_ENV_ALLOWLIST.has(key)
      || (platform === "win32" && CURSOR_CHILD_ENV_ALLOWLIST_WITHOUT_CASE.has(key.toLowerCase())))) {
      destination[key] = value;
    }
  }
}

