import type { DaemonManifestEntry } from "./types.js";
import type { ProviderActionHandle } from "./provider-action-port.js";
import type { SupervisedAgentDelivery, SupervisedIngressAgent } from "./supervised-agent-delivery.js";
import type { WorkerSessionBinding } from "./worker-binding-store.js";

export type ExactRoomDeliveryControlInput = {
  entryId: string;
  roomId: string;
  sourceMessageId: string;
  workAttemptId: string;
  executionGenerationId: string;
  agentSessionId: string;
  daemonGeneration: number;
};

export interface RoomDeliveryControlOptions {
  delivery: SupervisedAgentDelivery | null;
  supportsRunRoomTurn: () => boolean;
  supportsRepairContinuation: () => boolean;
  currentGeneration: () => number;
  getEntry: (entryId: string) => Promise<DaemonManifestEntry | null | undefined>;
  getHandle: (entryId: string) => ProviderActionHandle | null;
  getBinding: (entryId: string) => Promise<WorkerSessionBinding | null>;
  credentialFor: (binding: WorkerSessionBinding) => Promise<string | null>;
  isExactAuthority: (agent: SupervisedIngressAgent) => Promise<boolean>;
}

/** Owns exact-identity operator controls for one supervised room delivery. */
export class RoomDeliveryControl {
  constructor(private readonly options: RoomDeliveryControlOptions) {}

  async retry(input: ExactRoomDeliveryControlInput): Promise<void> {
    validateCoordinates(input, "retry");
    if (!this.options.delivery || !this.options.supportsRunRoomTurn()) {
      throw new Error("This supervisor does not support room delivery retry.");
    }
    if (input.daemonGeneration !== this.options.currentGeneration()) {
      throw new Error("The supervisor generation changed; refresh before retrying.");
    }
    const entry = await this.options.getEntry(input.entryId);
    const handle = this.options.getHandle(input.entryId);
    const binding = await this.options.getBinding(input.entryId);
    if (!entry || !handle || !binding
      || entry.room_id !== input.roomId
      || entry.delivery_mode !== "daemon_inbox"
      || entry.work_attempt_id !== input.workAttemptId
      || entry.provider_ref?.execution_generation_id !== input.executionGenerationId
      || binding.room_id !== input.roomId
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId
      || binding.agent_session_id !== input.agentSessionId) {
      throw new Error("The room delivery binding is stale; refresh before retrying.");
    }
    const credential = await this.options.credentialFor(binding);
    if (!credential) throw new Error("Waiting for desktop credential handoff before retrying delivery.");
    const agent: SupervisedIngressAgent = {
      agentId: entry.id,
      roomId: binding.room_id,
      provider: entry.provider,
      apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id,
      bearer: credential,
      handle,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: handle.providerContinuationId,
      providerConnection: handle.providerConnection ?? null,
      executionGenerationId: binding.execution_generation_id,
      daemonGeneration: this.options.currentGeneration(),
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
    };
    if (!await this.options.isExactAuthority(agent)) {
      throw new Error("The room delivery binding is no longer current; refresh before retrying.");
    }
    await this.options.delivery.retry(agent, input.sourceMessageId);
  }

  async restoreConversation(input: ExactRoomDeliveryControlInput): Promise<void> {
    if (!this.options.delivery || !this.options.supportsRepairContinuation()) {
      throw new Error("This supervisor cannot restore provider conversations.");
    }
    const agent = await this.resolveExactAgent(input, true);
    await this.options.delivery.restoreConversation(agent, input.sourceMessageId);
  }

  async skip(input: ExactRoomDeliveryControlInput): Promise<void> {
    if (!this.options.delivery) throw new Error("This supervisor cannot skip room delivery.");
    const agent = await this.resolveExactAgent(input, false);
    await this.options.delivery.skipMessage(agent, input.sourceMessageId);
  }

  private async resolveExactAgent(
    input: ExactRoomDeliveryControlInput,
    requireHandle: boolean,
  ): Promise<SupervisedIngressAgent> {
    validateCoordinates(input, "control");
    if (input.daemonGeneration !== this.options.currentGeneration()) {
      throw new Error("The supervisor generation changed; refresh the agent before continuing.");
    }
    const entry = await this.options.getEntry(input.entryId);
    const handle = this.options.getHandle(input.entryId);
    const binding = await this.options.getBinding(input.entryId);
    if (!entry || !binding || (requireHandle && !handle)
      || entry.room_id !== input.roomId
      || entry.desired_state !== "running"
      || entry.delivery_mode !== "daemon_inbox"
      || entry.work_attempt_id !== input.workAttemptId
      || entry.provider_ref?.execution_generation_id !== input.executionGenerationId
      || binding.room_id !== input.roomId
      || binding.work_attempt_id !== input.workAttemptId
      || binding.execution_generation_id !== input.executionGenerationId
      || binding.agent_session_id !== input.agentSessionId
      || (handle && (handle.workAttemptId !== input.workAttemptId
        || handle.providerContinuationId !== entry.provider_ref?.provider_continuation_id))) {
      throw new Error("The room delivery authority is stale; refresh the agent before continuing.");
    }
    const credential = await this.options.credentialFor(binding);
    if (!credential) throw new Error("Waiting for desktop credential handoff before continuing.");
    const agent: SupervisedIngressAgent = {
      agentId: entry.id,
      roomId: binding.room_id,
      provider: entry.provider,
      charter: entry.charter,
      apiUrl: binding.api_url,
      agentSessionId: binding.agent_session_id,
      bearer: credential,
      handle,
      workAttemptId: binding.work_attempt_id,
      providerContinuationId: entry.provider_ref?.provider_continuation_id ?? null,
      providerConnection: entry.provider_ref?.provider_connection ?? null,
      executionGenerationId: binding.execution_generation_id,
      daemonGeneration: this.options.currentGeneration(),
      deliveryMode: entry.delivery_mode ?? "mcp_polling",
    };
    if (!await this.options.isExactAuthority(agent)) {
      throw new Error("The room delivery authority changed; refresh the agent before continuing.");
    }
    return agent;
  }
}

function validateCoordinates(input: ExactRoomDeliveryControlInput, operation: "retry" | "control"): void {
  for (const [field, value] of Object.entries(input)) {
    if ((typeof value === "string" && !value.trim())
      || (field === "daemonGeneration" && !Number.isSafeInteger(value))) {
      throw new Error(`Exact room delivery ${operation} ${field} is required.`);
    }
  }
}
