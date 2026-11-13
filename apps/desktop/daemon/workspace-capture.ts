import { Worker } from "node:worker_threads";
import { RoomLatencyTrace } from "./room-latency-trace.js";
import { releaseWorkspaceTree, settledWorkspacePair, type captureSettledWorkspace, type compareSettledTurn, type captureWorkspaceTree, type captureWorkspacePair } from "../../../shared/workspace-turn-capture.mjs";

/** One short-lived capture worker per publisher; never one per agent at once.
 * File IO must not yield thousands of times to the daemon's synchronous stores.
 * A queued capture still finishes before its caller may dispatch or ACK a turn.
 * So nothing in the queue may wait for a remote: the queue is one for all agents,
 * and another agent's turn does not start before its own starting capture.
 */
export class WorkspaceCapture {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private worker: Worker | null = null;
  private pending = 0;

  begin(...args: Parameters<typeof captureWorkspaceTree>): ReturnType<typeof captureWorkspaceTree> {
    return this.run("begin", args);
  }

  /**
   * Two captures in the queue, and between them, outside the queue, the wait for what
   * the remote held when the turn began (`remoteTips`, the answer or the pending question):
   * 1. The settled files are pinned and compared with the workspace's start. A turn
   *    that did not move HEAD is complete here.
   * 2. A turn that moved HEAD waits for the answer. Its settled files stay pinned, and
   *    other captures run meanwhile.
   * 3. The turn's own changes are compared, with the answer.
   */
  async settle(...args: Parameters<typeof captureWorkspacePair>): ReturnType<typeof captureWorkspacePair> {
    const [workspace, startingRevision, baseline, identity, startingHead = null, remoteTips = null] = args;
    // A question that fails in any way is no answer, also while nothing waits for it yet.
    const answer = Promise.resolve(remoteTips).catch(() => null);
    const settled = await this.run<Awaited<ReturnType<typeof captureSettledWorkspace>>>("settle", [workspace, startingRevision, baseline, identity, startingHead]);
    if (settled.pair) return settled.pair;
    try {
      const tips = await answer;
      const changes = await this.run<Awaited<ReturnType<typeof compareSettledTurn>>>("compare",
        [workspace, startingRevision, baseline, identity, startingHead, { tree: settled.pending.tree, head: settled.pending.head }, tips ? [...tips] : null]);
      return settledWorkspacePair(settled.pending.full, changes);
    } catch (error) {
      // The comparison did not run (closed, or the queue was busy), so it did not release the settled files.
      await releaseWorkspaceTree(workspace, `${identity}:settled`);
      if (this.closed) await releaseWorkspaceTree(workspace, identity);
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    // Let the bounded Git calls finish their cleanup. Terminating a thread in
    // the middle of a child process would abandon its scratch index and refs.
  }

  private run<T>(operation: "begin" | "settle" | "compare", args: unknown[]): Promise<T> {
    if (this.closed || this.pending >= 8) return Promise.reject(new Error("Workspace capture is unavailable."));
    const timing = new RoomLatencyTrace(operation === "begin" ? "workspace_begin" : "workspace_settle");
    this.pending++;
    let expired = false;
    let queueTimer: NodeJS.Timeout;
    const queueDeadline = new Promise<never>((_resolve, reject) => {
      queueTimer = setTimeout(() => {
        expired = true;
        timing.mark("queue_wait");
        timing.finish();
        reject(new Error("Workspace capture queue is busy."));
      }, 30_000);
    });
    const result = this.tail.then(async () => {
      clearTimeout(queueTimer);
      timing.mark("queue_wait");
      if (this.closed || expired) throw new Error("Workspace capture is closed or expired.");
      const worker = new Worker(new URL("../../../shared/workspace-turn-capture-worker.mjs", import.meta.url), {
        execArgv: [], workerData: { operation, args },
      });
      this.worker = worker;
      try {
        return await new Promise<T>((resolve, reject) => {
          worker.once("message", message => { message.error ? reject(new Error(message.error)) : resolve(message.result); });
          worker.once("error", reject);
          worker.once("exit", () => reject(new Error("Workspace capture stopped before completion.")));
        });
      } finally {
        timing.mark("worker");
        await worker.terminate();
        if (this.worker === worker) this.worker = null;
        if (this.closed) await releaseWorkspaceTree(String(args[0]), String(args[operation === "begin" ? 1 : 3]));
        timing.mark("cleanup");
      }
    }).finally(() => { this.pending--; clearTimeout(queueTimer); timing.finish(); });
    this.tail = result.catch(() => undefined);
    return Promise.race([result, queueDeadline]);
  }
}
