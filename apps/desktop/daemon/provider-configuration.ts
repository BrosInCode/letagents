import { isDeepStrictEqual } from "node:util";
import { assertSupervisedPermissionProfileAvailable } from "./supervised-permission-profiles.js";

export type ProviderReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | null;
export type ProviderConfigurationSnapshot = {
  provider: string;
  model: string | null;
  reasoningEffort: ProviderReasoningEffort;
  permissionProfileId: string;
  launchPolicy: Record<string, unknown>;
  configurationRevision: number;
  /** Present only when the owner lets this agent use their own provider setup. */
  homeHarness?: true;
};

type ConfigurationInput = {
  provider: string;
  model: string | null;
  reasoningEffort: ProviderReasoningEffort;
  permissionProfileId: string | null;
  launchPolicy: unknown;
  configurationRevision: number;
};

/**
 * Input accepted from the Inspector.  The renderer deliberately cannot send a
 * native launch policy: those fields are provider authority, not UI state.
 */
export type ProviderConfigurationSelection = Omit<ConfigurationInput, "launchPolicy">;

/**
 * LetAgents keeps a few keys of its own inside a stored launch policy. They
 * all start with this, none is a native option, and they are taken out before
 * any native validation, so no provider ever receives one.
 *
 * Every value stored under them is exactly `false`. An older build does not
 * know these keys and hands a stored policy to the provider as it is: for
 * Claude each key becomes a command-line flag unless its value is false. So
 * a false value is the one form that an older build drops, and an agent with
 * the owner's setup on then starts isolated there instead of failing.
 */
const OWNED_KEY_PREFIX = "letagents";
/**
 * Records that the owner lets this agent use their own provider setup: their
 * MCP servers, plugins, skills, hooks and so on. Isolation from the owner's
 * setup is the default, and an exact stored `false` here turns it off. A
 * missing key, or any other value, leaves the agent isolated. Only the
 * desktop app's signed request writes it.
 */
export const HOME_HARNESS_POLICY_KEY = "letagentsOwnerIsolation";
/** The stored form of "on", for a policy that is otherwise the provider's own. */
export const HOME_HARNESS_ON: Readonly<Record<string, false>> = Object.freeze({ [HOME_HARNESS_POLICY_KEY]: false });
/**
 * One key for each configuration revision at which that choice changed, the
 * revision in the key's name. A process that started before a change still
 * runs the way it started, so these tell a running agent's real state from
 * the saved one.
 */
const HOME_HARNESS_CHANGE_KEY = /^letagentsOwnerIsolationChangedAt([1-9][0-9]{0,14})$/;
export function homeHarnessChangeKey(revision: number): string {
  return `letagentsOwnerIsolationChangedAt${revision}`;
}
/**
 * The revision at which the owner last changed the agent's access level (its
 * permission mode), in the key's name. A process that started before it still
 * runs with the older level. Only the latest change is kept: it is the only
 * one that decides, and two changes that cancel out cost one harmless restart.
 */
const PERMISSION_CHANGE_KEY = /^letagentsPermissionChangedAt([1-9][0-9]{0,14})$/;
export function permissionChangeKey(revision: number): string {
  return `letagentsPermissionChangedAt${revision}`;
}
const homeHarnessProviders = new Set(["codex", "claude-code", "claude"]);
const MAX_HOME_HARNESS_CHANGES = 32;

export type HomeHarnessAvailability = "available" | "rental" | "unsupported" | "polling";
/** The agent a choice is about: who it is, which agent app it runs, and how room messages reach it. */
export type HomeHarnessAgent = { id: string; provider: string; deliveryMode: string | null | undefined };
/** What a list or badge may say: on, saved on but not started with it yet, or saved off but still running with it. */
export type HomeHarnessState = "on" | "after_restart" | "until_restart";

/**
 * A rented agent works for someone else, so it never gets the owner's own
 * setup. Cursor and Open Model run in sealed runtimes that have no owner
 * setup to load. An agent that collects its own room messages cannot be held
 * back from its next turn, so turning the setup off could not be enforced for
 * it: only an agent the daemon delivers messages to may have it.
 */
