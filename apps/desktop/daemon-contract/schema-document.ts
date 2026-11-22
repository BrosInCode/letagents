/**
 * Builds the language-neutral JSON Schema Draft 2020-12 contract document for
 * the daemon control socket.
 *
 * Shared wire types are emitted once in `$defs` and referenced via
 * `"$ref": "#/$defs/<Name>"` so a non-TypeScript consumer (such as a future
 * Rust core or schema codegen tool) gets named types without duplication.
 */
import { z } from "zod";
import {
  DAEMON_CONTROL_MAX_REQUEST_BYTES,
  DAEMON_IMPLEMENTATION_VERSION,
  DAEMON_LOCAL_BOARD_MAX_FRAME_BYTES,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RPC_TIMEOUTS,
  DAEMON_STATE_ACTIVITY_SUMMARY_LIMIT,
} from "./version.js";
import {
  DAEMON_RPC_METHOD_NAMES,
  DAEMON_RPC_METHODS,
  type DaemonRpcMethod,
  type RpcTimeoutSpec,
} from "./methods.js";
import {
  canonicalizeJson,
  jsonRecordSchema,
  jsonValueSchema,
  toWireJsonSchema,
  WIRE_JSON_SCHEMA_DRAFT,
} from "./wire-boundary.js";
import {
  agentAvatarSchema,
  daemonActivityEventSchema,
  daemonAgentConfigurationApplyResultSchema,
  daemonAgentConfigurationUpdateResultSchema,
  daemonAgentConfigurationViewSchema,
  daemonAgentStreamEventSchema,
  daemonAsyncRpcAcceptedSchema,
  daemonAsyncRpcEffectKindSchema,
  daemonAttemptDetailSchema,
  daemonBootstrapRoomIngressResultSchema,
  daemonCapabilitiesSchema,
  daemonInspectorDetailSchema,
  daemonInstallHostGrantResultSchema,
  daemonManifestEntrySchema,
  daemonManifestEntryViewSchema,
  daemonProviderConnectionSchema,
  daemonProviderRuntimeReferenceSchema,
  daemonPurgeAgentResultSchema,
  daemonRecoverAgentRuntimeResultSchema,
  daemonRequestEnvelopeSchema,
  daemonResponseEnvelopeSchema,
  daemonRetireAgentResultSchema,
  daemonRoomMovePhaseSchema,
  daemonRoomMoveRecordSchema,
  daemonRpcEffectStateSchema,
  daemonRpcEffectViewSchema,
  daemonStateWatchChangesSchema,
  daemonStateWatchResultSchema,
  daemonStateWatchSnapshotSchema,
  daemonStatusSchema,
  daemonTurnControlEffectSchema,
  daemonTurnControlResultSchema,
  daemonWorkerBindingProjectionSchema,
  deliveryAttentionSchema,
  deliveryReceiptSchema,
  desiredStateSchema,
  executionGenerationSchema,
  executionTerminalPayloadSchema,
  hostApprovalCandidateSchema,
  hostApprovalChallengeSchema,
  hostApprovalReferenceSchema,
  hostApprovalStatusSchema,
  hostToolRuleSchema,
  hostToolScopeSchema,
  launchProgressViewSchema,
  nativeRuntimeDeathSchema,
  observedStateSchema,
  policyConditionSchema,
  projectHostToolScopeSchema,
  reconciliationNoticeSchema,
  reconciliationStateSchema,
  retiredRuntimeEvidenceSchema,
  roomAgentStateSchema,
  roomWorkspaceHostToolScopeSchema,
  runningBackgroundCommandSchema,
  signedHostApprovalRequestSchema,
  supervisedPermissionProfileSchema,
  workAttemptCheckpointSchema,
  hostApprovalOperationSchemas,
  type DaemonAsyncRpcEffectKind,
  type HostApprovalSignedOperation,
} from "./wire-types.js";

export interface DaemonRpcMethodSchemaEntry {
  readonly timeout: RpcTimeoutSpec;
  readonly handoffLifecycle: boolean;
  readonly handoffDrainAllowed: boolean;
  readonly versionAgnostic: boolean;
  readonly requiresLiveConnection: boolean;
  readonly maxRequestBytes: number;
  readonly params: Record<string, unknown>;
  readonly result: Record<string, unknown>;
  readonly asyncEffect?: {
    readonly kind: DaemonAsyncRpcEffectKind;
    readonly outcome: Record<string, unknown>;
  };
}

export interface DaemonRpcContractDocument {
  readonly $schema: typeof WIRE_JSON_SCHEMA_DRAFT;
  readonly $id: string;
  readonly title: string;
  readonly description: string;
  readonly contract: {
    readonly protocolVersion: number;
    readonly implementationVersion: string;
    readonly stateActivitySummaryLimit: number;
    readonly defaultMaxRequestBytes: number;
    readonly localBoardMaxFrameBytes: number;
    readonly timeouts: typeof DAEMON_RPC_TIMEOUTS;
  };
  readonly envelope: {
    readonly request: Record<string, unknown>;
    readonly response: Record<string, unknown>;
  };
  readonly hostApprovalOperations: Record<
    HostApprovalSignedOperation,
    {
      readonly input: Record<string, unknown>;
      readonly result: Record<string, unknown>;
    }
  >;
  readonly methods: Record<DaemonRpcMethod, DaemonRpcMethodSchemaEntry>;
  readonly $defs: Record<string, Record<string, unknown>>;
}

