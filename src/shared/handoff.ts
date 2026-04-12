export const HANDOFF_EXECUTION_MODES = [
  "hosted_isolated",
  "supplier_local",
] as const;

export type HandoffExecutionMode = (typeof HANDOFF_EXECUTION_MODES)[number];

export const HANDOFF_SUPPORTED_EXECUTION_MODES = [
  "hosted_isolated",
] as const;

export const HANDOFF_OUTPUT_TYPES = [
  "research_note",
  "comment",
  "draft_pr",
] as const;

export type HandoffOutputType = (typeof HANDOFF_OUTPUT_TYPES)[number];

export const HANDOFF_PERMISSION_PROFILES = [
  "research_readonly",
  "comment_review",
  "draft_pr_write",
] as const;

export type HandoffPermissionProfile = (typeof HANDOFF_PERMISSION_PROFILES)[number];

export const HANDOFF_SESSION_STATUSES = [
  "requested",
  "approved",
  "running",
  "completed",
  "failed",
  "revoked",
  "expired",
  "cancelled",
] as const;

export type HandoffSessionStatus = (typeof HANDOFF_SESSION_STATUSES)[number];

export const HANDOFF_GRANT_TYPES = [
  "repo_read",
  "branch_write",
  "pr_comment",
  "secret",
] as const;

export type HandoffGrantType = (typeof HANDOFF_GRANT_TYPES)[number];

export const HANDOFF_GRANT_STATUSES = [
  "active",
  "revoked",
  "expired",
] as const;

export type HandoffGrantStatus = (typeof HANDOFF_GRANT_STATUSES)[number];

export interface HandoffCapabilityGrant {
  grant_type: HandoffGrantType;
  scope: string;
  scoped_branch: string | null;
}

export interface HandoffCapabilityManifest {
  policy_version: 1;
  execution_mode: HandoffExecutionMode;
  output_type: HandoffOutputType;
  permission_profile: HandoffPermissionProfile;
  repo_instructions_trusted: false;
  recursive_handoff: "deny";
  grants: HandoffCapabilityGrant[];
}

export const HANDOFF_OUTPUT_TO_PERMISSION_PROFILE: Record<
  HandoffOutputType,
  HandoffPermissionProfile
> = {
  research_note: "research_readonly",
  comment: "comment_review",
  draft_pr: "draft_pr_write",
};

export const HANDOFF_OUTPUT_TO_GRANT_TYPES: Record<
  HandoffOutputType,
  readonly HandoffGrantType[]
> = {
  research_note: ["repo_read"],
  comment: ["repo_read", "pr_comment"],
  draft_pr: ["repo_read", "branch_write"],
};

function normalizeEnumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T
): T[number] | null {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.includes(normalized as T[number]) ? (normalized as T[number]) : null;
}

export function normalizeHandoffExecutionMode(
  value: unknown
): HandoffExecutionMode | null {
  return normalizeEnumValue(value, HANDOFF_EXECUTION_MODES);
}

export function normalizeHandoffOutputType(value: unknown): HandoffOutputType | null {
  return normalizeEnumValue(value, HANDOFF_OUTPUT_TYPES);
}

export function normalizeHandoffPermissionProfile(
  value: unknown
): HandoffPermissionProfile | null {
  return normalizeEnumValue(value, HANDOFF_PERMISSION_PROFILES);
}

export function normalizeHandoffSessionStatus(
  value: unknown
): HandoffSessionStatus | null {
  return normalizeEnumValue(value, HANDOFF_SESSION_STATUSES);
}

export function normalizeHandoffGrantType(value: unknown): HandoffGrantType | null {
  return normalizeEnumValue(value, HANDOFF_GRANT_TYPES);
}

export function normalizeHandoffGrantStatus(
  value: unknown
): HandoffGrantStatus | null {
  return normalizeEnumValue(value, HANDOFF_GRANT_STATUSES);
}

export function getDefaultHandoffPermissionProfile(
  outputType: HandoffOutputType
): HandoffPermissionProfile {
  return HANDOFF_OUTPUT_TO_PERMISSION_PROFILE[outputType];
}

export function getDefaultHandoffGrantTypes(
  outputType: HandoffOutputType
): readonly HandoffGrantType[] {
  return HANDOFF_OUTPUT_TO_GRANT_TYPES[outputType];
}

