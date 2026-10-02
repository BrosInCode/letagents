// Fixture: the adapters' launch-policy attestation, and the Claude adapter's policy-to-arguments code, exactly as desktop 0.1.106 shipped it (da8c5ad7), with only
// its import paths changed. It stands in for an older build that does not
// know the keys a newer build stores, so a test can show what such a build
// does with them. Do not update it to match the current code.
import { isDeepStrictEqual } from "node:util";

import type { ProviderSpawnRequest } from "../../../electron/main/agents/provider-adapter.js";
import { assertManagedAgentPermissionProfileAvailable } from "../../../electron/main/agents/managed-agent-permission-profiles.js";
import { supervisedOpenCodePermissionPolicy, supervisedOpenCodePermissionProfileId } from "../../../electron/main/agents/opencode-launch-contract.js";

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
  } else if (provider === "open-model") {
    requireMatch(policy, "permission", supervisedOpenCodePermissionPolicy(supervisedOpenCodePermissionProfileId(profile)), provider);
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
        : {
          permissionMode: profile === "auto_review" ? "auto" : "default", dangerouslySkipPermissions: false,
          allowDangerouslySkipPermissions: false,
          tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"],
          allowedTools: ["mcp__letagents__*"], settingSources: "", settings: "{}",
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

// From claude-code-provider-adapter.ts.
const RESERVED_POLICY_KEYS = new Set([
  "print",
  "inputFormat",
  "input-format",
  "outputFormat",
  "output-format",
  "resume",
  "continue",
  "cwd",
  "verbose",
  // The adapter mints/asserts the session identity (msg_1382 spike).
  "sessionId",
  "session-id",
  // Session persistence is what makes bounded --resume recovery possible;
  // a policy must not silently disable the continuation.
  "noSessionPersistence",
  "no-session-persistence",
  // The managed workplace is injected explicitly so project-level .mcp.json
  // files cannot shadow it or exfiltrate its worker credential.
  "mcpConfig",
  "mcp-config",
  "strictMcpConfig",
  "strict-mcp-config",
  "permissionPromptTool",
  "permission-prompt-tool",
]);

function camelToKebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * Mechanically render the opaque Add Agent launch policy as CLI flags:
 * `{ permissionMode: "acceptEdits" }` → `--permission-mode acceptEdits`.
 * Purely syntactic — values are never mapped, renamed, or filtered beyond the
 * adapter-owned reserved flags above.
 */
export function claudeLaunchPolicyArgs(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude launchPolicy must be the native CLI options object.");
  }
  const policy = value as Record<string, unknown>;
  const args: string[] = [];
  for (const [key, entry] of Object.entries(policy)) {
    if (RESERVED_POLICY_KEYS.has(key)) {
      throw new Error(`Claude launchPolicy cannot override reserved flag '${key}'.`);
    }
    if (entry === undefined || entry === null || entry === false) continue;
    const flag = `--${camelToKebab(key)}`;
    if (entry === true) {
      args.push(flag);
    } else if (Array.isArray(entry)) {
      args.push(flag, entry.map((item) => String(item)).join(","));
    } else if (typeof entry === "string" || typeof entry === "number") {
      args.push(flag, String(entry));
    } else {
      throw new Error(`Claude launchPolicy value for '${key}' must be a scalar, boolean, or string array.`);
    }
  }
  return args;
}
