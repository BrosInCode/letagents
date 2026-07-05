import type {
  DesktopManagedAgentPublicChangeSummary,
  DesktopRoomStorageState,
} from "../../ipc-types.js";
import { localRoomIdentifierForStorage } from "../rooms/local-store.js";
import { publishLocalRoomWorkflowArtifact } from "../rooms/artifacts/local-store.js";
import type { StoredAgentSessionState } from "./state.js";

export function buildManagedAgentChangeSummaryWorkflowArtifact(input: {
  summary: DesktopManagedAgentPublicChangeSummary;
  workerSession: Pick<
    StoredAgentSessionState,
    "session_id" | "display_name" | "actor_label" | "agent_key"
  >;
}): Record<string, unknown> | null {
  if (!isPublishableManagedAgentChangeSummary(input.summary)) {
    return null;
  }
  const branch = input.summary.repoBranch?.trim() || "unknown";
  const agentLabel = managedAgentChangeSummaryActorLabel(input.workerSession);
  const agentIdentity = managedAgentChangeSummaryArtifactActorIdentity(input.workerSession);
  const isClean = input.summary.changedFileCount === 0;
  const fileLabel = input.summary.changedFileCount === 1
    ? "1 file"
    : `${input.summary.changedFileCount} files`;
  return {
    provider: "git",
    kind: "change_summary",
    id: `managed-agent:${agentIdentity}:branch:${branch}`,
    title: isClean
      ? `${agentLabel} clean on ${branch}`
      : `${agentLabel} changes on ${branch} (${fileLabel})`,
    ref: input.summary.repoBranch?.trim() || null,
    state: isClean ? "clean" : "updated",
  };
}

export async function publishManagedAgentLocalChangeSummaryArtifact(input: {
  roomIdentifier: string;
  storage: DesktopRoomStorageState;
  workerSession: StoredAgentSessionState;
  summary: DesktopManagedAgentPublicChangeSummary;
  taskId?: string | null;
}): Promise<{ artifactIdentityKey: string } | null> {
  if (input.storage.effectiveMode !== "local") {
    return null;
  }
  const artifact = buildManagedAgentChangeSummaryWorkflowArtifact({
    summary: input.summary,
    workerSession: input.workerSession,
  });
  if (!artifact) {
    return null;
  }
  const localRoomIdentifier = localRoomIdentifierForStorage(input.storage, input.roomIdentifier);
  const result = await publishLocalRoomWorkflowArtifact({
    roomId: localRoomIdentifier,
    artifact,
    taskId: input.taskId ?? null,
    replaceLinkedTaskIds: true,
  });
  const artifactIdentityKey = result.artifact.identity_key;
  if (!artifactIdentityKey) {
    throw new Error("Managed-agent change summary artifact was published without an identity key.");
  }
  return { artifactIdentityKey };
}

function isPublishableManagedAgentChangeSummary(
  summary: DesktopManagedAgentPublicChangeSummary,
): boolean {
  return summary.isGitRepo && !summary.error && Number.isFinite(summary.changedFileCount);
}

function managedAgentChangeSummaryActorLabel(
  workerSession: Pick<StoredAgentSessionState, "display_name" | "actor_label" | "agent_key">,
): string {
  const displayName = workerSession.display_name?.trim();
  if (displayName) return displayName;
  const actorLabel = workerSession.actor_label?.split(" | ")[0]?.trim();
  if (actorLabel) return actorLabel;
  return workerSession.agent_key?.trim() || "Agent";
}

function managedAgentChangeSummaryArtifactActorIdentity(
  workerSession: Pick<StoredAgentSessionState, "session_id" | "agent_key">,
): string {
  const agentKey = workerSession.agent_key?.trim();
  if (agentKey && !isGenericManagedAgentKey(agentKey)) {
    return `key:${agentKey}`;
  }
  return `session:${workerSession.session_id.trim() || "unknown"}`;
}

function isGenericManagedAgentKey(agentKey: string): boolean {
  return ["agent", "codex", "claude-code", "cursor", "open-model"].includes(agentKey.toLowerCase());
}
