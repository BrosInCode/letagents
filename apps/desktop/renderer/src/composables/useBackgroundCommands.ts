import { computed, inject, onScopeDispose, provide, shallowRef, watch, type ComputedRef, type InjectionKey, type ShallowRef } from "vue";
import type { DesktopBackgroundCommand, DesktopSupervisorManifestEntry } from "../../../electron/ipc-types";
import type { LiveBackgroundCommand } from "../domain/agent-inspector-live";
import { foldAgentStreamEvents } from "../domain/agent-inspector-live";
import { LIVE_BACKGROUND_COMMAND_METHOD } from "../../../../../shared/live-command-output.mjs";
import { desktopIpc } from "../ipc";

/** One of the room's own agents that runs commands in the background now. */
export interface RoomBackgroundAgent {
  entryId: string;
  displayName: string;
  commands: readonly DesktopBackgroundCommand[];
}

export type BackgroundCommandStopOutcome = "stopping" | "not_running" | "failed" | "invalid";

/** Ask the Live tab to open one background command: the strip's Open sets it. */
export type BackgroundCommandReveal = { entryId: string; taskId: string; at: number };

export interface BackgroundCommandsContext {
  /** The room's own agents with running background commands, from their state. */
  agents: ComputedRef<RoomBackgroundAgent[]>;
  stop(entryId: string, taskId: string): Promise<BackgroundCommandStopOutcome>;
  open(entryId: string, taskId: string): void;
  reveal: ShallowRef<BackgroundCommandReveal | null>;
}

const KEY: InjectionKey<BackgroundCommandsContext> = Symbol("background-commands");

/**
 * The background commands of the room's own agents, and the owner's actions on them, for the activity strip
 * and the Live tab. The list comes from each agent's state, which the daemon changes only when a command starts
 * or ends. Stop is a signed request of this app; Open shows the agent's Live tab with the command opened.
 */
export function provideBackgroundCommands(input: {
  entries: () => readonly DesktopSupervisorManifestEntry[];
  roomId: () => string;
  daemonGeneration: () => number | null;
  openInspector: (entry: DesktopSupervisorManifestEntry) => void;
}): BackgroundCommandsContext {
  const reveal = shallowRef<BackgroundCommandReveal | null>(null);
  const agents = computed(() => input.entries()
    .filter((entry) => entry.roomId === input.roomId() && (entry.backgroundCommands?.length ?? 0) > 0)
    .map((entry) => ({ entryId: entry.id, displayName: entry.displayName, commands: entry.backgroundCommands! })));
  const context: BackgroundCommandsContext = {
    agents,
    reveal,
    async stop(entryId, taskId) {
      const generation = input.daemonGeneration();
      const stop = desktopIpc.supervisor?.stopBackgroundCommand;
      if (!generation || !stop) return "failed";
      try {
        const result = await stop({ entryId, daemonGeneration: generation, taskId });
        return result.outcome;
      } catch {
        return "failed";
      }
    },
    open(entryId, taskId) {
      const entry = input.entries().find((candidate) => candidate.id === entryId);
      if (!entry) return;
      reveal.value = { entryId, taskId, at: Date.now() };
      input.openInspector(entry);
    },
  };
  provide(KEY, context);
  return context;
}

export function useBackgroundCommands(): BackgroundCommandsContext | null {
  return inject(KEY, null);
}

/**
 * The live output of background commands, for the agents whose rows are open in the strip. Each agent is read
 * with its own long watch of only its background commands, so this never takes the Live tab's feed. A watch
 * runs only while its agent is in `entryIds`.
 */
export function useBackgroundCommandOutput(entryIds: () => readonly string[]) {
  const outputs = shallowRef(new Map<string, LiveBackgroundCommand[]>());
  const running = new Map<string, { stopped: boolean }>();

  const set = (entryId: string, commands: LiveBackgroundCommand[]) => {
    const next = new Map(outputs.value);
    next.set(entryId, commands);
    outputs.value = next;
  };

  async function follow(entryId: string, loop: { stopped: boolean }): Promise<void> {
    let version = 0;
    let failures = 0;
    // The loop leaves the running set in the same step that ends it, so a row opened again a moment later finds
    // either this loop still going or no loop, never one that is about to end.
    const end = () => { if (running.get(entryId) === loop) running.delete(entryId); };
    for (;;) {
      const watchCommands = desktopIpc.supervisor?.watchBackgroundCommands;
      if (loop.stopped || !watchCommands) { end(); return; }
      try {
        const batch = await watchCommands({ entryId, afterVersion: version });
        if (loop.stopped) { end(); return; }
        failures = 0;
        version = batch.version;
        // The batch holds the payloads of the background command events; the shared fold reads them.
        const events = batch.commands.map((payload, index) => ({
          observedAt: "", kind: "tool_lifecycle", method: LIVE_BACKGROUND_COMMAND_METHOD, summary: null, payload, sequence: index,
        }));
        set(entryId, foldAgentStreamEvents(events, batch.ended).background);
      } catch {
        failures += 1;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 1_000 * 2 ** failures)));
      }
    }
  }

  watch(() => [...entryIds()].sort().join("\n"), () => {
    const wanted = new Set(entryIds());
    for (const [entryId, loop] of running) {
      // A loop that is no longer wanted finishes its request and ends; wanted again before that, it goes on.
      loop.stopped = !wanted.has(entryId);
    }
    for (const entryId of wanted) {
      if (running.has(entryId)) continue;
      const loop = { stopped: false };
      running.set(entryId, loop);
      void follow(entryId, loop);
    }
  }, { immediate: true });

  onScopeDispose(() => {
    for (const loop of running.values()) loop.stopped = true;
    running.clear();
  });

  return {
    output(entryId: string, taskId: string): LiveBackgroundCommand | null {
      return outputs.value.get(entryId)?.find((command) => command.id === taskId) ?? null;
    },
  };
}
