import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { isAgentBranch } from "../../../shared/agent-branch.mjs";
import { commandOnlyReads, partsAreInCommand, PERMISSION_REVIEW_MAX_COMMANDS, routineCommandReview } from "../../../shared/permission-review.mjs";
import type { ClaudeNativePermissionRequest, OpenCodeNativePermissionRequest } from "../shared/provider-permissions.js";
import { executionApprovalProjectionPathsAreSafe } from "./execution-approval-projection-policy.js";
import { resolveWorkspaceRelativePath } from "./execution-approval-projection.js";
import { requestCommandReview } from "./command-review-http.js";
import type { DaemonManifestEntry } from "./types.js";
import { currentWorkerPublicationAuthority } from "./worker-publication-authority.js";
import type { WorkerRuntimeCustody } from "./worker-runtime-custody.js";

export const AUTOMATIC_REVIEW_PROFILE_ID = "auto_review";
/** Recorded as the decider, so the journal shows no person chose. */
export const AUTOMATIC_REVIEW_ACTOR_ID = "automatic-review";
const MAX_EDITED_FILES = 64;

const CONTROL_FILES = new Set([
  "agents.md", "claude.md", "gemini.md", "context.md", "skill.md", "opencode.json", "opencode.jsonc",
  "package.json", "makefile", "gnumakefile", "justfile", "taskfile.yml", "taskfile.yaml",
  "conftest.py", "pytest.ini", "tox.ini", "setup.py", "setup.cfg", "pyproject.toml", "cargo.toml", "build.rs",
  "go.mod", "go.work", "jsconfig.json",
]);

/**
 * The names Git runs a hook by. `core.hooksPath` may name any folder, so a
 * file with one of these names runs at the next commit, merge, checkout, or
 * push wherever it is. Hooks have no extension.
 */
const GIT_HOOKS = new Set([
  "applypatch-msg", "pre-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "pre-rebase",
  "pre-push", "pre-auto-gc", "reference-transaction", "push-to-checkout", "pre-receive", "proc-receive", "sendemail-validate",
  "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-pre-submit",
]);

/**
 * A name made of plain printable characters. A file system can read other
 * characters as these ones: macOS opens `package.json` for a name written
 * with a long s. Such a name cannot be compared with a list, so it asks.
 */
function plainName(part: string): boolean {
  return /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(part) && !part.endsWith(".");
}

/**
 * Files that say what the agent may do, that run when something else happens,
 * or that define what a command allowed by name will run. An edit to one
 * always asks. Source and test files are not on this list: changing them is
 * the agent's work, and a check that runs them runs what the agent wrote.
 */
function changesWhatRuns(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1)!;
  return parts.some((part) => !plainName(part)
      // A name that starts with a dot is a setting by convention: an agent's
      // rules, a tool's options, a hook, a credential, or LetAgents' own marker.
      || part.startsWith(".")
      // Installed packages are what `node` and every tool in them will run.
      || part === "node_modules")
    || CONTROL_FILES.has(name) || name.endsWith(".mk")
    || GIT_HOOKS.has(name) || /^post-[a-z0-9-]+$/.test(name)
    // What a test runner, compiler, linter, or bundler loads and runs before anything else.
    || /[.-](?:config|workspace)\.(?:[cm]?[jt]s|json|ya?ml)$/.test(name)
    || /^tsconfig(?:\.[a-z0-9_.-]+)?\.json$/.test(name)
    // Git hooks run by lefthook.
    || /^lefthook(?:-local)?\.(?:ya?ml|toml|json)$/.test(name);
}

/** What a patch says it will do to one file: the file, and where it goes if it is moved. */
function patchedFile(value: unknown): { from: string; to: string | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { filePath, movePath, type } = value as Record<string, unknown>;
  if (typeof filePath !== "string" || !isAbsolute(filePath)) return null;
  // Removing a file is never decided here, and neither is a kind of change this file does not know.
  if (type !== "add" && type !== "update" && type !== "move") return null;
  if (movePath === undefined || movePath === null) return type === "move" ? null : { from: filePath, to: null };
  return typeof movePath === "string" && isAbsolute(movePath) ? { from: filePath, to: movePath } : null;
}

/**
 * The file a request names, as a path inside the workspace. OpenCode names a
 * file relative to its Git repository, and relative to the file system root
 * when the project is not one. A path that is outside the workspace under
 * both readings, or that climbs, is refused by the resolver.
 *
 * `written` is the part of the name that is inside the workspace, as the
 * request wrote it. Where the workspace itself is was not the agent's choice.
 */
async function fileInWorkspace(workspace: string, canonical: string, named: string): Promise<{ path: string; written: string }> {
  // Which reading applies is decided by the text alone. A refusal under that
  // reading stands: it is never retried under the other.
  const rooted = `/${named}`;
  const root = [workspace, canonical].map((root) => `${root.replace(/\/+$/, "")}/`).find((root) => rooted.startsWith(root));
  const path = (await resolveWorkspaceRelativePath(workspace, canonical, root ? rooted : named)).path;
  return { path, written: root ? rooted.slice(root.length) : named };
}

