import { formatMessageId } from "../db/utils.js";
import { getRoomHistorySummaryEnabled } from "../db/room-settings.js";
import { messageEvents, type MessageCreatedEvent } from "../server/events.js";
import {
  claimRoomHistoryRooms,
  ingestRoomHistoryMessages,
  nextRoomHistoryWork,
  releaseRoomHistoryRoom,
  roomHistoryHasWork,
  startOrWakeRoomHistory,
  writeRoomHistoryLine as storeRoomHistoryLine,
  type RoomHistoryClaim,
  type RoomHistoryWork,
} from "./store.js";
import {
  RoomHistorySummarizerError,
  readRoomHistorySummarizer,
  writeRoomHistoryLine,
  type RoomHistorySummarizerConfig,
  type RoomHistoryTask,
} from "./summarizer.js";

/** Rooms one turn takes, lines one room gets per turn, and calls in flight per room. */
const ROOMS_PER_TURN = 2;
const LINES_PER_TURN = 16;
const CALLS_AT_ONCE = 4;
/** With no wake, due rooms (retries, lost wakes) are looked for this often. */
const SWEEP_MS = 30_000;

function taskFor(work: RoomHistoryWork): RoomHistoryTask | string {
  if (work.kind === "merge") {
    return { kind: "merge", firstMessageId: formatMessageId(work.firstNumber), lastMessageId: formatMessageId(work.lastNumber),
      left: work.left, right: work.right };
  }
  // The message is gone (it cannot be today; messages are never deleted once visible).
  if (!work.message) return "(message unavailable)";
  return { kind: "message", messageId: formatMessageId(work.message.number), sender: work.message.sender,
    timestamp: work.message.timestamp, text: work.message.text,
    threadRootId: work.message.thread_root_number === null ? null : formatMessageId(work.message.thread_root_number) };
}

export interface RoomHistoryWorkerDeps {
  config: RoomHistorySummarizerConfig;
  write?: typeof writeRoomHistoryLine;
  isEnabled?: (roomId: string) => Promise<boolean>;
}

/**
 * One turn for one claimed room: read new messages in, write up to
 * LINES_PER_TURN waiting lines, then release the room. A summarizer failure
 * stops the turn; the room waits and the lines are asked again later.
 */
export async function runRoomHistoryTurn(claim: RoomHistoryClaim, deps: RoomHistoryWorkerDeps): Promise<void> {
  const write = deps.write ?? writeRoomHistoryLine;
  try {
    if (!await (deps.isEnabled ?? getRoomHistorySummaryEnabled)(claim.roomId)) {
      await releaseRoomHistoryRoom(claim, { kind: "idle" });
      return;
    }
    await ingestRoomHistoryMessages(claim);
    const work = await nextRoomHistoryWork(claim.roomId, LINES_PER_TURN);
    for (let start = 0; start < work.length; start += CALLS_AT_ONCE) {
      const results = await Promise.allSettled(work.slice(start, start + CALLS_AT_ONCE).map(async (item) => {
        const task = taskFor(item);
        const line = typeof task === "string" ? task : await write(deps.config, task);
        if (!await storeRoomHistoryLine(claim, item.level, item.idx, line)) throw new Error("lease lost");
      }));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) {
        const error = failed.reason;
        if (error instanceof Error && error.message === "lease lost") return;
        await releaseRoomHistoryRoom(claim, { kind: "failed",
          error: error instanceof RoomHistorySummarizerError ? error.message : "The summary could not be saved.",
          auth: error instanceof RoomHistorySummarizerError && error.kind === "auth" });
        if (!(error instanceof RoomHistorySummarizerError)) console.error("[room history] turn failed", claim.roomId, error);
        return;
      }
    }
    await releaseRoomHistoryRoom(claim, { kind: await roomHistoryHasWork(claim.roomId) ? "more" : "idle" });
  } catch (error) {
    console.error("[room history] turn failed", claim.roomId, error);
    await releaseRoomHistoryRoom(claim, { kind: "failed", error: "The summary could not be saved.", auth: false })
      .catch(() => undefined);
  }
}

/**
 * Writes room history summaries in the background. A new message starts or
 * wakes its room; a sweep every SWEEP_MS picks up retries and lost wakes.
 * Without a summarizer key it does nothing, and rooms are never started.
 */
export function startRoomHistoryWorker(deps: Partial<RoomHistoryWorkerDeps> = {}): () => Promise<void> {
  const configured = deps.config ?? readRoomHistorySummarizer();
  if (!configured) return async () => {};
  const config: RoomHistorySummarizerConfig = configured;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | null = null;
  let wokenWhileRunning = false;

  const schedule = (ms: number) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { running = turn(); }, ms);
    (timer as { unref?: () => void }).unref?.();
  };
  async function turn(): Promise<void> {
    let busy = false;
    try {
      const claims = await claimRoomHistoryRooms(ROOMS_PER_TURN);
      busy = claims.length === ROOMS_PER_TURN;
      await Promise.all(claims.map((claim) => runRoomHistoryTurn(claim, { ...deps, config })));
      busy ||= claims.length > 0;
    } catch (error) {
      console.error("[room history] queue unavailable", error);
    } finally {
      running = null;
      const again = busy || wokenWhileRunning;
      wokenWhileRunning = false;
      schedule(again ? 0 : SWEEP_MS);
    }
  }
  const wake = () => { if (running) wokenWhileRunning = true; else schedule(0); };

  const onMessage = (event: MessageCreatedEvent) => {
    void startOrWakeRoomHistory(event.projectId).then(wake, (error: unknown) => {
      console.error("[room history] wake failed", event.projectId, error);
    });
  };
  messageEvents.on("message:created", onMessage);
  schedule(0);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    messageEvents.off("message:created", onMessage);
    await running;
  };
}
