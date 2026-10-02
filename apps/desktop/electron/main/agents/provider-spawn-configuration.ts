import { isDeepStrictEqual } from "node:util";

import type { ProviderSpawnRequest } from "./provider-adapter.js";
import { assertManagedAgentPermissionProfileAvailable } from "./managed-agent-permission-profiles.js";
import { supervisedOpenCodePermissionPolicy, supervisedOpenCodePermissionProfileId } from "./opencode-launch-contract.js";

/**
 * Shared final attestation used by every native adapter. The daemon has
 * already normalized the snapshot; adapters independently require that the
 * real provider policy still carries the selected authority.
 *
 * A stored policy is otherwise the agent's own native options, passed on as
 * they are. Not with the owner's own setup: such a launch gets the access
 * level's own options and nothing else the policy holds. A stored option
 * could otherwise name the project's settings, add a folder, a plugin or a
 * server, or move the model elsewhere, and what the switch promises would
 * depend on what some earlier writer left in the policy.
 */
export function attestProviderSpawnPolicy(
  provider: "codex" | "claude-code" | "cursor" | "open-model",
  request: ProviderSpawnRequest,
): Record<string, unknown> {
  const homeHarness = spawnUsesHomeHarness(provider, request);
  if (!request.permissionProfileId) {
    if (homeHarness) throw new Error(`${provider} launch refused: an agent with its owner's own setup starts only under a named access level.`);
    return plainPolicy(request.launchPolicy, provider);
  }
  const profile = assertManagedAgentPermissionProfileAvailable(
    provider,
    request.permissionProfileId as never,
    "supervised",
  ).id;
  const policy = plainPolicy(request.launchPolicy, provider);
  let ownerSetupPolicy: Record<string, unknown> | null = null;
  if (provider === "codex") {
    const authority = profile === "auto_review"
      ? {
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
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
      throw new Error(`${provider} launch does not attest permission-profile authority at 'approvalsReviewer'.`);
    }
    for (const [key, value] of Object.entries(authority)) {
      requireMatch(policy, key, value, provider);
    }
    if (homeHarness) ownerSetupPolicy = authority;
  } else if (provider === "open-model") {
    requireMatch(policy, "permission", supervisedOpenCodePermissionPolicy(supervisedOpenCodePermissionProfileId(profile)), provider);
  } else if (provider === "claude-code") {
    const authority = profile === "read_only"
      ? {
        permissionMode: "dontAsk",
        dangerouslySkipPermissions: false,
        tools: ["Read", "Glob", "Grep"],
        allowedTools: ["mcp__letagents__*"],
        // The owner's own user settings, and still nothing a project supplies.
        settingSources: homeHarness ? "user" : "",
      }
      : profile === "full_access"
        ? { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true }
        : {
          permissionMode: profile === "auto_review" ? "auto" : "default", dangerouslySkipPermissions: false,
          allowDangerouslySkipPermissions: false,
          // The owner's skills run through Claude's Skill tool.
          tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", ...(homeHarness ? ["Skill"] : [])],
          allowedTools: ["mcp__letagents__*"], settingSources: homeHarness ? "user" : "", settings: "{}",
        };
    if (profile === "ask_before_write" || profile === "auto_review") {
      const authorityFlags = new Set(Object.keys(authority).map(key => key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)));
      for (const key of Object.keys(policy)) {
        if (key.includes("-") && authorityFlags.has(key)) throw new Error(`Claude approval profile cannot override '${key}'.`);
      }
    }
    for (const [key, value] of Object.entries(authority)) {
      requireMatch(policy, key, value, provider);
    }
    if (homeHarness) ownerSetupPolicy = authority;
  } else if (profile === "read_only") {
    requireMatch(policy, "mode", "ask", provider);
    requireMatch(policy, "force", false, provider);
    if (Object.hasOwn(policy, "sandbox") && ![null, "enabled"].includes(policy.sandbox as null | string)) {
      throw new Error("Cursor read-only launch disables its sandbox.");
    }
  } else {
    requireMatch(policy, "force", true, provider);
    requireMatch(policy, "sandbox", profile === "sandboxed_write" ? "enabled" : "disabled", provider);
    if (Object.hasOwn(policy, "mode") && policy.mode !== null) throw new Error(`Cursor ${profile} launch retained a read-only mode.`);
  }
  if (provider !== "codex" && request.reasoningEffort !== null && request.reasoningEffort !== undefined) {
    throw new Error(`${provider} does not support the selected reasoning effort.`);
  }
  if (!Number.isSafeInteger(request.configurationRevision) || Number(request.configurationRevision) < 1) {
    throw new Error(`${provider} launch omitted its exact configuration revision.`);
  }
  return ownerSetupPolicy ?? policy;
}