export function homeHarnessAvailability(agent: HomeHarnessAgent): HomeHarnessAvailability {
  if (agent.id.startsWith("supervised_rental_")) return "rental";
  if (!homeHarnessProviders.has(agent.provider.trim().toLowerCase())) return "unsupported";
  return agent.deliveryMode === "daemon_inbox" ? "available" : "polling";
}

function isPlainPolicy(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Any spelling of the prefix counts, so no look-alike key can be supplied or reach a provider. */
function isOwnedKey(key: string): boolean {
  return key.toLowerCase().startsWith(OWNED_KEY_PREFIX);
}

/**
 * Whether a policy names one of LetAgents' own keys anywhere, with any value.
 * Nested objects count too, an own `__proto__` among them: a creation request
 * must not carry such a key in any form.
 */
export function namesHomeHarness(policy: unknown, depth = 0): boolean {
  if (!policy || typeof policy !== "object" || depth > 16) return false;
  if (Array.isArray(policy)) return policy.some((item) => namesHomeHarness(item, depth + 1));
  return Object.getOwnPropertyNames(policy).some((key) => isOwnedKey(key)
    || namesHomeHarness((policy as Record<string, unknown>)[key], depth + 1));
}

/** Only the policy's own key with an exact `false` is on. Anything else is off, including a policy that cannot be read. */
export function storedHomeHarness(policy: unknown): boolean {
  return isPlainPolicy(policy) && Object.hasOwn(policy, HOME_HARNESS_POLICY_KEY) && policy[HOME_HARNESS_POLICY_KEY] === false;
}

/** Whether this agent's next start uses its owner's own setup: stored on, for an agent that may have it. */
export function agentUsesHomeHarness(agent: HomeHarnessAgent, policy: unknown): boolean {
  return homeHarnessAvailability(agent) === "available" && storedHomeHarness(policy);
}

function storedHomeHarnessChanges(policy: unknown): number[] {
  if (!isPlainPolicy(policy)) return [];
  const changes: number[] = [];
  for (const key of Object.getOwnPropertyNames(policy)) {
    const revision = HOME_HARNESS_CHANGE_KEY.exec(key)?.[1];
    if (revision !== undefined && policy[key] === false) changes.push(Number(revision));
  }
  return changes.sort((left, right) => left - right);
}

/**
 * Whether a process that started at `runtimeRevision` runs differently from
 * the saved choice: an odd number of changes came after it started. A process
 * whose revision is not known is counted as older than every change.
 */
export function homeHarnessDiffersFromSaved(policy: unknown, runtimeRevision: number | undefined): boolean {
  const started = Number.isSafeInteger(runtimeRevision) ? runtimeRevision as number : 0;
  return storedHomeHarnessChanges(policy).filter((revision) => revision > started).length % 2 === 1;
}

/** The revision of the latest change to the access level, from the policy as it is stored. Undefined when there was none. */
export function latestPermissionChange(policy: unknown): number | undefined {
  if (!isPlainPolicy(policy)) return undefined;
  let latest: number | undefined;
  for (const key of Object.getOwnPropertyNames(policy)) {
    const revision = PERMISSION_CHANGE_KEY.exec(key)?.[1];
    if (revision !== undefined && policy[key] === false && (latest === undefined || Number(revision) > latest)) latest = Number(revision);
  }
  return latest;
}

/**
 * Whether the owner changed the access level after a process that started at
 * `runtimeRevision` began, so that it still runs with the older one. A process
 * whose revision is not known is counted as older than every change.
 */
export function permissionChangedSince(policy: unknown, runtimeRevision: number | undefined): boolean {
  const changed = latestPermissionChange(policy);
  return changed !== undefined && changed > (Number.isSafeInteger(runtimeRevision) ? runtimeRevision as number : 0);
}

/**
 * What to show for an agent. `runtimeRevision` is the configuration revision
 * its running process started with, undefined when that is not known, and
 * null when nothing is running: then only the saved choice matters.
 */
export function homeHarnessState(
  agent: HomeHarnessAgent,
  policy: unknown,
  runtimeRevision: number | undefined | null,
): HomeHarnessState | null {
  if (homeHarnessAvailability(agent) !== "available") return null;
  const saved = storedHomeHarness(policy);
  if (runtimeRevision === null) return saved ? "on" : null;
  const running = saved !== homeHarnessDiffersFromSaved(policy, runtimeRevision);
  return saved ? (running ? "on" : "after_restart") : (running ? "until_restart" : null);
}

/**
 * Whether the daemon's own records say the process an agent last started has
 * its owner's setup: the saved choice, read back through the changes made
 * since that process started. An agent cannot write these records, and what
 * a process says about itself is never asked. An agent that never had the
 * setup has no such record, and neither has one that may not have it. A
 * record that cannot be read says no, exactly as it does for a launch: a
 * launch from such a record starts the agent without the owner's setup.
 *
 * `appliedRevision` is the configuration revision the process started with,
 * as the daemon's store records it. An entry read from the manifest carries
 * no revision, so a caller reads it from the store and passes it here. With
 * none to give, the question has no answer and this refuses, rather than
 * counting the process as older than every change.
 */
export function startedWithHomeHarness(entry: {
  id: string; provider: string; delivery_mode?: string; provider_launch_policy?: unknown;
}, appliedRevision: number | undefined): boolean {
  if (!Number.isSafeInteger(appliedRevision) || appliedRevision! < 1) {
    throw new Error("LetAgents cannot tell which settings this agent's process started with.");
  }
  const state = homeHarnessState({ id: entry.id, provider: entry.provider, deliveryMode: entry.delivery_mode },
    entry.provider_launch_policy, appliedRevision!);
  return state === "on" || state === "until_restart";
}

/**
 * What a reference to an agent's process carries about how that process was
 * started. Nothing for an agent that never had the setup. A stored policy
 * that is there but is not the object every writer stores cannot say how the
 * process was started: that is said as "unknown", which changes one thing
 * only, that the process is not asked what would make it load a project's
 * config again. Such an agent is otherwise treated as without the setup.
 * `appliedRevision` is the one `startedWithHomeHarness` asks for.
 */
export function ownerSetupRef(
  entry: Parameters<typeof startedWithHomeHarness>[0],
  appliedRevision: number | undefined,
): { ownerSetup?: true | "unknown" } {
  if (startedWithHomeHarness(entry, appliedRevision)) return { ownerSetup: true };
  const policy = entry.provider_launch_policy;
  return policy !== undefined && policy !== null && !isPlainPolicy(policy) ? { ownerSetup: "unknown" } : {};
}

/**
 * What the roster shows for an agent. With a process the daemon holds, it is
 * what that process started with. A process the daemon does not hold yet (it
 * is re-attached after a restart) may still be running, so it is read from
 * the revision the agent last started at: an agent whose owner turned the
 * setup off is never shown as rid of it while that process may be alive.
 * With no process at all it is the saved choice. A pause ends the process,
 * and the agent is marked paused when that end is recorded; one route marks
 * it paused with no such record (nothing the provider could attach to), so
 * for a paused agent the caller asks whether the end is recorded and passes
 * an entry without the reference only then.
 *
 * `lastStartedAtRevision` is the revision the agent last started at, as the
 * daemon's store records it: an entry read from the manifest carries none.
 * Undefined when the store could not say, and then a process is counted as
 * older than every change.
 */
export function homeHarnessRosterState(
  entry: {
    id: string; provider: string; delivery_mode?: string; provider_launch_policy?: unknown;
    provider_ref?: unknown; observed_state: string;
  },
  lastStartedAtRevision: number | undefined,
  held: { startedAtRevision: number | undefined } | null,
): HomeHarnessState | null {
  const mayStillRun = Boolean(entry.provider_ref) && !["absent", "stopped", "failed"].includes(entry.observed_state);
  return homeHarnessState({ id: entry.id, provider: entry.provider, deliveryMode: entry.delivery_mode }, entry.provider_launch_policy,
    held ? held.startedAtRevision ?? lastStartedAtRevision
      : mayStillRun ? lastStartedAtRevision : null);
}

/** The policy as a provider may see it: without LetAgents' own keys, however they got there. */
export function withoutHomeHarness<T>(policy: T): T {
  if (!isPlainPolicy(policy) || !namesHomeHarness(policy)) return policy;
  const native: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(policy)) {
    if (isOwnedKey(key) || (key === "__proto__" && namesHomeHarness(policy[key]))) continue;
    Object.defineProperty(native, key, { value: policy[key], enumerable: true, writable: true, configurable: true });
  }
  return native as T;
}

