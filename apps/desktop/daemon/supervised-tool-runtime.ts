import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type DaemonToolAgentSession = {
  session_id: string;
  session_token: string;
  room_id: string;
  session_kind: "worker";
  runtime: string;
  actor_label: string;
  agent_key: string;
  agent_instance_id: string;
  display_name: string;
  owner_label: string;
  ide_label: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  ended_at: null;
};

export type ExecuteDaemonToolInput = {
  provider: string;
  toolName: string;
  input: unknown;
  requestId: string;
  roomId: string;
  apiUrl: string;
  bearer: string;
  cwd: string;
  agentSession: DaemonToolAgentSession;
};

export type ExecuteDaemonToolResult = { liveResult: unknown; durableResult: unknown };

export type SupervisedToolRuntime = {
  executeDaemonTool(input: ExecuteDaemonToolInput): Promise<ExecuteDaemonToolResult>;
  supervisedToolIsMutation(toolName: string): boolean;
};

let loadedRuntime: Promise<SupervisedToolRuntime> | null = null;

type RuntimeIntegrityVerifier = {
  LETAGENTS_MCP_RUNTIME_TREE_SHA256: string;
  computeLetAgentsMcpRuntimeTreeSha256(nodeModulesRoot: string): string;
};

type SupervisedToolRuntimeLoadOptions = {
  /** Explicit development-only escape hatch for the locally rebuilt repo runtime. */
  allowUnsealedDevelopmentRuntime?: boolean;
  /** Test seam; production derives this signed Desktop module from its own location. */
  verifierPath?: string;
  expectedTreeSha256?: string;
};

function defaultVerifierPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../dist-electron/main/agents/letagents-mcp-runtime.js",
  );
}

async function canonicalRealFile(path: string, label: string): Promise<string> {
  if (!path || !isAbsolute(path)) throw new Error(`${label} is unavailable.`);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file.`);
  return realpath(path);
}

export async function loadSupervisedToolRuntimeAt(
  configuredPath: string,
  options: SupervisedToolRuntimeLoadOptions = {},
): Promise<SupervisedToolRuntime> {
  if (!configuredPath || !isAbsolute(configuredPath)) {
    throw new Error("The signed LetAgents daemon tool executor is unavailable.");
  }
  const canonicalPath = await canonicalRealFile(configuredPath, "The LetAgents daemon tool executor");
  if (!options.allowUnsealedDevelopmentRuntime) {
    const packageRoot = resolve(dirname(canonicalPath), "../../..");
    const nodeModulesRoot = dirname(packageRoot);
    const exactExecutor = join(packageRoot, "dist", "mcp", "server", "daemon-tool-executor.js");
    if (canonicalPath !== exactExecutor
      || basename(packageRoot) !== "letagents"
      || basename(nodeModulesRoot) !== "node_modules") {
      throw new Error("The LetAgents daemon tool executor is outside its sealed package tree.");
    }
    const verifierPath = await canonicalRealFile(
      options.verifierPath ?? defaultVerifierPath(),
      "The signed LetAgents runtime verifier",
    );
    const verifier = await import(pathToFileURL(verifierPath).href) as Partial<RuntimeIntegrityVerifier>;
    if (typeof verifier.computeLetAgentsMcpRuntimeTreeSha256 !== "function"
      || typeof verifier.LETAGENTS_MCP_RUNTIME_TREE_SHA256 !== "string") {
      throw new Error("The signed LetAgents runtime verifier has an incompatible contract.");
    }
    const configuredDigest = options.expectedTreeSha256?.trim() ?? "";
    if (!/^[a-f0-9]{64}$/.test(configuredDigest)
      || configuredDigest !== verifier.LETAGENTS_MCP_RUNTIME_TREE_SHA256) {
      throw new Error("The daemon runtime seal does not match this Desktop build.");
    }
    const actualDigest = verifier.computeLetAgentsMcpRuntimeTreeSha256(nodeModulesRoot);
    if (actualDigest !== configuredDigest) {
      throw new Error(
        `The bundled LetAgents daemon tool runtime failed its complete tree integrity check (expected ${configuredDigest}, found ${actualDigest}).`,
      );
    }
  }
  const module = await import(pathToFileURL(canonicalPath).href) as Partial<SupervisedToolRuntime>;
  if (typeof module.executeDaemonTool !== "function" || typeof module.supervisedToolIsMutation !== "function") {
    throw new Error("The LetAgents daemon tool executor has an incompatible contract.");
  }
  return module as SupervisedToolRuntime;
}

/** Load exactly the immutable runtime path selected by Desktop for this daemon generation. */
export async function supervisedToolRuntime(): Promise<SupervisedToolRuntime> {
  const configuredPath = process.env.LETAGENTS_MCP_DAEMON_EXECUTOR_ENTRY?.trim() ?? "";
  const allowUnsealedDevelopmentRuntime = Boolean(
    process.env.LETAGENTS_DESKTOP_DEV_SERVER_URL?.trim()
      && process.env.LETAGENTS_MCP_DAEMON_EXECUTOR_UNSEALED_DEV === "1",
  );
  loadedRuntime ??= loadSupervisedToolRuntimeAt(configuredPath, {
    allowUnsealedDevelopmentRuntime,
    expectedTreeSha256: process.env.LETAGENTS_MCP_DAEMON_EXECUTOR_TREE_SHA256,
  }).catch((error) => {
    loadedRuntime = null;
    throw error;
  });
  return loadedRuntime;
}
