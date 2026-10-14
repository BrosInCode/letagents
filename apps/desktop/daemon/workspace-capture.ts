import { Worker } from "node:worker_threads";
import { releaseWorkspaceTree, type captureWorkspaceTree, type captureWorkspacePair } from "../../../shared/workspace-turn-capture.mjs";

/** One short-lived capture worker per publisher; never one per agent at once.
 * File IO must not yield thousands of times to the daemon's synchronous stores.
 * A queued capture still finishes before its caller may dispatch or ACK a turn.
 */
export class WorkspaceCapture {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private worker: Worker | null = null;
  private pending = 0;

  begin(...args: Parameters<typeof captureWorkspaceTree>): ReturnType<typeof captureWorkspaceTree> {
    return this.run("begin", args);
  }

  settle(...args: Parameters<typeof captureWorkspacePair>): ReturnType<typeof captureWorkspacePair> {
    return this.run("settle", [args[0], args[1], args[2], args[3], args[4] ?? null], args[5]);
  }

  close(): void {
    this.closed = true;
    // Let the bounded Git calls finish their cleanup. Terminating a thread in
    // the middle of a child process would abandon its scratch index and refs.
  }

  private run<T>(operation: "begin" | "settle", args: unknown[], remoteTips?: Parameters<typeof captureWorkspacePair>[5]): Promise<T> {
    if (this.closed || this.pending >= 8) return Promise.reject(new Error("Workspace capture is unavailable."));
    this.pending++;
    let expired = false;
    let queueTimer: NodeJS.Timeout;
    const queueDeadline = new Promise<never>((_resolve, reject) => {
      queueTimer = setTimeout(() => { expired = true; reject(new Error("Workspace capture queue is busy.")); }, 30_000);
    });
    const result = this.tail.then(async () => {
      clearTimeout(queueTimer);
      if (this.closed || expired) throw new Error("Workspace capture is closed or expired.");
      const worker = new Worker(new URL("../../../shared/workspace-turn-capture-worker.mjs", import.meta.url), {
        execArgv: [], workerData: { operation, args },
      });
      this.worker = worker;
      // The original capture pins settled bytes BEFORE awaiting this answer.
      // Keep that ordering even when the remote is slow or unavailable.
      if (operation === "settle") void Promise.resolve(remoteTips).catch(() => null).then(tips => {
        if (this.worker === worker) worker.postMessage(tips ?? null);
      });
      try {
        return await new Promise<T>((resolve, reject) => {
          worker.once("message", message => { message.error ? reject(new Error(message.error)) : resolve(message.result); });
          worker.once("error", reject);
          worker.once("exit", () => reject(new Error("Workspace capture stopped before completion.")));
        });
      } finally {
        await worker.terminate();
        if (this.worker === worker) this.worker = null;
        if (this.closed) await releaseWorkspaceTree(String(args[0]), String(args[operation === "begin" ? 1 : 3]));
      }
    }).finally(() => { this.pending--; clearTimeout(queueTimer); });
    this.tail = result.catch(() => undefined);
    return Promise.race([result, queueDeadline]);
  }
}