/**
 * The policy to store: the native options, the key only while it is on, and
 * the changes a running process may still predate. `changedAt` records a new
 * change; the ones the running process already started after are dropped then.
 * `permissionChangedAt` records a new change to the access level. A change
 * that the policy already records is kept as it is.
 */
export function storedLaunchPolicy(
  snapshot: Pick<ProviderConfigurationSnapshot, "launchPolicy" | "homeHarness">,
  previous?: { policy: unknown; runtimeRevision?: number; changedAt?: number; permissionChangedAt?: number },
): Record<string, unknown> {
  const native = withoutHomeHarness(snapshot.launchPolicy);
  const earlier = storedHomeHarnessChanges(previous?.policy);
  const changes = previous?.changedAt === undefined
    ? earlier
    : [...earlier.filter((revision) => revision > (previous.runtimeRevision ?? 0)), previous.changedAt];
  // Two changes cancel for any process older than both, so the oldest go in pairs.
  while (changes.length > MAX_HOME_HARNESS_CHANGES) changes.splice(0, 2);
  // An access level changed earlier and not yet started is kept, unless this save changes it again.
  const permissionChangedAt = previous?.permissionChangedAt ?? latestPermissionChange(previous?.policy);
  return {
    ...native,
    ...(snapshot.homeHarness === true ? HOME_HARNESS_ON : {}),
    ...Object.fromEntries(changes.map((revision) => [homeHarnessChangeKey(revision), false])),
    ...(permissionChangedAt === undefined ? {} : { [permissionChangeKey(permissionChangedAt)]: false }),
  };
}

