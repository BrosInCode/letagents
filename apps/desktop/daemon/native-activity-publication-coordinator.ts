import { publishWorkerNativeActivity } from "./cloud-http.js";
import { redactCredentialText } from "./credential-redaction.js";
import { resolveReadyReachedAt } from "./provider-stream-policy.js";
import type { DaemonManifestEntry } from "./types.js";
import type { WorkerBindingStore } from "./worker-binding-store.js";

export type NativeActivityPublicationPorts = {
  bindings: Pick<WorkerBindingStore, "credentialFor" | "get" | "publish">;
  updateEntry(
    entryId: string,
    update: (entry: DaemonManifestEntry) => DaemonManifestEntry,
  ): Promise<DaemonManifestEntry>;
  startDelivery(entryId: string): Promise<void>;
};

/**
 * Owns the durable publication reservation and remote native-liveness effect.
 * Credential custody remains in WorkerBindingStore and manifest recovery is
 * committed only after the exact binding publication succeeds.
 */
export class NativeActivityPublicationCoordinator {
  constructor(private readonly ports: NativeActivityPublicationPorts) {}

  async publish(
    entryId: string,
    method: string,
    status: "working" | "idle",
    observedAt = new Date().toISOString(),
  ): Promise<boolean> {
    const safeMethod = redactCredentialText(method, 160).value;
    const observedMs = Date.parse(observedAt);
    const currentBinding = await this.ports.bindings.get(entryId);
    if (!currentBinding || !await this.ports.bindings.credentialFor(currentBinding)) return false;
    const publication = await this.ports.bindings.publish(
      entryId,
      observedMs,
      async ({ binding, sequence, observed_at }) => {
        const credential = await this.ports.bindings.credentialFor(binding);
        if (!credential) {
          throw new Error("Worker credential is unavailable until desktop credential delivery.");
        }
        return {
          accepted: await publishWorkerNativeActivity({
            apiUrl: binding.api_url,
            roomId: binding.room_id,
            agentSessionId: binding.agent_session_id,
            bearer: credential,
            observedAt: observed_at,
            sequence,
            method: safeMethod,
            status,
            operation: "the daemon bridge",
          }),
        };
      },
    );
    if (!publication) return false;
    if (!publication.accepted) {
      throw new Error("Native activity endpoint rejected a stale daemon observation.");
    }
    const verifiedBinding = await this.ports.bindings.get(entryId);
    if (verifiedBinding
      && verifiedBinding.room_id === currentBinding.room_id
      && verifiedBinding.work_attempt_id === currentBinding.work_attempt_id
      && verifiedBinding.execution_generation_id === currentBinding.execution_generation_id
      && verifiedBinding.agent_session_id === currentBinding.agent_session_id) {
      let recoveredCredentialHandoff = false;
      await this.ports.updateEntry(entryId, (current) => {
        const recoversCredentialHandoff = current.desired_state === "running"
          && current.condition === "coordination_blocked"
          && current.last_error === "Provider is running; waiting for desktop credential handoff."
          && current.room_id === verifiedBinding.room_id
          && current.work_attempt_id === verifiedBinding.work_attempt_id
          && current.provider_ref?.execution_generation_id === verifiedBinding.execution_generation_id;
        if (!recoversCredentialHandoff) return current;
        recoveredCredentialHandoff = true;
        const confirmedAt = publication.observed_at;
        return {
          ...current,
          observed_state: "working",
          condition: "none",
          last_error: null,
          ready_reached_at: resolveReadyReachedAt(current, true, confirmedAt),
          workplace_liveness: {
            state: "reachable",
            observed_at: confirmedAt,
            detail: "scoped worker bearer verified",
          },
        };
      });
      if (recoveredCredentialHandoff) {
        void this.ports.startDelivery(entryId).catch(() => undefined);
      }
    }
    return true;
  }
}
