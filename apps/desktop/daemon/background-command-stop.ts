import type { ProviderActionHandle } from "./provider-action-port.js";

export type BackgroundCommandStopResult =
  | { outcome: "stopping" | "not_running" | "failed" }
  | { outcome: "invalid"; error: string };

export type BackgroundCommandStopPorts = {
  currentDaemonGeneration(): number;
  /** The agent's current provider process, while it has one. */
  liveHandle(entryId: string): ProviderActionHandle | undefined;
  /** The agent runs this command in the background now, as its live feed knows it. */
  isRunning(entryId: string, taskId: string): boolean;
  stop?(handle: ProviderActionHandle, taskId: string): Promise<"stopping" | "not_running" | "failed">;
  /** The live feed reads the command's end as stopped while this is marked (some ends carry no sign of a stop). */
  markStopRequested?(entryId: string, taskId: string, requested: boolean): void;
};

/**
 * The owner's Stop for a command that an agent runs in the background.
 * 1. Only the desktop app's signed request reaches this (see the router), so
 *    no agent or other local caller can stop an agent's command.
 * 2. The request names the current daemon generation and a command that the
 *    agent's live feed shows as running; anything else changes nothing.
 * 3. The agent's current provider process is asked to stop exactly that
 *    command. "stopping" means the provider accepted it: the command's end
 *    then arrives on the live feed like any other end.
 * 4. The live feed knows of the Stop before the provider is asked, because
 *    the end can arrive before the provider's answer. Without "stopping",
 *    the mark is taken back.
 */
export async function stopBackgroundCommand(
  input: { entryId: string; daemonGeneration: number; taskId: string },
  ports: BackgroundCommandStopPorts,
): Promise<BackgroundCommandStopResult> {
  if (input.daemonGeneration !== ports.currentDaemonGeneration()) {
    return { outcome: "invalid", error: "The background service restarted. Try again." };
  }
  if (!ports.isRunning(input.entryId, input.taskId)) return { outcome: "not_running" };
  const handle = ports.liveHandle(input.entryId);
  if (!handle || !ports.stop) return { outcome: "not_running" };
  ports.markStopRequested?.(input.entryId, input.taskId, true);
  let outcome: "stopping" | "not_running" | "failed" = "failed";
  try {
    outcome = await ports.stop(handle, input.taskId);
  } catch {
    outcome = "failed";
  }
  if (outcome !== "stopping") ports.markStopRequested?.(input.entryId, input.taskId, false);
  return { outcome };
}
