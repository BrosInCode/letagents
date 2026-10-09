import {
  CodexProviderAdapter,
  type CodexProviderAdapterDependencies,
} from "../../main/agents/codex-provider-adapter.js";
import type {
  ProviderActivityEvent,
  ProviderObservedState,
  ProviderRoomTurnRequest,
  ProviderRoomTurnResult,
  ProviderSpawnRequest,
  ProviderStreamEvent,
  ProviderTerminalPayload,
} from "../../main/agents/provider-adapter.js";
import type { NativeExecutionObservation } from "../../../shared/execution-protocol.js";

/**
 * The Codex scenarios that have a recording. One function drives the real
 * adapter for each scenario, and both sides call it: the recorder against a
 * real app-server, and the replay test against the recording. That is what
 * makes the frames the adapter sends in a test the frames that were recorded.
 */
export interface CodexScenarioEnvironment {
  /** The recorder's tapped real dependencies, or the replay's. */
  dependencies: Partial<CodexProviderAdapterDependencies>;
  codexBin: string;
  workspace: string;
  /** Recorder only: how the app-server is launched. It never reaches a frame. */
  launch?: Pick<ProviderSpawnRequest, "devMcpServerEntryPath">;
  /** Resolves when the provider has nothing more to send until it is stopped. */
  settled(): Promise<void>;
  /** Told of each stream event at the moment the adapter publishes it. */
  onStream?(event: ProviderStreamEvent): void;
}

/** Everything the adapter showed its caller during one scenario. */
export interface CodexScenarioOutcome {
  threadId: string;
  stateAfterSpawn: ProviderObservedState;
  roomTurn: ProviderRoomTurnResult;
  /** What `controlExactTurn` returned, in a scenario that interrupts. */
  interrupt: { outcome: "no_active" | "terminal" | "interrupt_dispatched"; targetTurnId: string | null } | null;
  stateAfterTurn: ProviderObservedState;
  terminal: ProviderTerminalPayload;
  stateAfterStop: ProviderObservedState;
  stream: ProviderStreamEvent[];
  activity: ProviderActivityEvent[];
  execution: NativeExecutionObservation[];
}

export interface CodexScenario {
  name: string;
  description: string;
  /** The room message the agent answers. Recordings use trivial prompts only. */
  message: string;
  /** Stop the turn when the first piece of the answer arrives. */
  interruptAtFirstAnswerDelta: boolean;
}

export const CODEX_SCENARIOS = {
  simple: {
    name: "simple",
    description: "One room message, one turn that completes with a one-word reply.",
    message: "Reply with the single word: ready",
    interruptAtFirstAnswerDelta: false,
  },
  turn_interrupt: {
    name: "turn_interrupt",
    description: "One room message whose turn is interrupted while the answer is streaming.",
    message: "Count from 1 to 300. Write one number on each line and nothing else.",
    interruptAtFirstAnswerDelta: true,
  },
} as const satisfies Record<string, CodexScenario>;

export type CodexScenarioName = keyof typeof CODEX_SCENARIOS;

const WORK_ATTEMPT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function spawnRequest(environment: CodexScenarioEnvironment): ProviderSpawnRequest {
  return {
    workAttemptId: WORK_ATTEMPT_ID,
    roomId: "replay-room",
    agentDisplayName: "ReplayFinch",
    cwd: environment.workspace,
    // The daemon starts each turn. The spawn starts none, so the agent joins no room.
    deliveryMode: "daemon_inbox",
    // What production pairs with daemon-inbox delivery (daemon/lifecycle-authority-mode.ts).
    lifecycleAuthorityMode: "typed",
    // The tightest policy that still completes a turn: nothing is written and nothing is asked.
    launchPolicy: {
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
    reasoningEffort: "low",
    ...environment.launch,
  };
}

function roomTurnRequest(scenario: CodexScenario): ProviderRoomTurnRequest {
  return {
    inboxItemId: `replay-inbox-${scenario.name}`,
    actionId: `replay-action-${scenario.name}`,
    sourceMessage: { id: "replay-message-1", sender: "replay-owner", text: scenario.message },
    activation: { kind: "mention" },
    observedContext: [],
  };
}

/** The exact prompt part a test may look for in the `turn/start` the adapter sent. */
export function scenarioSourceMessageLine(scenario: CodexScenario): string {
  return `Source message: ${JSON.stringify(roomTurnRequest(scenario).sourceMessage)}`;
}

export async function runCodexScenario(
  scenario: CodexScenario,
  environment: CodexScenarioEnvironment,
): Promise<CodexScenarioOutcome> {
  const stream: ProviderStreamEvent[] = [];
  const activity: ProviderActivityEvent[] = [];
  const execution: NativeExecutionObservation[] = [];
  const adapter = new CodexProviderAdapter({
    codexBin: environment.codexBin,
    dependencies: environment.dependencies,
    streamSink: (event) => {
      stream.push(event);
      environment.onStream?.(event);
    },
    activitySink: (event) => { activity.push(event); },
  });

  const handle = await adapter.spawn(spawnRequest(environment));
  const subscription = adapter.onExecution(handle, (event) => { execution.push(event); });
  try {
    const stateAfterSpawn = handle.observedState();
    const threadId = handle.providerContinuationId ?? "";

    let turnId: string | null = null;
    let interrupting: Promise<CodexScenarioOutcome["interrupt"]> | null = null;
    const stopWatching = scenario.interruptAtFirstAnswerDelta
      ? adapter.onStream(handle, (event) => {
        if (interrupting || event.method !== "item/agentMessage/delta") return;
        // The daemon interrupts from outside the stream, so do not call back into the adapter from its own listener.
        interrupting = Promise.resolve().then(() => adapter.controlExactTurn(handle, {
          targetTurnId: turnId,
          checkpointTargetTurn: async () => {},
          markDispatched: async () => {},
        }));
        // The room turn below reports the outcome; a failed interrupt is reported when it is awaited.
        interrupting.catch(() => undefined);
      })
      : () => {};

    const roomTurn = await adapter.runRoomTurn(handle, roomTurnRequest(scenario), {
      checkpointTurnStarted: async (started) => { turnId = started; },
    });
    stopWatching();
    const interrupt = await (interrupting as Promise<CodexScenarioOutcome["interrupt"]> | null);
    if (scenario.interruptAtFirstAnswerDelta && !interrupt) {
      throw new Error("The turn ended before any piece of the answer arrived, so nothing was interrupted.");
    }
    await environment.settled();
    const stateAfterTurn = handle.observedState();

    const terminal = await adapter.stop(handle);
    return {
      threadId, stateAfterSpawn, roomTurn, interrupt, stateAfterTurn,
      terminal, stateAfterStop: handle.observedState(), stream, activity, execution,
    };
  } catch (error) {
    // A real app-server must not outlive a failed recording.
    await adapter.stop(handle, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    subscription.dispose();
  }
}
