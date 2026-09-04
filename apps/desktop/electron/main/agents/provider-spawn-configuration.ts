import { isDeepStrictEqual } from "node:util";

import type { ProviderSpawnRequest } from "./provider-adapter.js";
import { assertManagedAgentPermissionProfileAvailable } from "./managed-agent-permission-profiles.js";
import { supervisedOpenCodePermissionPolicy } from "./opencode-launch-contract.js";

/**
 * Shared final attestation used by every native adapter. The daemon has
 * already normalized the snapshot; adapters independently require that the
 * real provider policy still carries the selected authority.
 */
export function attestProviderSpawnPolicy(
  provider: "codex" | "claude-code" | "cursor" | "open-model",
  request: ProviderSpawnRequest,
): Record<string, unknown> {
  if (!request.permissionProfileId) return plainPolicy(request.launchPolicy, provider);
  const profile = assertManagedAgentPermissionProfileAvailable(
    provider,
    request.permissionProfileId as never,
    "supervised",
  ).id;
  const policy = plainPolicy(request.launchPolicy, provider);
  if (provider === "codex") {
    const authority = profile === "ask_before_write"
      ? {
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      }
      : {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    requireMatch(policy, "approvalPolicy", authority.approvalPolicy, provider);
    requireMatch(policy, "sandboxPolicy", authority.sandboxPolicy, provider);
  } else if (provider === "open-model") {
    requireMatch(policy, "permission", supervisedOpenCodePermissionPolicy(
      profile === "ask_before_write" ? "ask_before_write" : "full_access",
    ), provider);
  } else if (provider === "claude-code") {
    const authority = profile === "read_only"
      ? {
        permissionMode: "dontAsk",
        dangerouslySkipPermissions: false,
        tools: ["Read", "Glob", "Grep"],
        allowedTools: ["mcp__letagents__*"],
        settingSources: "",
      }
      : profile === "full_access"
        ? { permissionMode: "bypassPermissions", dangerouslySkipPermissions: true }
        : { permissionMode: "acceptEdits", dangerouslySkipPermissions: false };
    for (const [key, value] of Object.entries(authority)) {
      requireMatch(policy, key, value, provider);
    }
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
  return policy;
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
