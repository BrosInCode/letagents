/** Checks that a Codex thread runs with the access, effort, config and folder the adapter asked for. */
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CODEX_BUILT_IN_READ_ONLY_PROFILE, CODEX_BUILT_IN_WORKSPACE_PROFILE, type CodexBuiltInProfile, codexSandboxedProfileId } from "../codex-agent-home.js";
import { launchNoticeSaidOnce } from "../provider-spawn-configuration.js";
import { errorMessage } from "../provider-evidence.js";
import type { CodexAdapterRpc } from "./types.js";
import { normalizeLaunchPolicy } from "./launch-contract.js";
import { recordValue } from "./notifications.js";

export type CodexThreadResult = {
  thread?: { id?: string }; approvalsReviewer?: unknown; approvalPolicy?: unknown; sandbox?: unknown; activePermissionProfile?: unknown; cwd?: unknown; reasoningEffort?: unknown;
};

/** How long a start waits for Codex to list its models before it leaves the reasoning effort out. */
export const CODEX_MODEL_LIST_TIMEOUT_MS = 5_000;
/** The line about an agent's reasoning effort is said when it changes, not at every start. A repair whose line was recorded keeps it here too. */
export const codexEffortNoticeSaidOnce = launchNoticeSaidOnce();
/** The line about files Codex wrote in the agents' home: said when what it names changes. */
export const codexAgentHomeNoticeSaidOnce = launchNoticeSaidOnce();

/** Whether a policy has a sandbox: every one but an exact Full access. The owner's saved command rules would open it. */
export function codexPolicyIsSandboxed(policy: Readonly<Record<string, unknown>>): boolean {
  const sandbox = recordValue(policy.sandboxPolicy);
  return !(sandbox?.type === "dangerFullAccess" && Object.keys(sandbox).length === 1);
}
/** A value as a notice shows it: printable, short, and in quotes. */
export function shownInNotice(text: string): string {
  return JSON.stringify(text.replace(/[^\x20-\x7e]/g, "?").slice(0, 48));
}

/**
 * The reviewer Codex reports must be the one this launch named. The owner's
 * own Codex settings can name another, and an older app-server can ignore the
 * request; either would route approvals somewhere the access level did not
 * choose. An app-server that reports no reviewer has none to route to.
 */
export function assertCodexReviewerApplied(policy: Record<string, unknown>, result: CodexThreadResult): void {
  if (policy.approvalsReviewer === "auto_review") {
    if (result.approvalsReviewer === "auto_review") return;
    throw new Error("Codex did not turn on automatic review. Update Codex, or choose another access level.");
  }
  if (result.approvalsReviewer !== undefined && result.approvalsReviewer !== null && result.approvalsReviewer !== "user") {
    throw new Error("Codex would review approvals itself instead of asking you. Choose Auto to allow that, or remove the reviewer from your Codex settings.");
  }
}

/**
 * A thread's reasoning effort, as the parameter Codex takes it in.
 *
 * Codex takes the effort as the config override `model_reasoning_effort`, on
 * thread/start and on thread/resume. It has no `reasoningEffort` parameter:
 * it ignores one, and the thread runs with the effort of its owner's settings.
 *
 * Codex accepts any effort for a thread and reports it back. It is the model
 * that refuses an effort it does not advertise, and then every turn of the
 * thread fails. So the effort is sent only when Codex lists it for the
 * thread's model. An agent with no model of its own runs its owner's Codex
 * model, or the model its thread already has, and neither is known here: its
 * effort must be one that every listed model takes. An effort that is not
 * sent leaves the thread with the effort Codex gives it, and the owner is told.
 *
 * Only the first page of the list is read, with a time limit. A list that
 * has more pages is not complete, and a model that is not on the first page
 * is not found: both leave the effort out, as an answer that does not come does.
 */
