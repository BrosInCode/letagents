import type {
  DesktopGitRoomInfo,
  DesktopGitRoomRefType,
  DesktopGitRoomRepositoryInfo,
  DesktopGitRoomVisibility,
} from "../../ipc-types.js";

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function visibilityValue(value: unknown): DesktopGitRoomVisibility {
  return value === "public" || value === "private" || value === "unknown"
    ? value
    : "unknown";
}

function refTypeValue(value: unknown): DesktopGitRoomRefType {
  return value === "branch" || value === "tag" || value === "pull_request"
    ? value
    : "default_branch";
}

function mapRepository(value: unknown): DesktopGitRoomRepositoryInfo | null {
  const repo = objectValue(value);
  const fullName = stringValue(repo?.full_name);
  const owner = stringValue(repo?.owner);
  const name = stringValue(repo?.name);
  if (!repo || !fullName || !owner || !name) {
    return null;
  }

  return {
    id: stringValue(repo.id),
    fullName,
    owner,
    name,
  };
}

export function mapDesktopGitRoomPayload(value: unknown): DesktopGitRoomInfo | null {
  const payload = objectValue(value);
  const repository = mapRepository(payload?.repository);
  const ref = objectValue(payload?.ref);
  if (!payload || !repository || !ref) {
    return null;
  }

  return {
    provider: stringValue(payload.provider) || "git",
    host: stringValue(payload.host) || (payload.provider === "github" ? "github.com" : "git"),
    repository,
    ref: {
      type: refTypeValue(ref.type),
      name: stringValue(ref.name),
      defaultBranch: stringValue(ref.default_branch),
      baseRef: stringValue(ref.base_ref),
      headRef: stringValue(ref.head_ref),
      headRepository: mapRepository(ref.head_repository),
    },
    visibility: visibilityValue(payload.visibility),
    accessMode: visibilityValue(payload.access_mode),
    isDefault: payload.is_default === true,
    source: stringValue(payload.source) || "unknown",
  };
}
