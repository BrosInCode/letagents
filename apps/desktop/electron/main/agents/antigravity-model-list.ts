/**
 * The models this Antigravity account offers, read over ACP: Antigravity
 * supports only ACP for other apps. ACP has no "list models" request; agy
 * sends the list when a session starts. So this starts `agy acp` in a folder
 * of its own, opens one session with no tools, reads the list, closes the
 * session and ends the process. Nothing is sent to a model.
 */
import { copyFileSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { protectOwnerPrivateSync } from "../../../../../shared/owner-private-fs.mjs";
import { AcpConnection, AcpRpcError, acpRecord, acpString } from "#provider-runtime/agents/antigravity/acp-connection.js";
import { DEFAULT_ANTIGRAVITY_DEPENDENCIES, type AntigravityChild } from "#provider-runtime/agents/antigravity/child-process.js";
import { ANTIGRAVITY_SIGN_IN_LINE, defaultAntigravityDataRoot, isAntigravitySignInError } from "#provider-runtime/agents/antigravity/launch.js";
import { ANTIGRAVITY_TOKEN_FILE, ownerAntigravityTokenFileExists, ownerAntigravityTokenPath, shareAntigravitySignIn } from "#provider-runtime/agents/antigravity/sign-in.js";
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
  workspaceRefusal(folder: string): string | null;
  /** The folder agy keeps this list's data in. Kept between reads: a fresh folder takes about twice as long. */
  folder: string;
  /** The owner's own agy folder (`~/.gemini`), where a file sign-in lives. */
  ownerGeminiDir: string;
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
    workspaceRefusal: (folder) => antigravityWorkspaceRefusal(folder, "start"),
    folder: join(defaultAntigravityDataRoot(), "model-list"),
    ownerGeminiDir: join(homedir(), ".gemini"),
    timeoutMs: MODEL_LIST_TIMEOUT_MS,
  };
}

/**
 * The models of a `session/new` result, as id and name pairs: from
 * `models.availableModels` (one entry per model and thinking level), else
 * from the `model` setting in `configOptions` (one entry per model).
 */
export function antigravitySessionModelRows(session: unknown): AntigravityModelRow[] {
  const result = acpRecord(session);
  const rows: AntigravityModelRow[] = [];
  const seen = new Set<string>();
  const add = (id: string | null | undefined, name: string | null | undefined) => {
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    rows.push({ id: trimmed, label: name?.trim() || trimmed });
  };
  const listed = acpRecord(result?.models)?.availableModels;
  for (const entry of Array.isArray(listed) ? listed : []) {
    const record = acpRecord(entry);
    add(acpString(record?.modelId), acpString(record?.name));
  }
  if (rows.length) return rows;
  // ACP marks `models` as unstable; the `model` setting carries the same models without their levels.
  const options = Array.isArray(result?.configOptions) ? result.configOptions : [];
  const model = options.map(acpRecord).find((entry) => entry?.category === "model" || entry?.id === "model");
  for (const entry of Array.isArray(model?.options) ? model.options : []) {
    const record = acpRecord(entry);
    const grouped = Array.isArray(record?.options) ? record.options : [record];
    for (const inner of grouped) add(acpString(acpRecord(inner)?.value), acpString(acpRecord(inner)?.name));
  }
  return rows;
}

/**
 * agy keeps its sign-in in a file in its own folder when the keychain does
 * not answer in time, and the keychain item is then gone. A read may leave
 * the only copy here. When the owner's folder has no file sign-in, that copy
 * goes back there; otherwise it is removed, so this folder never holds a
 * sign-in between reads. `since` is when the read started: a regular file
 * changed after it is agy's own, not the owner's link placed before the read.
 */
export function settleModelListSignIn(folder: string, ownerGeminiDir: string, since: number): void {
  const local = join(folder, ANTIGRAVITY_TOKEN_FILE);
  let agyWroteIt = false;
  try {
    const stat = lstatSync(local);
    agyWroteIt = stat.isFile() && stat.size > 0 && stat.mtimeMs >= since;
  } catch {
    return;
  }
  if (agyWroteIt && !ownerAntigravityTokenFileExists(ownerGeminiDir)) {
    const owner = ownerAntigravityTokenPath(ownerGeminiDir);
    try {
      mkdirSync(dirname(owner), { recursive: true, mode: 0o700 });
      renameSync(local, owner);
      return;
    } catch { /* another volume */ }
    try {
      copyFileSync(local, owner);
      protectOwnerPrivateSync(owner, "file");
    } catch {
      // Keep the only copy where it is; the next read tries again.
      return;
    }
  }
  rmSync(local, { force: true });
}

/** One read at a time per folder: two `agy acp` processes on one folder would share, and clear, its files. */
const folderReads = new Map<string, Promise<unknown>>();

export async function readAntigravityModelsOverAcp(
  agyBin: string,
  deps: AntigravityModelListDependencies = defaultAntigravityModelListDependencies(),
): Promise<AntigravityModelRow[]> {
  const before = folderReads.get(deps.folder) ?? Promise.resolve();
  const read = before.then(() => readOnce(agyBin, deps));
  const settled = read.catch(() => undefined);
  folderReads.set(deps.folder, settled);
  try {
    return await read;
  } finally {
    if (folderReads.get(deps.folder) === settled) folderReads.delete(deps.folder);
  }
}

async function readOnce(agyBin: string, deps: AntigravityModelListDependencies): Promise<AntigravityModelRow[]> {
  mkdirSync(deps.folder, { recursive: true, mode: 0o700 });
  // agy runs workspace hooks and MCP servers without asking; the agents refuse such a folder, and so does this.
  const refusal = deps.workspaceRefusal(deps.folder);
  if (refusal) throw new Error(refusal);
  // A sign-in an earlier read left here (the app ended during it) goes back to the owner first.
  settleModelListSignIn(deps.folder, deps.ownerGeminiDir, 0);
  const startedAt = Date.now();
  shareAntigravitySignIn(deps.folder, deps.ownerGeminiDir);
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
  const exitedEarly = child.exited.then((exit) => ({
    [failure]: signInRequired
      ? new AntigravityModelsSignInError()
      : exit.type === "error"
        ? new Error(`Antigravity could not start: ${exit.error.message}`)
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
    // Leave a 1 s margin: some file systems keep modification times to the second.
    try { settleModelListSignIn(deps.folder, deps.ownerGeminiDir, startedAt - 1_000); } catch { /* the next read settles it */ }
  }
}