export async function codexThreadEffort(
  client: CodexAdapterRpc,
  policy: Record<string, unknown>,
  model: string | null | undefined,
  effort: string | null | undefined,
): Promise<{ params: { config?: Record<string, unknown> }; sent: string | null; notice: string | null }> {
  if (!effort) return { params: {}, sent: null, notice: null };
  const named = model?.trim() || null;
  let listed: Array<Record<string, unknown>> = [];
  let answered = false;
  let complete = false;
  try {
    const page = recordValue(await client.request<unknown>("model/list", { includeHidden: true }, { timeoutMs: CODEX_MODEL_LIST_TIMEOUT_MS }));
    listed = (Array.isArray(page?.data) ? page.data : []).map(recordValue).filter((entry): entry is Record<string, unknown> => entry !== null);
    answered = true;
    complete = (page?.nextCursor ?? null) === null;
  } catch {
    // No answer: the effort cannot be checked, and it is not sent.
  }
  // A thread is started with a model's `model`. An entry's `id` names the entry, not the model.
  const models = named ? listed.filter((entry) => entry.model === named) : complete ? listed : [];
  const takes = (entry: Record<string, unknown>) => Array.isArray(entry.supportedReasoningEfforts)
    && entry.supportedReasoningEfforts.some((option) => recordValue(option)?.reasoningEffort === effort);
  if (models.length && models.every(takes)) {
    return { params: { config: { ...recordValue(policy.config), model_reasoning_effort: effort } }, sent: effort, notice: null };
  }
  const unchecked = !answered ? "Codex did not say which efforts its models take"
    : !complete ? "Codex did not list all its models"
    : named ? `Codex does not list the model ${shownInNotice(named)}` : "Codex listed no models";
  const reason = !models.length ? `${unchecked}, so the effort could not be checked`
    : named ? `the model ${shownInNotice(named)} does not take it`
    : "not every Codex model takes it and this agent has no model of its own";
  return {
    params: {},
    sent: null,
    notice: `This agent's reasoning effort ${shownInNotice(effort)} was not given to Codex, because ${reason}. The agent runs with the effort Codex gives it.`
      + (models.length ? ` Choose ${named ? "another effort" : "a model or another effort"} in the agent's settings.` : ""),
  };
}

/**
 * The effort Codex reports for a thread, against the effort it was sent.
 * Codex once ignored the effort and said nothing, and it keeps the effort of
 * a thread that is already loaded. Neither stops the agent: the owner is told
 * both values.
 *
 * Codex 0.153 reports the effort of a thread it was sent one for, and writes
 * a value it does not have as null. So a null in that place is Codex saying
 * that the thread has no effort, and the owner is told that too. A reply with
 * no such field is an app-server that does not report the effort: it says
 * nothing either way.
 */
export function codexEffortMismatchNotice(sent: string | null, result: CodexThreadResult): string | null {
  const reported = result.reasoningEffort;
  if (sent === null) return null;
  if (reported === null) {
    return `This agent's reasoning effort ${shownInNotice(sent)} was given to Codex, but Codex reports no effort for the conversation. `
      + "The agent runs with the effort Codex gives it.";
  }
  if (typeof reported !== "string" || !reported || reported === sent) return null;
  return `This agent's reasoning effort ${shownInNotice(sent)} was given to Codex, but Codex reports ${shownInNotice(reported)} for the conversation. `
    + "The agent runs with the effort Codex reports.";
}

/** Whether a thread's policy is Read-only's: the one access level that names `never` together with the read-only sandbox. */
export function codexThreadIsReadOnly(policy: Readonly<Record<string, unknown>>): boolean {
  return policy.approvalPolicy === "never" && policy.sandbox === "read-only";
}

/** Whether a thread's policy names a sandbox: the read-only one of Read-only and Ask before writes, or the workspace one of Auto. Full access names none. */
export function codexThreadIsSandboxed(policy: Readonly<Record<string, unknown>>): boolean {
  return policy.sandbox === "read-only" || policy.sandbox === "workspace-write";
}

/** The built-in Codex profile that the permission profile of a thread with this policy extends: the one of its sandbox. Null for Full access. */
export function codexProfileBase(policy: Readonly<Record<string, unknown>>): CodexBuiltInProfile | null {
  return policy.sandbox === "read-only" ? CODEX_BUILT_IN_READ_ONLY_PROFILE
    : policy.sandbox === "workspace-write" ? CODEX_BUILT_IN_WORKSPACE_PROFILE : null;
}

