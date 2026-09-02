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

const efforts = new Set<Exclude<ProviderReasoningEffort, null>>(["low", "medium", "high", "xhigh", "max"]);
const reservedCodexPolicy = new Set(["threadId", "cwd", "input", "model", "reasoningEffort"]);

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
  const policy = plainPolicy(input.launchPolicy, provider);
  const normalizedModel = input.model?.trim() ?? null;

  if (provider === "codex") {
    for (const key of reservedCodexPolicy) if (Object.hasOwn(policy, key)) throw new Error(`Codex launch policy cannot override '${key}'.`);
    const profile = resolveProfile(provider, input.permissionProfileId, "full_access", ["full_access"]);
    requirePolicyMatch(policy, "approvalPolicy", "never", provider);
    requirePolicyMatch(policy, "sandboxPolicy", { type: "dangerFullAccess" }, provider);
    return {
      provider, model: normalizedModel, reasoningEffort: input.reasoningEffort, permissionProfileId: profile,
      launchPolicy: { ...policy, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
      configurationRevision: input.configurationRevision,
    };
  }

  if (provider === "open-model") {
    if (input.reasoningEffort !== null) {
      throw new Error("Open Model reasoning effort is controlled by the selected endpoint and model.");
    }
    const profile = resolveProfile(provider, input.permissionProfileId, "full_access", ["full_access"]);
    requirePolicyMatch(policy, "permission", { "*": "allow" }, provider);
    return {
      provider,
      model: normalizedModel,
      reasoningEffort: null,
      permissionProfileId: profile,
      launchPolicy: { ...policy, permission: { "*": "allow" } },
      configurationRevision: input.configurationRevision,
    };
  }

  if (input.reasoningEffort !== null) throw new Error(`Provider '${provider}' does not support reasoning effort.`);
  if (provider === "claude-code" || provider === "claude") {
    scalarCliPolicy(policy, "Claude");
    const profile = resolveProfile(provider, input.permissionProfileId, "read_only", ["read_only", "ask_before_write", "full_access"]);
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
        settingSources: "",
      }
      : profile === "full_access"
        ? { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true }
        : { permissionMode: "acceptEdits", dangerouslySkipPermissions: false };
    for (const [key, value] of Object.entries(authority)) {
      requirePolicyMatch(policy, key, value, provider);
    }
    return {
      provider: "claude-code", model: normalizedModel, reasoningEffort: null, permissionProfileId: profile,
      launchPolicy: { ...policy, ...authority }, configurationRevision: input.configurationRevision,
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

function stripProfileAuthority(
  provider: string,
  policy: Record<string, unknown>,
  nextPermissionProfileId: string,
): Record<string, unknown> {
  const previousClaudeProfileWasReadOnly = (policy.permissionMode === "plan" || policy.permissionMode === "dontAsk")
    && policy.dangerouslySkipPermissions === false;
  const authorityKeys = provider === "codex"
    ? ["approvalPolicy", "sandboxPolicy"]
    : provider === "open-model"
      ? ["permission"]
    : provider === "claude-code" || provider === "claude"
      ? [
        "permissionMode",
        "dangerouslySkipPermissions",
        ...(nextPermissionProfileId === "read_only" || previousClaudeProfileWasReadOnly
          ? ["tools", "allowedTools", "settingSources"]
          : []),
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