/**
 * The stored policy as far as it says what the agent may do: the provider's
 * options and whether the owner's setup is on, without the record of when
 * that changed. A saved "Always allowed" tool is tied to this, so turning the
 * owner's setup on or off pauses it and changing it back restores it. A
 * policy with no such record is returned as it is.
 */
export function launchPolicyForToolRules<T>(policy: T): T {
  const isChange = (key: string) => HOME_HARNESS_CHANGE_KEY.test(key) || PERMISSION_CHANGE_KEY.test(key);
  if (!isPlainPolicy(policy) || !Object.getOwnPropertyNames(policy).some(isChange)) return policy;
  return Object.fromEntries(Object.entries(policy).filter(([key]) => !isChange(key))) as T;
}

/** The stored policy a launch or a save may use for this agent: only an agent that may have the owner's setup carries it. */
export function entryLaunchPolicy(agent: HomeHarnessAgent, policy: unknown): unknown {
  return homeHarnessAvailability(agent) === "available" ? policy : withoutHomeHarness(policy);
}

const efforts = new Set<Exclude<ProviderReasoningEffort, null>>(["low", "medium", "high", "xhigh", "max"]);
const reservedCodexPolicy = new Set(["threadId", "cwd", "input", "model", "reasoningEffort", "sandbox"]);

/**
 * Admission may share a room/provider lane only when every durable entry owns
 * an independently addressable native runtime. Codex uses separate app-server
 * threads; Claude launches an isolated CLI/session per entry; Cursor uses a
 * stable private profile and continuation per entry; Open Model launches one
 * isolated OpenCode server per entry.
 */
export function providerSupportsConcurrentSupervisedAgents(provider: string): boolean {
  return provider === "codex"
    || provider === "claude-code"
    || provider === "claude"
    || provider === "cursor"
    || provider === "open-model";
}