export type AutomaticReviewVerdict = "allow" | "ask";

export type AutomaticReviewInput = {
  entry: DaemonManifestEntry;
  /** The agent's own native request, in the shape its provider sends. */
  request: OpenCodeNativePermissionRequest | ClaudeNativePermissionRequest;
  signal: AbortSignal;
};

export type AutomaticPermissionReviewerOptions = {
  /** Null when this agent has no current authority to ask the server. */
  reviewCommands(input: { entry: DaemonManifestEntry; commands: readonly string[]; project: string; signal: AbortSignal }): Promise<AutomaticReviewVerdict>;
  /** The agent's key while it has current authority. Its branches are named for it. */
  agentKey?(entry: DaemonManifestEntry): string | null;
};

/** Claude access levels under which Claude asks before a command it cannot show only reads. */
const CLAUDE_ASKING_PROFILES = new Set(["ask_before_write", "auto_review"]);

function reviewedProvider(entry: DaemonManifestEntry): "open-model" | "claude-code" | null {
  if (entry.delivery_mode !== "daemon_inbox" || entry.id.startsWith("supervised_rental_")) return null;
  if (entry.provider === "open-model" && entry.permission_profile_id === AUTOMATIC_REVIEW_PROFILE_ID) return "open-model";
  return entry.provider === "claude-code" && CLAUDE_ASKING_PROFILES.has(entry.permission_profile_id ?? "") ? "claude-code" : null;
}

/**
 * The branch `origin` names as its default, as Git recorded it in the
 * repository, or null when it cannot be read. Nothing is run.
 */
