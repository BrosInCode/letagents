import { execSync } from "node:child_process";

export const CORE_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.googleapis.com",
];

export function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" });
}

export function gitRepoRootOrEmpty() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Prefer git root so StartCascade matches an Antigravity workspace folder. */
export function defaultWorkspaceUri() {
  const fromEnv = process.env.ANTIGRAVITY_WORKSPACE_URI?.trim();
  if (fromEnv) return fromEnv;
  const root = gitRepoRootOrEmpty();
  if (root) return `file://${root}`;
  const cwd = process.cwd();
  if (cwd.startsWith("/")) return `file://${cwd}`;
  return null;
}

export function workspaceIdFromUri(workspaceUri) {
  if (!workspaceUri) return null;
  try {
    const url = new URL(workspaceUri);
    if (url.protocol !== "file:") return null;
    let fsPath = decodeURIComponent(url.pathname || "");
    if (/^\/[A-Za-z]:/.test(fsPath)) {
      fsPath = fsPath.slice(1);
    } else if (fsPath.startsWith("/")) {
      fsPath = fsPath.slice(1);
    }
    if (!fsPath) return null;
    return `file_${fsPath.replace(/:/g, "_3A").replace(/[\\/]/g, "_")}`;
  } catch {
    return null;
  }
}

export function parseLanguageServerProcesses() {
  const out = sh("ps -axo pid=,command=");
  const found = [];
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (!line.includes("language_server_macos_arm_bin")) continue;
    const firstSpace = line.indexOf(" ");
    if (firstSpace === -1) continue;
    const pid = line.slice(0, firstSpace).trim();
    const cmd = line.slice(firstSpace + 1);
    const csrfMatch = cmd.match(/--csrf_token\s+([^\s]+)/);
    const workspaceIdMatch = cmd.match(/--workspace_id\s+([^\s]+)/);
    found.push({
      pid,
      cmd,
      csrf: csrfMatch ? csrfMatch[1] : null,
      workspaceId: workspaceIdMatch ? workspaceIdMatch[1] : null,
      isWorkspaceLsp: cmd.includes("--enable_lsp"),
    });
  }
  return found;
}

export function findCoreProcess() {
  for (const proc of parseLanguageServerProcesses()) {
    if (proc.isWorkspaceLsp) continue;
    const hasEndpoint = CORE_ENDPOINTS.some((e) => proc.cmd.includes(e));
    if (!hasEndpoint) continue;
    return { pid: proc.pid, csrf: proc.csrf };
  }
  return null;
}

export function findWorkspaceProcess(workspaceUri) {
  const wantedWorkspaceId = workspaceIdFromUri(workspaceUri);
  if (!wantedWorkspaceId) return null;
  for (const proc of parseLanguageServerProcesses()) {
    if (!proc.isWorkspaceLsp) continue;
    if (proc.workspaceId !== wantedWorkspaceId) continue;
    return {
      pid: proc.pid,
      csrf: proc.csrf,
      workspaceId: proc.workspaceId,
    };
  }
  return null;
}

export function findListeningPorts(pid) {
  const out = sh(`lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN`);
  const ports = [...out.matchAll(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/g)].map((m) =>
    Number(m[1]),
  );
  if (ports.length === 0) throw new Error(`No LISTEN ports for LS pid=${pid}`);
  return [...new Set(ports)].sort((a, b) => a - b);
}