/** The access level a thread's policy is, by the name its card shows. Null for a policy no level has. */
export function codexLevelName(policy: Readonly<Record<string, unknown>>): string | null {
  if (policy.sandbox === "read-only") return policy.approvalPolicy === "never" ? "Read-only" : policy.approvalPolicy === "on-request" ? "Ask before writes" : null;
  if (policy.sandbox === "workspace-write") return policy.approvalPolicy === "on-request" ? "Auto" : null;
  return policy.sandbox === "danger-full-access" ? "Full access" : null;
}

/** A part of a reported sandbox that grants nothing: off, absent, or an empty list. */
export function grantsNothing(value: unknown): boolean {
  return value === false || value === null || value === undefined || value === 0 || value === ""
    || (Array.isArray(value) && value.length === 0)
    || (recordValue(value) !== null && Object.keys(value as object).length === 0);
}

/**
 * Whether a reported sandbox has a part that could let the thread write more
 * than its level allows or reach the network. A newer Codex may add parts this
 * build does not know, and a part cannot be judged by a meaning it does not
 * have yet. So it is judged by its name and its value: a part whose name
 * speaks of writing, of the network, or of an exception to the sandbox widens
 * it when its value is anything but off, absent or empty. Every other unknown
 * part is left alone, which is what keeps a newer Codex from locking a level
 * out. The workspace sandbox of a conversation with a profile reports no
 * writable root and no excluded temp folder, so an empty list and `false`
 * are what it reports when nothing widens it.
 */
export function codexSandboxWidened(sandbox: unknown, depth = 0): boolean {
  if (depth > 6) return true;
  if (Array.isArray(sandbox)) return sandbox.some((item) => codexSandboxWidened(item, depth + 1));
  const record = recordValue(sandbox);
  if (!record) return false;
  return Object.entries(record).some(([name, value]) =>
    (/writ|network|domain|host|socket|proxy|internet|exclu|exempt|escalat|unsandbox|bypass|danger|unrestrict/i.test(name) && !grantsNothing(value))
    || codexSandboxWidened(value, depth + 1));
}

/**
 * Said when a reply has the level's sandbox and does not name the permission profile. LetAgents cannot tell an
 * older Codex, which does not report a profile, from a newer one that reports it another way. So the line claims
 * neither, and names what helps in each case.
 */
export const SIGN_IN_PROTECTION_NOT_CONFIRMED = "This version of Codex did not confirm that it keeps your Codex sign-in file from this agent's commands, so the agent was not started. "
  + "If Codex is not up to date, update it. If it is, update LetAgents, or give the agent Full access: at that level the agent's commands can read that file.";

/**
 * A thread asked for a sandboxed access level must report it: the level's
 * sandbox with no network, the level's approval policy, and the permission
 * profile of this work attempt. The owner's own Codex settings or an older
 * app-server could leave the thread another sandbox or approval policy, and
 * the reply to thread/start and thread/resume is the only word on what the
 * thread got. The reply is held to the four things the level promises: the
 * sandbox is the level's (Codex's read-only one for Read-only and Ask before
 * writes, its workspace one for Auto), its network access is off, the
 * approval policy is the level's (`never` for Read-only, `on-request` for the
 * other two), and the profile is the one that keeps the owner's sign-in file
 * from a command. A missing one starts no turn, and so does a part that
 * widens the sandbox (see above). Full access is not checked here.
 *
 * `profile` is the permission profile the runtime names in its requests: the
 * one of its work attempt. It is null for a launch that names no access level
 * and has a sandboxed policy all the same, and for a Windows launch at Ask
 * before writes or Auto, where Codex keeps no file from a command. Such a
 * runtime names the sandbox as before. With the Read-only policy its reply is
 * held to the sandbox and the approval policy alone (the product's launch
 * refuses to start Codex for such a caller, see `readOnlySandbox`, so only a
 * test's stand-in for the launch gets this far); with another it is held to
 * nothing here, as before agents at its level were given a profile.
 *
 * What a reply cannot show is that the `deny` is in force: Codex 0.153.4
 * reports the same after it has dropped one. So this is one of two checks.
 * The other is made at the launch, with a made-up file, and every request of
 * a runtime with a profile names it, so that Codex is never left to keep or
 * drop it by itself.
 */