/**
 * The stored options a launch with the owner's setup did not pass on: every
 * one that is not the access level's own. They are named to the owner, short
 * and printable, so that leaving them out is never a silent change.
 */
export function ownerSetupUnusedOptionsNotice(provider: "Codex" | "Claude Code", stored: unknown, attested: Record<string, unknown>): string | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const unused = Object.keys(stored).filter((key) => !Object.hasOwn(attested, key))
    .map((key) => JSON.stringify(key.replace(/[^\x20-\x7e]/g, "?").slice(0, 48)));
  if (!unused.length) return null;
  return `With your own setup on, this agent starts with its access level's own ${provider} options only. `
    + `These saved options were not used: ${unused.slice(0, 8).join(", ")}${unused.length > 8 ? ` and ${unused.length - 8} more` : ""}.`;
}

const unusedOptionsLastSaid = new Map<string, string>();

/**
 * The line above is said when what was left out changes, not at every start.
 * This process remembers what each agent's last start was told and passes the
 * line on only when it differs. Nothing is stored, so the line is said once
 * more after the app restarts. A start that failed after it was given the
 * line forgets it, so the next one says it. An agent with no id is always told.
 */
export const ownerSetupUnusedOptionsSaidOnce = {
  whenChanged(agentId: string | undefined, notice: string | null): string | null {
    if (agentId === undefined) return notice;
    if (unusedOptionsLastSaid.get(agentId) === (notice ?? "")) return null;
    unusedOptionsLastSaid.set(agentId, notice ?? "");
    return notice;
  },
  forget(agentId: string | undefined, given: readonly string[]): void {
    if (agentId !== undefined && given.includes(unusedOptionsLastSaid.get(agentId) ?? "")) unusedOptionsLastSaid.delete(agentId);
  },
};

/**
 * Whether this launch loads the owner's own provider setup. Only an exact
 * `true` turns it on. A rental works for someone else and never gets it, and
 * Cursor and Open Model have no owner setup to load, so a request that asks
 * for it there is refused instead of quietly starting with less.
 */
export function spawnUsesHomeHarness(
  provider: "codex" | "claude-code" | "cursor" | "open-model",
  request: Pick<ProviderSpawnRequest, "homeHarness" | "supervisorEntryId" | "deliveryMode">,
): boolean {
  if (request.homeHarness !== true) return false;
  if (request.supervisorEntryId?.startsWith("supervised_rental_")) {
    throw new Error(`${provider} launch refused: a rented agent never uses its owner's own setup.`);
  }
  if (provider !== "codex" && provider !== "claude-code") {
    throw new Error(`${provider} launch refused: this agent app has no owner setup to use.`);
  }
  // Only an agent the daemon delivers room messages to can be held back from
  // its next turn once the owner turns the setup off.
  if (request.deliveryMode !== "daemon_inbox") {
    throw new Error(`${provider} launch refused: an agent that collects its own room messages never uses its owner's own setup.`);
  }
  return true;
}

function plainPolicy(value: unknown, provider: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${provider} launch policy must be a plain native CLI options object.`);
  }
  return value as Record<string, unknown>;
}

function requireMatch(policy: Record<string, unknown>, key: string, expected: unknown, provider: string): void {
  if (!Object.hasOwn(policy, key) || !isDeepStrictEqual(policy[key], expected)) {
    throw new Error(`${provider} launch does not attest permission-profile authority at '${key}'.`);
  }
}
