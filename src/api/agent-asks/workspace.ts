/**
 * Code access for a given agent (D13): LetAgents holds a copy of the asker's
 * repo; the agent lists, reads and searches it through these functions (every
 * result passes the secret firewall and is recorded for "Files seen"), and its
 * edits come back as proposals the asker approves into one stacked PR. Nothing
 * of the asker's code is copied to the giver's machine except what the agent
 * reads. No commands run here in V1.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, desc, eq } from "drizzle-orm";

import { getGitHubAppInstallationById, getGitHubAppRepositoryByFullName } from "../db.js";
import { db } from "../db/client.js";
import { getGitRoomBindingForRoom } from "../db/git-room-bindings.js";
import { agent_ask_proposals, agent_ask_reads, agent_ask_workspaces } from "../db/schema.js";
import { getGitHubAppConfig } from "../github/config.js";
import { mintInstallationToken } from "../github/app-client.js";
import { openRentalPatchPullRequest, type RentalPatchPullRequestFile } from "../rental/github-pr.js";
import { isPathBlocked, scanContent, scanFile } from "../rental/secret-firewall.js";
import { materializerGitEnv } from "../rental/workspace-materializer.js";
import { emitProjectMessage } from "../server/events.js";
import type { AgentAsk } from "./store.js";

const run = promisify(execFile);
const ROOT = path.join(os.tmpdir(), "letagents-ask-workspaces");
/** Tests point this at a local folder of bare repos; production clones from GitHub. */
const gitBase = () => process.env.LETAGENTS_ASK_GIT_BASE_URL?.replace(/\/$/, "") || "https://github.com";
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LIST = 2000;
const MAX_SEARCH = 100;
const MAX_PROPOSAL_FILES = 50;

/** A failure the agent should read as-is. */
export class AskWorkspaceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

type RepoAccess = { fullName: string; baseBranch: string; token: string | null };

/** The room's repo, its branch, and a GitHub App token when the App is connected. */
async function repoAccess(roomId: string): Promise<RepoAccess> {
  const binding = await getGitRoomBindingForRoom(roomId);
  if (!binding || binding.provider !== "github") {
    throw new AskWorkspaceError("no_repo", "This room isn't connected to a GitHub repo, so there's no code to work on. Answer in chat instead.");
  }
  const baseBranch = binding.ref_type === "pull_request" ? binding.head_ref ?? binding.default_branch ?? "main"
    : binding.ref_name ?? binding.default_branch ?? "main";
  const repository = await getGitHubAppRepositoryByFullName(binding.repository_full_name);
  const installation = repository ? await getGitHubAppInstallationById(repository.installation_id) : undefined;
  const active = repository && installation && !repository.removed_at && !installation.suspended_at && !installation.uninstalled_at;
  const token = active ? await mintInstallationToken({ config: await getGitHubAppConfig(), installationId: installation.installation_id }) : null;
  return { fullName: binding.repository_full_name, baseBranch, token };
}

function dirFor(askId: string) { return path.join(ROOT, askId.replace(/[^A-Za-z0-9_-]/g, "")); }

/**
 * The installation token goes to git through its environment config, never on
 * the command line, where any process on the server could read it.
 */