function createWireTypeRegistry() {
  const registry = z.registry<{ id: string }>();
  const named: ReadonlyArray<readonly [string, z.ZodType]> = [
    ["AgentAvatar", agentAvatarSchema],
    ["DaemonActivityEvent", daemonActivityEventSchema],
    ["DaemonAgentConfigurationApplyResult", daemonAgentConfigurationApplyResultSchema],
    ["DaemonAgentConfigurationUpdateResult", daemonAgentConfigurationUpdateResultSchema],
    ["DaemonAgentConfigurationView", daemonAgentConfigurationViewSchema],
    ["DaemonAgentStreamEvent", daemonAgentStreamEventSchema],
    ["DaemonAsyncRpcAccepted", daemonAsyncRpcAcceptedSchema],
    ["DaemonAsyncRpcEffectKind", daemonAsyncRpcEffectKindSchema],
    ["DaemonAttemptDetail", daemonAttemptDetailSchema],
    ["DaemonBootstrapRoomIngressResult", daemonBootstrapRoomIngressResultSchema],
    ["DaemonCapabilities", daemonCapabilitiesSchema],
    ["DaemonInspectorDetail", daemonInspectorDetailSchema],
    ["DaemonInstallHostGrantResult", daemonInstallHostGrantResultSchema],
    ["DaemonManifestEntry", daemonManifestEntrySchema],
    ["DaemonManifestEntryView", daemonManifestEntryViewSchema],
    ["DaemonProviderConnection", daemonProviderConnectionSchema],
    ["DaemonProviderRuntimeReference", daemonProviderRuntimeReferenceSchema],
    ["DaemonPurgeAgentResult", daemonPurgeAgentResultSchema],
    ["DaemonRecoverAgentRuntimeResult", daemonRecoverAgentRuntimeResultSchema],
    ["DaemonRequestEnvelope", daemonRequestEnvelopeSchema],
    ["DaemonResponseEnvelope", daemonResponseEnvelopeSchema],
    ["DaemonRetireAgentResult", daemonRetireAgentResultSchema],
    ["DaemonRoomMovePhase", daemonRoomMovePhaseSchema],
    ["DaemonRoomMoveRecord", daemonRoomMoveRecordSchema],
    ["DaemonRpcEffectState", daemonRpcEffectStateSchema],
    ["DaemonRpcEffectView", daemonRpcEffectViewSchema],
    ["DaemonStateWatchChanges", daemonStateWatchChangesSchema],
    ["DaemonStateWatchResult", daemonStateWatchResultSchema],
    ["DaemonStateWatchSnapshot", daemonStateWatchSnapshotSchema],
    ["DaemonStatus", daemonStatusSchema],
    ["DaemonTurnControlEffect", daemonTurnControlEffectSchema],
    ["DaemonTurnControlResult", daemonTurnControlResultSchema],
    ["DaemonWorkerBindingProjection", daemonWorkerBindingProjectionSchema],
    ["DeliveryAttention", deliveryAttentionSchema],
    ["DeliveryReceipt", deliveryReceiptSchema],
    ["DesiredState", desiredStateSchema],
    ["ExecutionGeneration", executionGenerationSchema],
    ["ExecutionTerminalPayload", executionTerminalPayloadSchema],
    ["HostApprovalCandidate", hostApprovalCandidateSchema],
    ["HostApprovalChallenge", hostApprovalChallengeSchema],
    ["HostApprovalReference", hostApprovalReferenceSchema],
    ["HostApprovalStatus", hostApprovalStatusSchema],
    ["HostToolRule", hostToolRuleSchema],
    ["HostToolScope", hostToolScopeSchema],
    ["JsonRecord", jsonRecordSchema],
    ["JsonValue", jsonValueSchema],
    ["LaunchProgressView", launchProgressViewSchema],
    ["NativeRuntimeDeath", nativeRuntimeDeathSchema],
    ["ObservedState", observedStateSchema],
    ["PolicyCondition", policyConditionSchema],
    ["ProjectHostToolScope", projectHostToolScopeSchema],
    ["ReconciliationNotice", reconciliationNoticeSchema],
    ["ReconciliationState", reconciliationStateSchema],
    ["RetiredRuntimeEvidence", retiredRuntimeEvidenceSchema],
    ["RoomAgentState", roomAgentStateSchema],
    ["RoomWorkspaceHostToolScope", roomWorkspaceHostToolScopeSchema],
    ["RunningBackgroundCommand", runningBackgroundCommandSchema],
    ["SignedHostApprovalRequest", signedHostApprovalRequestSchema],
    ["SupervisedPermissionProfile", supervisedPermissionProfileSchema],
    ["WorkAttemptCheckpoint", workAttemptCheckpointSchema],
  ];
  for (const [id, schema] of named) {
    registry.add(schema, { id });
  }
  return registry;
}