async function originDefaultBranch(project: string): Promise<string | null> {
  try {
    const dotGit = join(project, ".git");
    const found = await lstat(dotGit);
    let gitDir = dotGit;
    if (found.isFile()) {
      // A linked worktree names its own Git folder, which names the repository's shared one.
      const named = /^gitdir: ([^\n]+)\n?$/.exec(await readFile(dotGit, "utf8"));
      if (!named) return null;
      gitDir = resolve(project, named[1]!);
      const common = await readFile(join(gitDir, "commondir"), "utf8").catch(() => null);
      if (common !== null) gitDir = resolve(gitDir, common.trim());
    } else if (!found.isDirectory()) return null;
    const head = /^ref: refs\/remotes\/origin\/([^\n]+)\n?$/.exec(await readFile(join(gitDir, "refs", "remotes", "origin", "HEAD"), "utf8"));
    return head ? head[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Decides an agent's own permission requests where its owner's choice allows
 * it. Under Auto, an Open Model agent's file edit is decided here, by where
 * the file is, and a command by the fixed rules and then by the server's
 * review. Under Ask before writes and Auto, a Claude command that only reads
 * runs. Every other request, and every failure, is left for a person.
 */
export class AutomaticPermissionReviewer {
  constructor(private readonly options: AutomaticPermissionReviewerOptions) {}

  applies(entry: DaemonManifestEntry | undefined): boolean {
    return Boolean(entry && reviewedProvider(entry));
  }

  async review(input: AutomaticReviewInput): Promise<AutomaticReviewVerdict> {
    try {
      const { entry } = input;
      const workspace = entry.workspace_path;
      const provider = reviewedProvider(entry);
      if (!provider || !workspace || !isAbsolute(workspace)) return "ask";
      if (provider === "claude-code") return await this.reviewClaudeCommand(input.request as ClaudeNativePermissionRequest, workspace);
      const request = input.request as OpenCodeNativePermissionRequest;
      if (request.permission === "edit") return await this.reviewEdit(request, workspace);
      if (request.permission === "bash") return await this.reviewCommand(input, request, workspace);
      return "ask";
    } catch {
      return "ask";
    }
  }

  /**
   * Claude runs a command that it can show only reads, and asks about the
   * rest, often because commands are joined. One the fixed rules show only
   * reads project files, history, or pull requests runs: Ask before writes
   * promises that. Claude names a path outside the project when a command
   * would reach one, or runs in another folder, and that always asks.
   */
  private async reviewClaudeCommand(native: ClaudeNativePermissionRequest, workspace: string): Promise<AutomaticReviewVerdict> {
    const request = native?.request;
    if (!request || request.subtype !== "can_use_tool" || request.tool_name !== "Bash"
      || (Object.hasOwn(request, "blocked_path") && request.blocked_path != null)) return "ask";
    const { input } = request;
    // A command run in the background, or outside Claude's own limits, is not only a read.
    if (!input || typeof input !== "object" || Array.isArray(input)
      || !Object.keys(input).every((key) => key === "command" || key === "description" || key === "timeout")) return "ask";
    return commandOnlyReads(input.command, await realpath(workspace)) ? "allow" : "ask";
  }

  /** An edit may run when every file is inside the workspace and none holds credentials or history. */
  private async reviewEdit(request: OpenCodeNativePermissionRequest, workspace: string): Promise<AutomaticReviewVerdict> {
    const patterns = request.patterns;
    if (!Array.isArray(patterns) || patterns.length === 0 || patterns.length > MAX_EDITED_FILES
      || !patterns.every((path) => typeof path === "string")) return "ask";
    const canonical = await realpath(workspace);
    const files: string[] = [];
    const written: string[] = [];
    for (const pattern of patterns) {
      if (isAbsolute(pattern)) return "ask";
      const file = await fileInWorkspace(workspace, canonical, pattern);
      files.push(file.path);
      written.push(file.written);
    }
    // OpenCode says which file it means a second time: one absolute file for
    // the single-file tools, a list for a patch. A request that says neither
    // is not one this rule knows.
    const named = request.metadata?.filepath;
    const single = typeof named === "string" && isAbsolute(named);
    if (!single && request.metadata?.files === undefined) return "ask";
    if (single && (files.length !== 1 || (await resolveWorkspaceRelativePath(workspace, canonical, named)).path !== files[0])) return "ask";
    // A patch lists what it does to each file. The request names only where each
    // file is now, so where a file is moved to is read from that list.
    const destinations: string[] = [];
    if (request.metadata?.files !== undefined) {
      const listed = request.metadata.files;
      if (!Array.isArray(listed) || listed.length !== files.length) return "ask";
      for (const [index, entry] of listed.entries()) {
        const patched = patchedFile(entry);
        if (!patched || (await resolveWorkspaceRelativePath(workspace, canonical, patched.from)).path !== files[index]) return "ask";
        if (patched.to !== null) destinations.push((await resolveWorkspaceRelativePath(workspace, canonical, patched.to)).path);
      }
    }
    const touched = [...files, ...destinations];
    // The names are judged as the request wrote them and as they resolve, so neither reading hides one.
    if (!executionApprovalProjectionPathsAreSafe(touched) || [...touched, ...written].some(changesWhatRuns)
      || !written.every((name) => executionApprovalProjectionPathsAreSafe([name]))) return "ask";
    // A file with a second name may be a file outside the workspace under one of them.
    for (const file of touched) {
      const found = await lstat(join(canonical, file)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (found && (!found.isFile() || found.nlink > 1)) return "ask";
    }
    return "allow";
  }

  private async reviewCommand(input: AutomaticReviewInput, request: OpenCodeNativePermissionRequest, workspace: string): Promise<AutomaticReviewVerdict> {
    const command = request.metadata?.command;
    const parts = request.patterns;
    if (typeof command !== "string" || !Array.isArray(parts) || parts.length === 0
      || parts.length > PERMISSION_REVIEW_MAX_COMMANDS || !parts.every((part) => typeof part === "string")) return "ask";
    // The whole command is what runs. Its parsed parts must each be a part the
    // rules found in it, so neither reading of it can hide something from them.
    if (!partsAreInCommand(command, parts)) return "ask";
    // The shell sees the workspace by its real path, so that is the project a path is judged against.
    const project = await realpath(workspace);
    // A push goes only to one of the agent's own branches, which are named for its key.
    const agentKey = this.options.agentKey?.(input.entry) ?? null;
    const review = routineCommandReview(command, project, {
      ownBranch: (branch) => isAgentBranch(branch, agentKey), defaultBranch: await originDefaultBranch(project),
    });
    if (review === null) return "ask";
    // Routine work on the agent's own branches that the rules decide alone is sent nowhere.
    if (review.length === 0) return "allow";
    return this.options.reviewCommands({ entry: input.entry, commands: review, project, signal: input.signal });
  }
}

/** The reviewer the daemon runs: it asks the server under the agent's own current authority. */
export function createAutomaticPermissionReviewer(options: {
  custody: Pick<WorkerRuntimeCustody, "hostGrant" | "workerAuthorization">;
  daemonGeneration(): number;
  isClosing(): boolean;
  nowMs(): number;
  requestReview?: typeof requestCommandReview;
}): AutomaticPermissionReviewer {
  return new AutomaticPermissionReviewer({
    agentKey: (entry) => {
      const authority = currentWorkerPublicationAuthority(options.custody, entry.id, options.daemonGeneration(), options.nowMs());
      return authority && authority.origin.roomId === entry.room_id ? authority.origin.agentKey : null;
    },
    reviewCommands: async ({ entry, commands, project, signal }) => {
      const authority = currentWorkerPublicationAuthority(options.custody, entry.id, options.daemonGeneration(), options.nowMs());
      // An agent with no current authority has nobody to ask, so a person decides.
      if (!authority || options.isClosing() || authority.origin.roomId !== entry.room_id) return "ask";
      return (options.requestReview ?? requestCommandReview)({ apiOrigin: authority.origin.apiOrigin, grantId: authority.grant.grantId,
        supervisorGrant: authority.grant.supervisorGrant, grantGeneration: authority.grant.grantGeneration,
        roomId: authority.origin.roomId, commands, project, signal });
    },
  });
}