/**
 * The immutable provider is the authority for editable Inspector settings.
 * This validator is shared by mutation admission and every future native
 * launch, so stored configuration cannot become a provider-side surprise.
 */
export function resolveProviderConfigurationSnapshot(input: ConfigurationInput): ProviderConfigurationSnapshot {
  const provider = input.provider.trim().toLowerCase();
  if (!["codex", "open-model", "claude-code", "claude", "cursor"].includes(provider)) {
    throw new Error(`Provider '${input.provider}' does not support Inspector configuration.`);
  }
  if (input.model !== null && (typeof input.model !== "string" || !input.model.trim() || input.model.length > 256)) {
    throw new Error(`Provider '${provider}' requires a valid model name or null.`);
  }
  if (input.reasoningEffort !== null && !efforts.has(input.reasoningEffort)) {
    throw new Error(`Provider '${provider}' does not recognize reasoning effort '${String(input.reasoningEffort)}'.`);
  }
  if (!Number.isSafeInteger(input.configurationRevision) || input.configurationRevision < 1) {
    throw new Error("Provider configuration requires a positive revision.");
  }
  const stored = plainPolicy(input.launchPolicy, provider);
  const policy = withoutHomeHarness(stored);
  const homeHarness = storedHomeHarness(stored) && homeHarnessProviders.has(provider);
  const homeHarnessField = homeHarness ? { homeHarness: true as const } : {};
  const normalizedModel = input.model?.trim() ?? null;

  if (provider === "codex") {
    for (const key of reservedCodexPolicy) if (Object.hasOwn(policy, key)) throw new Error(`Codex launch policy cannot override '${key}'.`);
    const profile = resolveProfile(provider, input.permissionProfileId, "full_access", ["full_access", "ask_before_write", "auto_review"]);
    const authority = profile === "auto_review"
      ? {
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
        // Codex routes its own escalations to its reviewer instead of the host.
        approvalsReviewer: "auto_review",
      }
      : profile === "ask_before_write"
      ? {
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      }
      : {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    // Only the Auto profile may hand approvals to a reviewer other than the host.
    if (profile !== "auto_review" && Object.hasOwn(policy, "approvalsReviewer") && policy.approvalsReviewer !== "user") {
      throw new Error(`Provider '${provider}' launch policy conflicts with permission-profile authority at 'approvalsReviewer'.`);
    }
    for (const [key, value] of Object.entries(authority)) {
      requirePolicyMatch(policy, key, value, provider);
    }
    return {
      provider, model: normalizedModel, reasoningEffort: input.reasoningEffort, permissionProfileId: profile,
      launchPolicy: { ...policy, ...authority },
      configurationRevision: input.configurationRevision,
      ...homeHarnessField,
    };
  }

  if (provider === "open-model") {
    if (input.reasoningEffort !== null) {
      throw new Error("Open Model reasoning effort is controlled by the selected endpoint and model.");
    }
    const profile = resolveProfile(provider, input.permissionProfileId, "full_access", ["full_access", "ask_before_write", "auto_review"]);
    const permission = profile === "auto_review"
      // OpenCode asks as it does for Ask before writes, and LetAgents answers
      // the requests it can vouch for. Nothing outside the project is opened,
      // because no review could see what a command does there.
      ? { "*": "allow", edit: "ask", bash: "ask", external_directory: "deny" }
      : profile === "ask_before_write"
      ? { "*": "allow", edit: "ask", bash: "ask" }
      : { "*": "allow" };
    requirePolicyMatch(policy, "permission", permission, provider);
    return {
      provider,
      model: normalizedModel,
      reasoningEffort: null,
      permissionProfileId: profile,
      launchPolicy: { ...policy, permission },
      configurationRevision: input.configurationRevision,
    };
  }

  if (input.reasoningEffort !== null) throw new Error(`Provider '${provider}' does not support reasoning effort.`);
  if (provider === "claude-code" || provider === "claude") {
    scalarCliPolicy(policy, "Claude");
    const profile = resolveProfile(provider, input.permissionProfileId, "read_only", ["read_only", "ask_before_write", "auto_review", "full_access"]);
    const authority = profile === "read_only"
      ? {
        permissionMode: "dontAsk",
        dangerouslySkipPermissions: false,
        // Own the complete low-risk native surface instead of trusting prompts
        // to keep an unsandboxed CLI read-only. The strict daemon-owned MCP
        // config is the boundary behind this wildcard: adding a tool there
        // deliberately widens what a read-only Claude agent may do.
        tools: ["Read", "Glob", "Grep"],
        allowedTools: ["mcp__letagents__*"],
        settingSources: claudeSettingSources(homeHarness),
      }
      : profile === "full_access"
        ? { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true }
        : {
          // Auto differs from asking only in who decides: Claude's own review
          // instead of the host. The tool surface and ignored settings match.
          permissionMode: profile === "auto_review" ? "auto" : "default", dangerouslySkipPermissions: false,
          allowDangerouslySkipPermissions: false,
          tools: claudeApprovalTools(homeHarness),
          allowedTools: ["mcp__letagents__*"], settingSources: claudeSettingSources(homeHarness), settings: "{}",
        };
    if (profile === "ask_before_write" || profile === "auto_review") {
      const authorityFlags = new Set(Object.keys(authority).map(key => key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)));
      for (const key of Object.keys(policy)) {
        if (key.includes("-") && authorityFlags.has(key)) throw new Error(`Claude approval profile cannot override '${key}'.`);
      }
    }
    for (const [key, value] of Object.entries(authority)) {
      requirePolicyMatch(policy, key, value, provider);
    }
    return {
      provider: "claude-code", model: normalizedModel, reasoningEffort: null, permissionProfileId: profile,
      launchPolicy: { ...policy, ...authority }, configurationRevision: input.configurationRevision,
      ...homeHarnessField,
    };
  }

  scalarCliPolicy(policy, "Cursor");
  for (const key of Object.keys(policy)) {
    if (!["mode", "force", "sandbox"].includes(key)) {
      throw new Error(`Cursor supervised launch policy contains unsupported native option '${key}'.`);
    }
  }
  const profile = resolveProfile(provider, input.permissionProfileId, "sandboxed_write", ["read_only", "sandboxed_write", "full_access"]);
  const authority = profile === "sandboxed_write"
    ? { mode: null, force: true, sandbox: "enabled" }
    : profile === "full_access"
      ? { mode: null, force: true, sandbox: "disabled" }
      : { mode: "ask", force: false, sandbox: null };
  if (profile === "read_only") {
    requirePolicyMatch(policy, "mode", "ask", provider);
    requirePolicyMatch(policy, "force", false, provider);
    if (Object.hasOwn(policy, "sandbox") && ![null, "enabled"].includes(policy.sandbox as null | string)) {
      throw new Error("Cursor read-only profile cannot disable its sandbox.");
    }
  } else {
    requirePolicyMatch(policy, "force", true, provider);
    requirePolicyMatch(policy, "sandbox", authority.sandbox, provider);
    if (Object.hasOwn(policy, "mode") && policy.mode !== null) throw new Error(`Cursor ${profile} profile cannot retain a read-only mode.`);
  }
  const { mode: _mode, force: _force, sandbox: _sandbox, ...rest } = policy;
  return {
    provider, model: normalizedModel, reasoningEffort: null, permissionProfileId: profile,
    launchPolicy: {
      ...rest,
      ...(authority.mode === null ? {} : { mode: authority.mode }),
      // Keep the negative authority explicit. The native adapter independently
      // attests this durable snapshot before it turns `false` into an omitted
      // CLI flag, so a missing field can never be mistaken for read-only.
      force: authority.force,
      ...(authority.sandbox === null ? {} : { sandbox: authority.sandbox }),
    },
    configurationRevision: input.configurationRevision,
  };
}