export function assertCodexSandboxedApplied(policy: Record<string, unknown>, result: CodexThreadResult, profile: string | null): void {
  if (!codexHeldToReply(policy, profile) || codexReplyAtLevel(policy, result, profile)) return;
  if (codexReplyHasLevelSandbox(policy, result)) throw new Error(SIGN_IN_PROTECTION_NOT_CONFIRMED);
  throw new Error(`Codex did not confirm ${codexLevelName(policy) ?? "sandboxed"} access for this agent, so the agent was not started. Update Codex, or choose another access level.`);
}

/** Whether a runtime with this policy and this profile is held to what its conversation reports: one with a profile, and a Read-only one always. */
function codexHeldToReply(policy: Readonly<Record<string, unknown>>, profile: string | null): boolean {
  return codexThreadIsSandboxed(policy) && (profile !== null || codexThreadIsReadOnly(policy));
}

/** What a conversation's reply says of its approval policy, its sandbox and its permission profile. */
export type CodexReportedAccess = Pick<CodexThreadResult, "approvalPolicy" | "sandbox" | "activePermissionProfile">;

/** The sandbox Codex reports for a thread with this policy, by its type name. Null for a policy that names none. */
function reportedSandboxType(policy: Readonly<Record<string, unknown>>): string | null {
  return policy.sandbox === "read-only" ? "readOnly" : policy.sandbox === "workspace-write" ? "workspaceWrite" : null;
}

/** Whether a reply reports the sandbox and the approval policy the policy's level promises, and no part that widens the sandbox. */
export function codexReplyHasLevelSandbox(policy: Readonly<Record<string, unknown>>, result: CodexReportedAccess): boolean {
  const sandbox = recordValue(result.sandbox);
  return result.approvalPolicy === policy.approvalPolicy && sandbox?.type === reportedSandboxType(policy) && sandbox.networkAccess === false
    && !codexSandboxWidened(sandbox);
}

/** Whether a reply names this permission profile, as one that extends the built-in profile of the policy's sandbox. */
export function codexReplyNamesProfile(policy: Readonly<Record<string, unknown>>, result: CodexReportedAccess, profile: string): boolean {
  const active = recordValue(result.activePermissionProfile);
  return active?.id === profile && active.extends === codexProfileBase(policy);
}

/** Whether a reply reports everything the policy's level promises: the sandbox, the approval policy, and the permission profile of a runtime that names one. */
export function codexReplyAtLevel(policy: Readonly<Record<string, unknown>>, result: CodexReportedAccess, profile: string | null): boolean {
  return codexReplyHasLevelSandbox(policy, result) && (profile === null || codexReplyNamesProfile(policy, result, profile));
}

/**
 * The permission profile a runtime with this policy names: the one of its
 * work attempt for a sandboxed policy, and none for Full access. A process
 * found running names no access level, so its policy says it; a launch's
 * level is attested to match its policy, so it goes by the policy too.
 *
 * On Windows, Codex's sandbox refuses no `deny`, and Read-only is not offered
 * there. An Ask before writes or Auto agent runs there as before, with the
 * sandbox named and no profile: nothing keeps the owner's sign-in file from
 * its commands, and the level's card says so.
 */
export function codexSignInProfileFor(policy: Readonly<Record<string, unknown>> | null, workAttemptId: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!policy) return null;
  const base = codexProfileBase(policy);
  if (!base) return null;
  if (platform === "win32" && !codexThreadIsReadOnly(policy)) return null;
  return codexSandboxedProfileId(base, workAttemptId);
}

/** The profile a runtime found running names, from its turn policy: see codexSignInProfileFor. */
export function codexFoundProfile(turnPolicy: Readonly<Record<string, unknown>> | null, workAttemptId: string, platform: NodeJS.Platform = process.platform): string | null {
  return turnPolicy === null ? null : codexSignInProfileFor(normalizeLaunchPolicy(turnPolicy), workAttemptId, platform);
}

