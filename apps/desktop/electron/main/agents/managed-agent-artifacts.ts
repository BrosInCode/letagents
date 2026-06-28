export const MANAGED_AGENT_CONTEXT_ARTIFACT_LIMIT = 20;

export type ManagedAgentRoomArtifactPayload = {
  identity_key?: string | null;
  provider?: string | null;
  kind?: string | null;
  artifact_id?: string | null;
  artifact_number?: number | null;
  title?: string | null;
  url?: string | null;
  ref?: string | null;
  state?: string | null;
  source?: string | null;
  first_seen_at?: string | null;
  updated_at?: string | null;
  linked_task_ids?: string[];
};

export type CompactManagedAgentRoomArtifact = {
  identityKey: string;
  provider: string;
  kind: string;
  artifactId: string | null;
  artifactNumber: number | null;
  title: string | null;
  url: string | null;
  ref: string | null;
  state: string | null;
  source: string;
  linkedTaskIds: string[];
  updatedAt: string | null;
};

function truncate(value: string | null | undefined, max = 700): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function managedAgentRoomArtifactsPath(roomIdentifier: string): string {
  const params = new URLSearchParams();
  params.set("limit", String(MANAGED_AGENT_CONTEXT_ARTIFACT_LIMIT));
  return `/rooms/${encodeURIComponent(roomIdentifier)}/artifacts?${params.toString()}`;
}

export function compactManagedAgentRoomArtifact(
  artifact: ManagedAgentRoomArtifactPayload,
): CompactManagedAgentRoomArtifact | null {
  const identityKey = stringValue(artifact.identity_key);
  const kind = stringValue(artifact.kind);
  if (!identityKey || !kind) {
    return null;
  }

  return {
    identityKey,
    provider: stringValue(artifact.provider) || "unknown",
    kind,
    artifactId: stringValue(artifact.artifact_id),
    artifactNumber: typeof artifact.artifact_number === "number" ? artifact.artifact_number : null,
    title: artifact.title ? truncate(artifact.title, 240) : null,
    url: stringValue(artifact.url),
    ref: artifact.ref ? truncate(artifact.ref, 240) : null,
    state: stringValue(artifact.state),
    source: stringValue(artifact.source) || "manual",
    linkedTaskIds: Array.isArray(artifact.linked_task_ids)
      ? artifact.linked_task_ids
        .map((taskId) => typeof taskId === "string" ? taskId.trim() : "")
        .filter((taskId): taskId is string => taskId.length > 0)
      : [],
    updatedAt: stringValue(artifact.updated_at) || stringValue(artifact.first_seen_at),
  };
}

export function compactManagedAgentRoomArtifacts(
  artifacts: ManagedAgentRoomArtifactPayload[] | null | undefined,
): CompactManagedAgentRoomArtifact[] {
  return (artifacts || [])
    .flatMap((artifact): CompactManagedAgentRoomArtifact[] => {
      const compact = compactManagedAgentRoomArtifact(artifact);
      return compact ? [compact] : [];
    })
    .slice(0, MANAGED_AGENT_CONTEXT_ARTIFACT_LIMIT);
}