/**
 * Rebuild a native launch policy from a previously trusted, persisted policy
 * and a user-facing profile selection.  This is intentionally separate from
 * `resolveProviderConfigurationSnapshot`: the latter attests a complete
 * provider request at launch time, while this function is the only path that
 * may translate an Inspector profile change into native authority.
 *
 * Non-authority provider options survive.  Authority-owned fields are removed
 * before the selected profile is applied, so switching e.g. Claude read-only
 * to full access cannot retain a stale `permissionMode`, and a compromised
 * renderer has no policy object through which to inject native flags.
 */
export function deriveProviderConfigurationSnapshot(
  selection: ProviderConfigurationSelection,
  currentTrustedLaunchPolicy: unknown,
): ProviderConfigurationSnapshot {
  const provider = selection.provider.trim().toLowerCase();
  const permissionProfileId = assertSupervisedPermissionProfileAvailable(provider, selection.permissionProfileId);
  const existing = plainPolicy(currentTrustedLaunchPolicy, provider);
  const stripped = stripProfileAuthority(provider, existing, permissionProfileId);
  return resolveProviderConfigurationSnapshot({
    ...selection,
    provider,
    permissionProfileId,
    launchPolicy: stripped,
  });
}

/**
 * With the owner's own setup on, Claude reads the owner's user settings (their
 * hooks, plugins, skills, permission rules and instructions) and nothing a
 * project supplies. Otherwise it reads no settings at all.
 */