/** Whether a runtime's own policy is Read-only's. A process found running names no access level, so its policy says it. */
export function codexTurnPolicyIsReadOnly(turnPolicy: Readonly<Record<string, unknown>> | null): boolean {
  return turnPolicy !== null && codexThreadIsReadOnly(normalizeLaunchPolicy(turnPolicy));
}

/** Whether a runtime's own policy names a sandbox: every level but Full access. */
export function codexTurnPolicyIsSandboxed(turnPolicy: Readonly<Record<string, unknown>> | null): boolean {
  return turnPolicy !== null && codexThreadIsSandboxed(normalizeLaunchPolicy(turnPolicy));
}

/**
 * What a conversation is started or loaded with. A runtime with a profile
 * names it in place of its sandbox: Codex takes one or the other, never both,
 * and only the profile keeps the owner's sign-in file from a command. A
 * runtime that names no profile is as it was.
 */
export function codexThreadAccess(policy: Record<string, unknown>, profile: string | null): Record<string, unknown> {
  if (profile === null) return policy;
  // The profile stands in for a sandbox and for nothing else.
  if (!codexThreadIsSandboxed(policy)) throw new Error("A Codex permission profile was named for a conversation whose policy names no sandbox.");
  const { sandbox: _namedSandbox, ...named } = policy;
  return { ...named, permissions: profile };
}

/**
 * What a turn is started with: the same, for a turn's policy. A turn that
 * named the sandbox instead would take the profile's name off the
 * conversation, and Codex would be left to keep its `deny` or to drop it.
 */
export function codexTurnAccess(turnPolicy: Readonly<Record<string, unknown>>, profile: string | null): Readonly<Record<string, unknown>> {
  if (profile === null) return turnPolicy;
  if (!codexTurnPolicyIsSandboxed(turnPolicy)) throw new Error("A Codex permission profile was named for a turn whose policy names no sandbox.");
  const { sandboxPolicy: _namedSandbox, ...named } = turnPolicy;
  return Object.freeze({ ...named, permissions: profile });
}

/**
 * For a runtime found running at a sandboxed access level: what its loaded
 * conversation reports when that is not the level, as a line for its owner.
 * Null when it reports the level, for Full access, and for a runtime that is
 * held to nothing (see assertCodexSandboxedApplied). Only the names Codex
 * gives its policy and its sandbox are repeated, short and in quotes. A
 * conversation that has the sandbox and not the profile is said so: a process
 * that was started before agents at its level were given a profile is found
 * this way.
 */
export function codexFoundNotAtLevel(turnPolicy: Readonly<Record<string, unknown>> | null, result: CodexReportedAccess, profile: string | null): string | null {
  if (turnPolicy === null) return null;
  const policy = normalizeLaunchPolicy(turnPolicy);
  if (!codexHeldToReply(policy, profile) || codexReplyAtLevel(policy, result, profile)) return null;
  const level = codexLevelName(policy) ?? "sandboxed";
  if (codexReplyHasLevelSandbox(policy, result)) {
    const reported = recordValue(result.activePermissionProfile) ? "another permission profile than the one LetAgents gave it" : "no permission profile";
    return `Codex reported ${reported} for this agent's conversation, so nothing says that your Codex sign-in file is kept from its commands. `
      + `That is not ${level} access`;
  }
  const named = (value: unknown) => typeof value === "string" && value ? shownInNotice(value)
    : value === undefined || value === null ? "none" : "one this build does not know";
  const sandbox = recordValue(result.sandbox);
  const more = sandbox?.networkAccess === true ? " with network access"
    : sandbox?.type !== reportedSandboxType(policy) ? ""
    : sandbox.networkAccess !== false ? " with no word on its network access"
    : codexSandboxWidened(sandbox) ? " with a part that widens it" : "";
  return `Codex reported approval policy ${named(result.approvalPolicy)} and sandbox ${named(sandbox?.type)}${more} for this agent's conversation. `
    + `That is not ${level} access`;
}