export function buildDaemonRpcContractDocument(): DaemonRpcContractDocument {
  const registry = createWireTypeRegistry();

  // Compile every envelope, host-approval operation, and RPC method inside one
  // root object so Zod emits every shared schema once under `$defs` and uses
  // `#/$defs/<Name>` references everywhere else.
  const methodShapes: Record<string, z.ZodType> = {};
  for (const method of DAEMON_RPC_METHOD_NAMES) {
    const spec = DAEMON_RPC_METHODS[method];
    methodShapes[method] = z.object({
      params: spec.params,
      result: spec.result,
      ...(spec.asyncEffect ? { outcome: spec.asyncEffect.outcome } : {}),
    });
  }

  const hostOpNames = (Object.keys(hostApprovalOperationSchemas) as HostApprovalSignedOperation[]).sort();
  const hostOpShapes: Record<string, z.ZodType> = {};
  for (const opName of hostOpNames) {
    const op = hostApprovalOperationSchemas[opName];
    hostOpShapes[opName] = z.object({
      input: op.input,
      result: op.result,
    });
  }

  const combined = toWireJsonSchema(
    z.object({
      envelope: z.object({
        request: daemonRequestEnvelopeSchema,
        response: daemonResponseEnvelopeSchema,
      }),
      hostApprovalOperations: z.object(hostOpShapes),
      methods: z.object(methodShapes),
    }),
    registry,
  );

  const rootProps = combined.properties as Record<string, { properties: Record<string, Record<string, unknown>> }>;
  const rawEnvelope = rootProps.envelope.properties;
  const rawHostOps = rootProps.hostApprovalOperations.properties;
  const rawMethods = rootProps.methods.properties;
  const defs = (combined.$defs ?? {}) as Record<string, Record<string, unknown>>;

  const methods = {} as Record<DaemonRpcMethod, DaemonRpcMethodSchemaEntry>;
  for (const method of DAEMON_RPC_METHOD_NAMES) {
    const spec = DAEMON_RPC_METHODS[method];
    const methodProps = (rawMethods[method].properties ?? {}) as Record<string, Record<string, unknown>>;
    methods[method] = {
      timeout: spec.timeout,
      handoffLifecycle: spec.handoffLifecycle === true,
      handoffDrainAllowed: spec.handoffDrainAllowed === true,
      versionAgnostic: spec.versionAgnostic === true,
      requiresLiveConnection: spec.requiresLiveConnection === true,
      maxRequestBytes: spec.maxRequestBytes ?? DAEMON_CONTROL_MAX_REQUEST_BYTES,
      params: methodProps.params,
      result: methodProps.result,
      ...(spec.asyncEffect
        ? {
            asyncEffect: {
              kind: spec.asyncEffect.kind,
              outcome: methodProps.outcome,
            },
          }
        : {}),
    };
  }

  const hostApprovalOperations = {} as DaemonRpcContractDocument["hostApprovalOperations"];
  for (const opName of hostOpNames) {
    const opProps = (rawHostOps[opName].properties ?? {}) as Record<string, Record<string, unknown>>;
    hostApprovalOperations[opName] = {
      input: opProps.input,
      result: opProps.result,
    };
  }

  return canonicalizeJson({
    $schema: WIRE_JSON_SCHEMA_DRAFT,
    $id: `https://letagents.chat/schemas/daemon-rpc-contract.v${DAEMON_PROTOCOL_VERSION}.schema.json`,
    title: "LetAgents Supervisor Daemon Control Socket RPC Contract",
    description:
      "Language-neutral JSON Schema Draft 2020-12 contract for the LetAgents supervisor daemon NDJSON control socket. Generated from apps/desktop/daemon-contract/methods.ts.",
    contract: {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      implementationVersion: DAEMON_IMPLEMENTATION_VERSION,
      stateActivitySummaryLimit: DAEMON_STATE_ACTIVITY_SUMMARY_LIMIT,
      defaultMaxRequestBytes: DAEMON_CONTROL_MAX_REQUEST_BYTES,
      localBoardMaxFrameBytes: DAEMON_LOCAL_BOARD_MAX_FRAME_BYTES,
      timeouts: DAEMON_RPC_TIMEOUTS,
    },
    envelope: {
      request: rawEnvelope.request,
      response: rawEnvelope.response,
    },
    hostApprovalOperations,
    methods,
    $defs: defs,
  }) as DaemonRpcContractDocument;
}

export function serializeDaemonRpcContractDocument(): string {
  return `${JSON.stringify(buildDaemonRpcContractDocument(), null, 2)}\n`;
}
