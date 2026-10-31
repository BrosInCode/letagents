/** Checks that a Codex thread runs with the access, effort, config and folder the adapter asked for. */
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CODEX_BUILT_IN_READ_ONLY_PROFILE, codexReadOnlyProfileId } from "../codex-agent-home.js";
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
export function codexThreadIsReadOnly(policy: Record<string, unknown>): boolean {
  return policy.approvalPolicy === "never" && policy.sandbox === "read-only";
}

/** A part of a reported sandbox that grants nothing: off, absent, or an empty list. */
export function grantsNothing(value: unknown): boolean {
  return value === false || value === null || value === undefined || value === 0 || value === ""
    || (Array.isArray(value) && value.length === 0)
    || (recordValue(value) !== null && Object.keys(value as object).length === 0);
}

/**
 * Whether a reported read-only sandbox has a part that could let the thread
 * write or reach the network. A newer Codex may add parts this build does not
 * know, and a part cannot be judged by a meaning it does not have yet. So it
 * is judged by its name and its value: a part whose name speaks of writing,
 * of the network, or of an exception to the sandbox widens it when its value
 * is anything but off, absent or empty. Every other unknown part is left
 * alone, which is what keeps a newer Codex from locking Read-only out.
 */
export function codexReadOnlySandboxWidened(sandbox: unknown, depth = 0): boolean {
  if (depth > 6) return true;
  if (Array.isArray(sandbox)) return sandbox.some((item) => codexReadOnlySandboxWidened(item, depth + 1));
  const record = recordValue(sandbox);
  if (!record) return false;
  return Object.entries(record).some(([name, value]) =>
    (/writ|network|domain|host|socket|proxy|internet|exclu|exempt|escalat|unsandbox|bypass|danger|unrestrict/i.test(name) && !grantsNothing(value))
    || codexReadOnlySandboxWidened(value, depth + 1));
}

/**
 * Said when a reply has the read-only sandbox and does not name the permission profile. LetAgents cannot tell an
 * older Codex, which does not report a profile, from a newer one that reports it another way. So the line claims
 * neither, and names what helps in each case.
 */
export const SIGN_IN_PROTECTION_NOT_CONFIRMED = "This version of Codex did not confirm that it keeps your Codex sign-in file from this agent's commands, so the agent was not started. "
  + "If Codex is not up to date, update it. If it is, update LetAgents, or choose another access level: at every other level the agent's commands can read that file.";

/**
 * A thread asked for Read-only must report it: the read-only sandbox with no
 * network, nobody to ask, and the permission profile of this work attempt.
 * The owner's own Codex settings or an older app-server could leave the
 * thread another sandbox or approval policy, and the reply to thread/start
 * and thread/resume is the only word on what the thread got. The reply is
 * held to the four things the level promises: the sandbox is the read-only
 * one, its network access is off, the approval policy is `never`, and the
 * profile is the one that keeps the owner's sign-in file from a command. A
 * missing one starts no turn, and so does a part that widens the sandbox (see
 * above). No other access level is checked here.
 *
 * `profile` is the permission profile the runtime names in its requests: the
 * one of a Read-only agent's work attempt. It is null for a launch that names
 * no access level and has this policy all the same. The product's launch
 * refuses to start Codex for such a caller (see `readOnlySandbox`), so only a
 * test's stand-in for the launch gets this far. It names the sandbox as
 * before, and its reply is held to the sandbox and the approval policy alone.
 *
 * What a reply cannot show is that the `deny` is in force: Codex 0.153.4
 * reports the same after it has dropped one. So this is one of two checks.
 * The other is made at the launch, with a made-up file, and every request of
 * a Read-only runtime names the profile, so that Codex is never left to keep
 * or drop it by itself.
 */
export function assertCodexReadOnlyApplied(policy: Record<string, unknown>, result: CodexThreadResult, profile: string | null): void {
  if (!codexThreadIsReadOnly(policy) || codexReplyIsReadOnly(result, profile)) return;
  if (codexReplyHasReadOnlySandbox(result)) throw new Error(SIGN_IN_PROTECTION_NOT_CONFIRMED);
  throw new Error("Codex did not confirm Read-only access for this agent, so the agent was not started. Update Codex, or choose another access level.");
}

/** What a conversation's reply says of its approval policy, its sandbox and its permission profile. */
export type CodexReportedAccess = Pick<CodexThreadResult, "approvalPolicy" | "sandbox" | "activePermissionProfile">;

