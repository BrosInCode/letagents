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
  /** Told once the agent is spawned. `observedState` reads the state the adapter shows its caller at that moment. */
  onSpawned?(observedState: () => ProviderObservedState): void;
  /**
   * The conversation that a resume scenario continues. An earlier process
   * started it. The recorder runs that process itself and does not record its
   * traffic; a replay reads the id from the recording.
   */
  resumeThreadId?: string;
}

/** Everything the adapter showed its caller during one scenario. */
export interface CodexScenarioOutcome {
  threadId: string;
  stateAfterSpawn: ProviderObservedState;
  /** The owner-visible lines of the launch. */
  launchNotices: readonly string[];
  roomTurn: ProviderRoomTurnResult;
  /** What `controlExactTurn` returned, in a scenario that interrupts. */
  interrupt: { outcome: "no_active" | "terminal" | "interrupt_dispatched"; targetTurnId: string | null } | null;
  /** What `repairContinuation` returned for the conversation while the process had it loaded, in a scenario that resumes. */
  loadedResume: { outcome: "rematerialized" | "replaced"; notices: readonly string[] } | null;
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
  /**
   * The agent's process is a second one. It resumes a conversation that an
   * earlier process started with CODEX_SCENARIO_REASONING_EFFORT, and it names
   * `reasoningEffort` for it. Then, with the conversation loaded, the adapter
   * is asked to restore it under `loadedReasoningEffort`: it sends the resume
   * that a continuation repair sends first.
   *
   * `reasoningEffort` must be an effort that Codex can report for one reason
   * only, that the resume named it. So it is not the effort of the earlier
   * process, not the default effort of the conversation's model, and not the
   * effort of the recording owner's own settings. The replay test checks the
   * first two on the recording. `loadedReasoningEffort` is another effort
   * again, so the reply shows whether the loaded conversation took it.
   */
  resume?: { reasoningEffort: ScenarioEffort; loadedReasoningEffort: ScenarioEffort };
}

type ScenarioEffort = NonNullable<ProviderSpawnRequest["reasoningEffort"]>;

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
  resume: {
    name: "resume",
    description: "A second process resumes a conversation with another reasoning effort, resumes it once more while it is loaded, and completes one turn.",
    // Another word than the earlier process's turn answered, so the answer of this turn is not the earlier one.
    message: "Reply with the single word: resumed",
    interruptAtFirstAnswerDelta: false,
    resume: { reasoningEffort: "high", loadedReasoningEffort: "medium" },
  },
} as const satisfies Record<string, CodexScenario>;

export type CodexScenarioName = keyof typeof CODEX_SCENARIOS;

const WORK_ATTEMPT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/**
 * The reasoning effort every scenario's agent is given. It is not the effort
 * of the recording owner's Codex settings, so a recording shows whether Codex
 * took it.
 */
export const CODEX_SCENARIO_REASONING_EFFORT = "low";

/** The scenario whose process starts the conversation that a resume scenario continues. */
export const CODEX_RESUMED_SCENARIO = "simple";

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
    // It is the Read-only level's policy, and the scenarios were recorded before that level named a permission
    // profile, with no level named. The product's launch now starts no Codex this way, so the recorder cannot
    // run these scenarios as they are. Recording `simple`, `resume` or `turn_interrupt` again means naming the
    // level here (`permissionProfileId: "read_only"`, `configurationRevision: 1`) and recording all three,
    // because their frames then name the profile in place of the sandbox.
    launchPolicy: {
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
    reasoningEffort: CODEX_SCENARIO_REASONING_EFFORT,
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

  const request = spawnRequest(environment);
  if (scenario.resume && !environment.resumeThreadId) {
    throw new Error(`Scenario ${scenario.name} continues a conversation, and none was given.`);
  }
  const handle = scenario.resume
    ? await adapter.resume(
      { workAttemptId: WORK_ATTEMPT_ID, providerContinuationId: environment.resumeThreadId! },
      { ...request, reasoningEffort: scenario.resume.reasoningEffort },
    )
    : await adapter.spawn(request);
  environment.onSpawned?.(() => handle.observedState());
  const subscription = adapter.onExecution(handle, (event) => { execution.push(event); });
  try {
    const stateAfterSpawn = handle.observedState();
    const launchNotices = [...(handle.launchNotices ?? [])];
    const threadId = handle.providerContinuationId ?? "";

    let loadedResume: CodexScenarioOutcome["loadedResume"] = null;
    if (scenario.resume) {
      // The resume that a continuation repair sends first. Here the process has the conversation
      // loaded. A repair in production follows a conversation that Codex did not find.
      const restored = await adapter.repairContinuation(handle, {
        workAttemptId: WORK_ATTEMPT_ID,
        expectedProviderContinuationId: threadId,
        cwd: environment.workspace,
        launchPolicy: request.launchPolicy,
        reasoningEffort: scenario.resume.loadedReasoningEffort,
      }, {
        checkpointReplacement: async () => {
          throw new Error("The loaded conversation was not found, so there is no resume of it to record.");
        },
      });
      loadedResume = { outcome: restored.outcome, notices: [...(restored.notices ?? [])] };
      // The daemon records the lines, then tells the adapter that they are recorded.
      restored.noticesRecorded?.();
    }

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
      threadId, stateAfterSpawn, launchNotices, loadedResume, roomTurn, interrupt, stateAfterTurn,
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
