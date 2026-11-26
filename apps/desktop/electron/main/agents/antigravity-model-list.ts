/**
 * The models this Antigravity account offers, read over ACP: Antigravity
 * supports only ACP for other apps. ACP has no "list models" request; agy
 * sends the list when a session starts. So this starts `agy acp` in a folder
 * of its own, opens one session with no tools, reads the list, closes the
 * session and ends the process. Nothing is sent to a model.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AcpConnection, AcpRpcError, acpRecord, acpString } from "#provider-runtime/agents/antigravity/acp-connection.js";
import { DEFAULT_ANTIGRAVITY_DEPENDENCIES, type AntigravityChild } from "#provider-runtime/agents/antigravity/child-process.js";
import { ANTIGRAVITY_SIGN_IN_LINE, defaultAntigravityDataRoot, isAntigravitySignInError } from "#provider-runtime/agents/antigravity/launch.js";
import { shareAntigravitySignIn } from "#provider-runtime/agents/antigravity/sign-in.js";
import { antigravityWorkspaceRefusal } from "#provider-runtime/agents/antigravity/workspace-customizations.js";

export interface AntigravityModelRow {
  /** agy's model id, with the thinking level in it: `gemini-4-neon-high`. */
  id: string;
  /** agy's name for it: `Gemini 4 Neon (High)`. */
  label: string;
}

export const ANTIGRAVITY_MODELS_SIGN_IN_REQUIRED = "Antigravity is not signed in on this computer. Run `agy` in a terminal once and sign in with Google, then refresh the models.";

/** The error when agy has no usable sign-in, so the panel can say "sign in" instead of "failed". */
export class AntigravityModelsSignInError extends Error {
  constructor() {
    super(ANTIGRAVITY_MODELS_SIGN_IN_REQUIRED);
    this.name = "AntigravityModelsSignInError";
  }
}

export interface AntigravityModelListDependencies {
  launchChild(input: { agyBin: string; args: string[]; cwd: string; env: Record<string, string> }): AntigravityChild;
  shareSignIn(folder: string): void;
  workspaceRefusal(folder: string): string | null;
  /** The folder agy keeps this list's data in. Kept between reads: a fresh folder takes about twice as long. */
  folder: string;
  timeoutMs: number;
}

const MODEL_LIST_TIMEOUT_MS = 30_000;
const CLOSE_WAIT_MS = 2_000;
const STOP_GRACE_MS = 2_000;
/** What each read leaves in the folder, none of it needed again: the session's conversation, notes and log. */
const PER_READ_FOLDERS = ["conversations", "brain", "implicit", "log"];

export function defaultAntigravityModelListDependencies(): AntigravityModelListDependencies {
  return {
    launchChild: DEFAULT_ANTIGRAVITY_DEPENDENCIES.launchChild,
    shareSignIn: (folder) => shareAntigravitySignIn(folder),
    workspaceRefusal: (folder) => antigravityWorkspaceRefusal(folder, "start"),
    folder: join(defaultAntigravityDataRoot(), "model-list"),
    timeoutMs: MODEL_LIST_TIMEOUT_MS,
  };
}

/** The `models.availableModels` of a `session/new` result, as id and name pairs. */
export function antigravitySessionModelRows(session: unknown): AntigravityModelRow[] {
  const listed = acpRecord(acpRecord(session)?.models)?.availableModels;
  const rows: AntigravityModelRow[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(listed) ? listed : []) {
    const record = acpRecord(entry);
    const id = acpString(record?.modelId)?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, label: acpString(record?.name)?.trim() || id });
  }
  return rows;
}

export async function readAntigravityModelsOverAcp(
  agyBin: string,
  deps: AntigravityModelListDependencies = defaultAntigravityModelListDependencies(),
): Promise<AntigravityModelRow[]> {
  mkdirSync(deps.folder, { recursive: true, mode: 0o700 });
  // agy runs workspace hooks and MCP servers without asking; the agents refuse such a folder, and so does this.
  const refusal = deps.workspaceRefusal(deps.folder);
  if (refusal) throw new Error(refusal);
  deps.shareSignIn(deps.folder);
  const child = deps.launchChild({ agyBin, args: ["acp", "--gemini-dir", deps.folder], cwd: deps.folder, env: {} });
  let signInRequired = false;
  let sessionId: string | null = null;
  const failure = Symbol("failure");
  // agy prints a sign-in link when it has no sign-in; the panel says so at once instead of waiting.
  let signInSeen!: (outcome: { [failure]: Error }) => void;
  const signInPrinted = new Promise<{ [failure]: Error }>((resolve) => { signInSeen = resolve; });
  const connection = new AcpConnection(child, {
    onRequest: (method) => {
      // The session has no prompt, so nothing should ask; refuse whatever does.
      if (method === "session/request_permission") return { outcome: { outcome: "cancelled" } };
      throw new AcpRpcError(`Method not supported: ${method}`, -32601);
    },
    onNonJsonLine: (line) => {
      if (!ANTIGRAVITY_SIGN_IN_LINE.test(line)) return;
      signInRequired = true;
      signInSeen({ [failure]: new AntigravityModelsSignInError() });
    },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<{ [failure]: Error }>((resolve) => {
    // Not unref'd: the read waits on it, and it is cleared when the read ends.
    timer = setTimeout(() => resolve({ [failure]: new Error(`Antigravity did not list its models within ${Math.round(deps.timeoutMs / 1000)} s.`) }), deps.timeoutMs);
  });
  const exitedEarly = child.exited.then(() => ({
    [failure]: signInRequired
      ? new AntigravityModelsSignInError()
      : new Error(`Antigravity exited before it listed its models.${child.stderrTail() ? ` ${child.stderrTail().slice(-600)}` : ""}`),
  }));
  const step = async <T>(work: Promise<T>): Promise<T> => {
    const outcome = await Promise.race([work.then((value) => ({ value })), deadline, exitedEarly, signInPrinted]);
    if (failure in outcome) throw outcome[failure];
    return outcome.value;
  };
  try {
    await step(connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "letagents", title: "LetAgents", version: "1" },
    }));
    let session: unknown;
    try {
      session = await step(connection.request("session/new", { cwd: deps.folder, mcpServers: [] }));
    } catch (error) {
      if (signInRequired || (error instanceof AcpRpcError && isAntigravitySignInError(error.code, error.message))) {
        throw new AntigravityModelsSignInError();
      }
      throw error;
    }
    sessionId = acpString(acpRecord(session)?.sessionId);
    const rows = antigravitySessionModelRows(session);
    if (!rows.length) throw new Error("Antigravity did not return any models.");
    return rows;
  } finally {
    if (timer) clearTimeout(timer);
    if (sessionId && !connection.closed) {
      await connection.request("session/close", { sessionId }, { timeoutMs: CLOSE_WAIT_MS }).catch(() => undefined);
    }
    connection.close(new Error("The Antigravity model list is read."));
    child.markIntentionalClose();
    if (child.terminate) await child.terminate({ graceful: true, graceMs: STOP_GRACE_MS }).catch(() => false);
    let stopWait: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([child.exited, new Promise((resolve) => { stopWait = setTimeout(resolve, STOP_GRACE_MS); })]);
    if (stopWait) clearTimeout(stopWait);
    for (const name of PER_READ_FOLDERS) {
      try { rmSync(join(deps.folder, "antigravity-cli", name), { recursive: true, force: true }); } catch { /* the next read clears it */ }
    }
  }
}