/**
 * Web search is off for a Read-only agent. Codex runs a search on its model
 * provider's side, outside the sandbox, and asks nobody: with web search on,
 * a query or a page address can carry what the agent read. The owner's linked
 * config decides it otherwise, and can say "live".
 *
 * It is said in two places, for a launch that names the Read-only level.
 * Codex 0.153.4 was seen to take a conversation's own config over the
 * launch's, so the launch override alone can be undone by a `config` in a
 * stored policy. A Read-only conversation is therefore given its own config
 * whole: this setting, the reasoning effort when one is sent, and nothing a
 * stored policy holds. The installed-Codex tests show both, with a stand-in
 * model.
 */
export const CODEX_READ_ONLY_CONFIG_OVERRIDES: readonly string[] = Object.freeze(['web_search="disabled"']);
export const CODEX_READ_ONLY_THREAD_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({ web_search: "disabled" });

/**
 * For a launch at Ask before writes or Auto that names its permission
 * profile. Under a profile, a command that Codex is asked to run outside its
 * sandbox and that the owner or Codex's reviewer approves may write anywhere
 * but a denied file, and has no network: Codex 0.162.1 keeps the profile's
 * network setting for it. With this setting on, Codex offers its model a
 * second way to ask: for the network, or for a folder, by name. Such a
 * request goes to the same approver as before, with what it asks for, and an
 * approved command gets exactly that. The denied sign-in file stays denied
 * whatever is asked for. A Codex that does not know the setting ignores it,
 * and says so in its own log only.
 */
export const CODEX_APPROVAL_LEVEL_CONFIG_OVERRIDES: readonly string[] = Object.freeze(["features.exec_permission_approvals=true"]);

/** The `config` a conversation is started or resumed with: the reasoning effort's, and for a Read-only runtime its own. */
export function codexThreadConfig(
  readOnlyLevel: boolean,
  effort: { params: { config?: Record<string, unknown> }; sent: string | null },
): { config?: Record<string, unknown> } {
  if (!readOnlyLevel) return effort.params;
  return { config: { ...(effort.sent === null ? {} : { model_reasoning_effort: effort.sent }), ...CODEX_READ_ONLY_THREAD_CONFIG } };
}

/**
 * thread/start names no `cwd`. Codex takes a new thread in a named folder with
 * a writable sandbox as the owner trusting that project: it records the trust
 * in the owner's own config and loads the project's `.codex` config, its MCP
 * servers included. Without `cwd` the thread starts where its app-server
 * runs, which is the work attempt's folder; one that starts anywhere else is
 * refused. thread/resume does none of this and still names the folder.
 *
 * A refused thread is never used. A launch stops its app-server; a repair
 * leaves its running one alone, with the refused thread idle and unowned.
 */
export function assertCodexThreadDirectory(cwd: string, result: CodexThreadResult): void {
  if (!cwd.trim()) return;
  const started = typeof result.cwd === "string" ? result.cwd : "";
  if (!started) {
    throw new Error("Codex did not report the folder this conversation opened in, so LetAgents will not use it. Update Codex.");
  }
  if (sameDirectory(started, cwd)) return;
  throw new Error(`Codex opened this conversation in ${started}, not in the agent's folder ${cwd}, so LetAgents will not use it. Restart the agent.`);
}

export function sameDirectory(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true;
  try {
    if (realpathSync.native(left) === realpathSync.native(right)) return true;
    // One folder can resolve to two paths (macOS firmlinks: /Users and
    // /System/Volumes/Data/Users), but it has one device and inode.
    const [first, second] = [statSync(left, { bigint: true }), statSync(right, { bigint: true })];
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

export function isUnmaterializedEmptyThreadRead(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("not materialized yet")
    && message.includes("includeturns is unavailable before first user message");
}

export function isMissingContinuation(error: unknown, continuationId: string): boolean {
  const message = errorMessage(error).trim();
  return new RegExp(`^thread not found:\\s*${escapeRegExp(continuationId)}$`, "i").test(message);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