export function gitAuthEnv(token: string | null): NodeJS.ProcessEnv {
  const env = materializerGitEnv();
  if (!token) return env;
  return {
    ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

/** One clone per ask at a time: concurrent first calls share it instead of racing. */
const cloning = new Map<string, Promise<string>>();

/** Clone once per server, lazily; a lost temp folder is simply recreated. */
function checkout(ask: AgentAsk): Promise<string> {
  const dir = dirFor(ask.id);
  if (existsSync(path.join(dir, ".git"))) return Promise.resolve(dir);
  let pending = cloning.get(ask.id);
  if (!pending) {
    pending = cloneInto(ask, dir).finally(() => cloning.delete(ask.id));
    cloning.set(ask.id, pending);
  }
  return pending;
}

async function cloneInto(ask: AgentAsk, dir: string): Promise<string> {
  const access = await repoAccess(ask.room_id);
  await mkdir(ROOT, { recursive: true, mode: 0o700 });
  // Clone beside the final folder and rename it in, so no reader sees a half-written tree.
  const staging = `${dir}.cloning-${randomUUID()}`;
  try {
    // core.symlinks=false: a link in the repo arrives as a plain file holding its target, never a path out of the copy.
    await run("git", ["-c", "core.symlinks=false", "clone", "--depth", "1", "--single-branch", "--branch", access.baseBranch, "--no-tags",
      `${gitBase()}/${access.fullName}.git`, staging], { env: gitAuthEnv(access.token), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
  } catch {
    await rm(staging, { recursive: true, force: true });
    throw new AskWorkspaceError("clone_failed", access.token
      ? "LetAgents couldn't copy this repo right now. Try again in a minute."
      : "LetAgents can't see this repo. Ask the room owner to connect the LetAgents GitHub App.");
  }
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: dir, env: materializerGitEnv() });
  await db.insert(agent_ask_workspaces).values({
    ask_id: ask.id, repo_full_name: access.fullName, base_branch: access.baseBranch, base_sha: stdout.trim(),
    work_branch: `letagents/ask-${ask.id.slice(4, 12)}`,
  }).onConflictDoNothing();
  return dir;
}

/** A repo-relative path, or null if it escapes the repo or is a secret. */
function safePath(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const normalized = path.posix.normalize(input.trim().replace(/^\.?\/+/, ""));
  if (!normalized || normalized === "." || normalized.startsWith("..") || path.posix.isAbsolute(normalized) || normalized.startsWith(".git/")) return null;
  return normalized;
}

async function record(askId: string, kind: "file" | "list" | "search", target: string, blocked: boolean) {
  await db.insert(agent_ask_reads).values({ id: randomUUID(), ask_id: askId, kind, target: target.slice(0, 500), blocked }).catch(() => undefined);
}

export async function listFiles(ask: AgentAsk, prefix: unknown): Promise<string[]> {
  const dir = await checkout(ask);
  const under = prefix === undefined || prefix === "" ? "" : safePath(prefix);
  if (under === null) throw new AskWorkspaceError("invalid_path", "Use a path inside the repo.", 400);
  const { stdout } = await run("git", ["ls-files", "-z", ...(under ? ["--", under] : [])], { cwd: dir, env: materializerGitEnv(), maxBuffer: 32 * 1024 * 1024 });
  const files = stdout.split("\0").filter(file => file && !isPathBlocked(file)).slice(0, MAX_LIST);
  await record(ask.id, "list", under || "/", false);
  return files;
}

export async function readRepoFile(ask: AgentAsk, requested: unknown): Promise<{ path: string; content: string; redacted: boolean }> {
  const file = safePath(requested);
  if (!file) throw new AskWorkspaceError("invalid_path", "Use a path inside the repo.", 400);
  if (isPathBlocked(file)) { await record(ask.id, "file", file, true); throw new AskWorkspaceError("blocked", "That file may hold secrets, so it isn't shared."); }
  const dir = await checkout(ask);
  const full = path.join(dir, file);
  // Never follow a link, and never leave the copy, whatever the repo contains.
  const link = await lstat(full).catch(() => null);
  const real = link && !link.isSymbolicLink() ? await realpath(full).catch(() => null) : null;
  const root = await realpath(dir);
  if (!real || !real.startsWith(`${root}${path.sep}`)) throw new AskWorkspaceError("not_found", "That file doesn't exist.", 404);
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw new AskWorkspaceError("not_found", "That file doesn't exist.", 404);
  if (info.size > MAX_FILE_BYTES) throw new AskWorkspaceError("too_large", "That file is too large to share (over 256 KB).");
  const scan = scanFile(file, await readFile(real, "utf8"));
  await record(ask.id, "file", file, scan.verdict === "blocked");
  if (scan.verdict === "blocked" || scan.content === null) throw new AskWorkspaceError("blocked", "That file may hold secrets, so it isn't shared.");
  return { path: file, content: scan.content, redacted: scan.verdict === "redacted" };
}

export async function searchRepo(ask: AgentAsk, query: unknown): Promise<Array<{ path: string; line: number; text: string }>> {
  if (typeof query !== "string" || !query.trim() || query.length > 200) throw new AskWorkspaceError("invalid_query", "Search for some text, up to 200 characters.", 400);
  const dir = await checkout(ask);
  const { stdout } = await run("git", ["grep", "-n", "-I", "-F", "--max-count=5", "-e", query], { cwd: dir, env: materializerGitEnv(), maxBuffer: 16 * 1024 * 1024 })
    .catch((error: { code?: number; stdout?: string }) => error.code === 1 ? { stdout: "" } : Promise.reject(error));
  const hits: Array<{ path: string; line: number; text: string }> = [];
  for (const row of stdout.split("\n")) {
    const match = /^([^:]+):(\d+):(.*)$/.exec(row);
    if (!match || isPathBlocked(match[1]!)) continue;
    const scan = scanContent(match[3]!.slice(0, 400));
    if (scan.verdict === "blocked" || scan.content === null) continue;
    hits.push({ path: match[1]!, line: Number(match[2]), text: scan.content });
    if (hits.length >= MAX_SEARCH) break;
  }
  await record(ask.id, "search", query, false);
  return hits;
}

export type ProposedFile = { path: string; content: string | null };

/** Validate and store a proposed change, then tell the room. Nothing reaches GitHub until the asker approves. */
export async function proposeChange(ask: AgentAsk, summary: unknown, files: unknown, giverName: string) {
  const text = typeof summary === "string" ? summary.trim() : "";
  if (!text || text.length > 300) throw new AskWorkspaceError("invalid_summary", "Describe the change in one short sentence.", 400);
  if (!Array.isArray(files) || !files.length || files.length > MAX_PROPOSAL_FILES) throw new AskWorkspaceError("invalid_files", "Propose between 1 and 50 files.", 400);
  await checkout(ask);
  const clean: ProposedFile[] = [];
  for (const entry of files as Array<Record<string, unknown>>) {
    const file = safePath(entry?.path);
    const content = entry?.content === null ? null : typeof entry?.content === "string" ? entry.content : undefined;
    if (!file || content === undefined) throw new AskWorkspaceError("invalid_files", "Each file needs a path and its full new content (or null to delete it).", 400);
    if (isPathBlocked(file)) throw new AskWorkspaceError("blocked", `${file} may hold secrets, so it can't be changed.`);
    if (content !== null && (Buffer.byteLength(content) > MAX_FILE_BYTES || scanFile(file, content).verdict !== "passed")) {
      throw new AskWorkspaceError("blocked", `The new ${file} looks like it contains a secret or is too large. Remove it and propose again.`);
    }
    clean.push({ path: file, content });
  }
  const [proposal] = await db.insert(agent_ask_proposals).values({ id: `chg_${randomUUID()}`, ask_id: ask.id, summary: text, files: clean }).returning();
  const line = `${giverName}'s agent proposed a change: ${text} (${clean.length} file${clean.length === 1 ? "" : "s"}). Review it to open a pull request.`;
  await emitProjectMessage(ask.room_id, "letagents", line, { source: "system", display_text: line, client_message_id: `agent_ask:${ask.id}:proposal:${proposal!.id}` }).catch(() => undefined);
  return proposal!;
}

export async function listProposals(askId: string) {
  return db.select().from(agent_ask_proposals).where(eq(agent_ask_proposals.ask_id, askId)).orderBy(desc(agent_ask_proposals.created_at)).limit(50);
}

export async function listReads(askId: string) {
  return db.select().from(agent_ask_reads).where(eq(agent_ask_reads.ask_id, askId)).orderBy(desc(agent_ask_reads.created_at)).limit(200);
}

/** The asker's decision. Approving adds the change to the ask's one PR (created on first approval). */
export async function decideProposal(ask: AgentAsk, proposalId: string, approve: boolean) {
  const [proposal] = await db.update(agent_ask_proposals).set({ state: approve ? "approved" : "declined", decided_at: new Date().toISOString() })
    .where(and(eq(agent_ask_proposals.id, proposalId), eq(agent_ask_proposals.ask_id, ask.id), eq(agent_ask_proposals.state, "waiting"))).returning();
  if (!proposal || !approve) return proposal ?? null;
  const [workspace] = await db.select().from(agent_ask_workspaces).where(eq(agent_ask_workspaces.ask_id, ask.id)).limit(1);
  try {
    if (!workspace) throw new Error("workspace missing");
    const [owner, name] = workspace.repo_full_name.split("/");
    const files = (proposal.files as ProposedFile[]).map((file): RentalPatchPullRequestFile => file.content === null
      ? { path: file.path, operation: "delete" } : { path: file.path, operation: "modify", content: file.content });
    const pr = await openRentalPatchPullRequest({
      repoProvider: "github", repoOwner: owner!, repoName: name!, baseBranch: workspace.base_branch, workBranch: workspace.work_branch,
      patchFiles: files, commitMessage: proposal.summary, title: `Changes from a given agent: ${proposal.summary}`.slice(0, 200),
      body: "Proposed by an agent someone added to this room through LetAgents, and approved in the room.", stackOnWorkBranch: true,
    });
    await db.update(agent_ask_workspaces).set({ pr_number: pr.number, pr_url: pr.url, updated_at: new Date().toISOString() }).where(eq(agent_ask_workspaces.ask_id, ask.id));
    const [done] = await db.update(agent_ask_proposals).set({ pr_url: pr.url }).where(eq(agent_ask_proposals.id, proposal.id)).returning();
    const line = `Added to pull request #${pr.number}: ${proposal.summary}`;
    await emitProjectMessage(ask.room_id, "letagents", line, { source: "system", display_text: line, client_message_id: `agent_ask:${ask.id}:approved:${proposal.id}` }).catch(() => undefined);
    return done ?? proposal;
  } catch (error) {
    console.error("[agent asks] PR failed", proposal.id, error);
    const [failed] = await db.update(agent_ask_proposals).set({ state: "failed", error: "GitHub didn't accept the change. Check that the LetAgents GitHub App can write to this repo, then ask the agent to propose it again." })
      .where(eq(agent_ask_proposals.id, proposal.id)).returning();
    return failed ?? proposal;
  }
}

/**
 * Remove every server copy whose gift is no longer running: copies left by
 * another replica, a restart, or a crash mid-clone (D48). Runs on the sweep.
 */
export async function pruneWorkspaces(isRunning: (askId: string) => Promise<boolean>, now = Date.now()): Promise<void> {
  const entries = await readdir(ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(ROOT, entry.name);
    if (entry.name.includes(".cloning-")) {
      // A clone in progress is left alone; one abandoned for over an hour is removed.
      const info = await stat(full).catch(() => null);
      if (info && now - info.mtimeMs > 60 * 60_000) await rm(full, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    if (cloning.has(entry.name) || await isRunning(entry.name).catch(() => true)) continue;
    await rm(full, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Remove the server copy when the gift ends (D48). */
export async function removeWorkspace(askId: string): Promise<void> {
  await rm(dirFor(askId), { recursive: true, force: true }).catch(() => undefined);
}