function claudeSettingSources(homeHarness: boolean): string {
  return homeHarness ? "user" : "";
}

/** The owner's skills run through Claude's Skill tool, so it joins the tools only with their setup. */
function claudeApprovalTools(homeHarness: boolean): string[] {
  return ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", ...(homeHarness ? ["Skill"] : [])];
}

function stripProfileAuthority(
  provider: string,
  policy: Record<string, unknown>,
  nextPermissionProfileId: string,
): Record<string, unknown> {
  const previousClaudeProfileWasReadOnly = (policy.permissionMode === "plan" || policy.permissionMode === "dontAsk")
    && policy.dangerouslySkipPermissions === false;
  const previousClaudeProfileAsked = (policy.permissionMode === "default" || policy.permissionMode === "auto")
    && policy.dangerouslySkipPermissions === false;
  const nextClaudeProfileAsks = nextPermissionProfileId === "ask_before_write" || nextPermissionProfileId === "auto_review";
  const authorityKeys = provider === "codex"
    ? ["approvalPolicy", "sandboxPolicy", "approvalsReviewer"]
    : provider === "open-model"
      ? ["permission"]
    : provider === "claude-code" || provider === "claude"
      ? [
        "permissionMode",
        "dangerouslySkipPermissions",
        ...(nextPermissionProfileId === "read_only" || nextClaudeProfileAsks || previousClaudeProfileWasReadOnly || previousClaudeProfileAsked
          ? ["tools", "allowedTools", "settingSources"]
          : []),
        ...(nextClaudeProfileAsks || previousClaudeProfileAsked
          ? ["settings", "allowDangerouslySkipPermissions"] : []),
      ]
      : provider === "cursor"
        ? ["mode", "force", "sandbox"]
        : [];
  const next = { ...policy };
  for (const key of authorityKeys) delete next[key];
  return next;
}

function plainPolicy(value: unknown, provider: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`Provider '${provider}' requires a plain native launch-policy object.`);
  }
  return { ...(value as Record<string, unknown>) };
}

function scalarCliPolicy(policy: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(policy)) {
    if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") continue;
    if (Array.isArray(value) && value.every((item) => ["string", "number", "boolean"].includes(typeof item))) continue;
    throw new Error(`${label} launch policy value for '${key}' must be a scalar or scalar array.`);
  }
}

function resolveProfile(provider: string, requested: string | null, fallback: string, supported: readonly string[]): string {
  const profile = requested?.trim() || fallback;
  if (!supported.includes(profile)) throw new Error(`Permission profile '${profile}' is unavailable for provider '${provider}'.`);
  return profile;
}

function requirePolicyMatch(policy: Record<string, unknown>, key: string, expected: unknown, provider: string): void {
  if (Object.hasOwn(policy, key) && !isDeepStrictEqual(policy[key], expected)) {
    throw new Error(`Provider '${provider}' launch policy conflicts with permission-profile authority at '${key}'.`);
  }
}