/** Whether a reply reports the sandbox and the approval policy Read-only promises, and no part that widens the sandbox. */
export function codexReplyHasReadOnlySandbox(result: CodexReportedAccess): boolean {
  const sandbox = recordValue(result.sandbox);
  return result.approvalPolicy === "never" && sandbox?.type === "readOnly" && sandbox.networkAccess === false
    && !codexReadOnlySandboxWidened(sandbox);
}

/** Whether a reply names this permission profile, as one that extends Codex's own read-only profile. */
export function codexReplyNamesProfile(result: CodexReportedAccess, profile: string): boolean {
  const active = recordValue(result.activePermissionProfile);
  return active?.id === profile && active.extends === CODEX_BUILT_IN_READ_ONLY_PROFILE;
}

/** Whether a reply reports everything Read-only promises: the sandbox, the approval policy, and the permission profile of a runtime that names one. */
export function codexReplyIsReadOnly(result: CodexReportedAccess, profile: string | null): boolean {
  return codexReplyHasReadOnlySandbox(result) && (profile === null || codexReplyNamesProfile(result, profile));
}

/**
 * The permission profile a runtime with this policy names when it was found
 * running: the one of its work attempt for the Read-only policy, and none
 * otherwise. A process found running names no access level, so its policy
 * says it. A launch goes by the level's own name.
 */
export function codexFoundProfile(turnPolicy: Readonly<Record<string, unknown>> | null, workAttemptId: string): string | null {
  return codexTurnPolicyIsReadOnly(turnPolicy) ? codexReadOnlyProfileId(workAttemptId) : null;
}

/** Whether a runtime's own policy is Read-only's. A process found running names no access level, so its policy says it. */
export function codexTurnPolicyIsReadOnly(turnPolicy: Readonly<Record<string, unknown>> | null): boolean {
  return turnPolicy !== null && codexThreadIsReadOnly(normalizeLaunchPolicy(turnPolicy));
}

/**
 * What a conversation is started or loaded with. A Read-only runtime names
 * its permission profile in place of the read-only sandbox: Codex takes one
 * or the other, never both, and only the profile keeps the owner's sign-in
 * file from a command. A runtime that names no profile is as it was.
 */
export function codexThreadAccess(policy: Record<string, unknown>, profile: string | null): Record<string, unknown> {
  if (profile === null) return policy;
  // The profile stands in for the read-only sandbox and for no other.
  if (!codexThreadIsReadOnly(policy)) throw new Error("A Codex permission profile was named for a conversation whose policy is not Read-only's.");
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
  if (!codexTurnPolicyIsReadOnly(turnPolicy)) throw new Error("A Codex permission profile was named for a turn whose policy is not Read-only's.");
  const { sandboxPolicy: _namedSandbox, ...named } = turnPolicy;
  return Object.freeze({ ...named, permissions: profile });
}

/**
 * For a Read-only runtime found running: what its loaded conversation reports
 * when that is not Read-only, as a line for its owner. Null when it reports
 * Read-only, and for every other access level. Only the names Codex gives its
 * policy and its sandbox are repeated, short and in quotes. A conversation
 * that has the sandbox and not the profile is said so: a process that was
 * started before Read-only agents were given a profile is found this way.
 */
export function codexFoundNotReadOnly(turnPolicy: Readonly<Record<string, unknown>> | null, result: CodexReportedAccess, profile: string | null): string | null {
  if (!codexTurnPolicyIsReadOnly(turnPolicy) || codexReplyIsReadOnly(result, profile)) return null;
  if (codexReplyHasReadOnlySandbox(result)) {
    const reported = recordValue(result.activePermissionProfile) ? "another permission profile than the one LetAgents gave it" : "no permission profile";
    return `Codex reported ${reported} for this agent's conversation, so nothing says that your Codex sign-in file is kept from its commands. `
      + "That is not Read-only access";
  }
  const named = (value: unknown) => typeof value === "string" && value ? shownInNotice(value)
    : value === undefined || value === null ? "none" : "one this build does not know";
  const sandbox = recordValue(result.sandbox);
  const more = sandbox?.networkAccess === true ? " with network access"
    : sandbox?.type !== "readOnly" ? ""
    : sandbox.networkAccess !== false ? " with no word on its network access"
    : codexReadOnlySandboxWidened(sandbox) ? " with a part that widens it" : "";
  return `Codex reported approval policy ${named(result.approvalPolicy)} and sandbox ${named(sandbox?.type)}${more} for this agent's conversation. `
    + "That is not Read-only access";
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