export function isSupportedHandoffExecutionMode(
  mode: HandoffExecutionMode
): boolean {
  return HANDOFF_SUPPORTED_EXECUTION_MODES.includes(
    mode as (typeof HANDOFF_SUPPORTED_EXECUTION_MODES)[number]
  );
}

/** Default grant TTLs for v1 (strict boundaries); callers may shorten, not widen, without re-approval. */
export const HANDOFF_DEFAULT_GRANT_TTL_MS: Record<HandoffOutputType, number> = {
  research_note: 4 * 60 * 60 * 1000,
  comment: 8 * 60 * 60 * 1000,
  draft_pr: 48 * 60 * 60 * 1000,
};

export type HandoffPolicyErrorCode =
  | "unsupported_execution_mode"
  | "permission_profile_mismatch"
  | "recursive_handoff_forbidden";

export interface HandoffPolicyRequest {
  outputType: HandoffOutputType;
  /** If omitted, the default profile for `outputType` is used. */
  permissionProfile?: HandoffPermissionProfile;
  /** If omitted, defaults to `hosted_isolated`. */
  executionMode?: HandoffExecutionMode;
  /** v1: must be null/undefined — nested handoffs require a fresh user-approved session. */
  parentSessionId?: string | null;
  /** Repo identifier (e.g. `owner/name`) used as grant scope. */
  repoScope: string;
  targetBranch: string;
}

export function resolveHandoffPermissionProfile(
  outputType: HandoffOutputType,
  permissionProfile?: HandoffPermissionProfile
): HandoffPermissionProfile {
  return permissionProfile ?? getDefaultHandoffPermissionProfile(outputType);
}

export function permissionProfileMatchesOutput(
  outputType: HandoffOutputType,
  permissionProfile: HandoffPermissionProfile
): boolean {
  return HANDOFF_OUTPUT_TO_PERMISSION_PROFILE[outputType] === permissionProfile;
}

export function buildHandoffCapabilityManifest(input: {
  outputType: HandoffOutputType;
  permissionProfile: HandoffPermissionProfile;
  executionMode: HandoffExecutionMode;
  repoScope: string;
  targetBranch: string;
}): HandoffCapabilityManifest {
  const grantTypes = getDefaultHandoffGrantTypes(input.outputType);
  const grants: HandoffCapabilityGrant[] = grantTypes.map((grant_type) => ({
    grant_type,
    scope: input.repoScope.trim(),
    scoped_branch: grant_type === "branch_write" ? input.targetBranch.trim() : null,
  }));

  return {
    policy_version: 1,
    execution_mode: input.executionMode,
    output_type: input.outputType,
    permission_profile: input.permissionProfile,
    repo_instructions_trusted: false,
    recursive_handoff: "deny",
    grants,
  };
}

export type HandoffPolicyResult =
  | {
      ok: true;
      permissionProfile: HandoffPermissionProfile;
      executionMode: HandoffExecutionMode;
      manifest: HandoffCapabilityManifest;
    }
  | {
      ok: false;
      code: HandoffPolicyErrorCode;
      message: string;
    };

/**
 * Core v1 policy: sovereign platform manifest, single contracted execution lane,
 * output-bound permission profiles, no recursive handoff.
 */
export function evaluateHandoffPolicy(input: HandoffPolicyRequest): HandoffPolicyResult {
  const executionMode = input.executionMode ?? "hosted_isolated";
  if (!isSupportedHandoffExecutionMode(executionMode)) {
    return {
      ok: false,
      code: "unsupported_execution_mode",
      message: `Execution mode ${executionMode} is not supported for v1 handoffs.`,
    };
  }

  if (input.parentSessionId) {
    return {
      ok: false,
      code: "recursive_handoff_forbidden",
      message: "Nested handoff sessions are blocked in v1; start a new approved handoff instead.",
    };
  }

  const permissionProfile = resolveHandoffPermissionProfile(
    input.outputType,
    input.permissionProfile
  );

  if (!permissionProfileMatchesOutput(input.outputType, permissionProfile)) {
    return {
      ok: false,
      code: "permission_profile_mismatch",
      message: `Permission profile ${permissionProfile} does not match output type ${input.outputType}.`,
    };
  }

  const manifest = buildHandoffCapabilityManifest({
    outputType: input.outputType,
    permissionProfile,
    executionMode,
    repoScope: input.repoScope,
    targetBranch: input.targetBranch,
  });

  return { ok: true, permissionProfile, executionMode, manifest };
}
