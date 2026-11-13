import { performance } from "node:perf_hooks";

/**
 * What each recorded remote held, as last answered, for every agent and turn of
 * this daemon. A turn asks the remote when it begins, so that it knows a base
 * that landed a moment ago. Only turns that begin within a minute of an answer
 * reuse it: agents that start together, or one after the other, ask once. An
 * older answer would still be sound, because its branch tips existed before the
 * turn. But it does not know what landed since, and a turn that merges that
 * would be charged with it.
 */

/** A completed answer serves the turns that begin while it is younger than this. A turn that begins later asks. */
export const REMOTE_ANSWER_USE_MS = 60_000;
/** A remote that did not answer is not asked again for this long. */
export const REMOTE_FAILURE_PAUSE_MS = 5 * 60_000;
/** Remotes remembered. The one that was used longest ago is forgotten first. */
export const REMOTE_ANSWERS_KEPT = 32;

/** One question that got no answer. It carries no room content. The reason can name the remote; the log takes credentials out of it. */
export type RemoteUnansweredSample = {
  /** Why there is no answer, as the question gave it. */
  reason: string;
  /** From the question to its end. */
  elapsed_ms: number;
  /** The turns that begin in this time do not ask: they are compared plainly, with no event of their own. */
  pause_ms: number;
};

let reportUnanswered: ((sample: RemoteUnansweredSample) => void) | null = null;

/** The packaged daemon has no stderr; its entrypoint supplies the local log. */
export function setRemoteUnansweredReporter(report: ((sample: RemoteUnansweredSample) => void) | null): void {
  reportUnanswered = report;
}

/**
 * One question to a recorded remote. `ask` gives the answer, or null and the reason through
 * its second argument. A question without an answer is reported once, with its reason and how
 * long it took: the turns that depend on it are compared plainly, and a card that counts a
 * whole base update needs a record of why. `warn` gets the reason too, when one was given.
 * Nothing here can fail the question or change its answer.
 */
export async function askRecordedRemote(remote: string, ask: (remote: string, onNoAnswer: (reason: string) => void) => Promise<string[] | null>,
  options: { clock?: () => number; warn?: (reason: string) => void } = {}): Promise<string[] | null> {
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  let reason = "";
  let tips: string[] | null = null;
  try { tips = await ask(remote, (given) => { reason = given; }); }
  catch (error) { reason = (error instanceof Error ? error.message : String(error)).split("\n")[0]; }
  if (tips) return tips;
  try { if (reason) options.warn?.(reason); } catch { /* optional diagnostics */ }
  try {
    reportUnanswered?.({ reason: reason || "the question gave no reason", elapsed_ms: Math.max(0, Math.round(clock() - started)), pause_ms: REMOTE_FAILURE_PAUSE_MS });
  } catch { /* optional diagnostics */ }
  return null;
}

type Remote = {
  answer: { tips: string[]; at: number } | null;
  failedAt: number | null;
  question: Promise<string[] | null> | null;
};

export class RecordedRemoteAnswers {
  private readonly remotes = new Map<string, Remote>();

  /** `ask` asks exactly the remote it is given. An answer is kept under that address and under no other. */
  constructor(private readonly ask: (remote: string) => Promise<string[] | null>, private readonly now: () => number) {}

  /**
   * The answer for a turn that begins now. The turn keeps what it gets here: what the
   * remote says later, when the turn has pushed its own commits, is not for this turn.
   * 1. A completed answer younger than REMOTE_ANSWER_USE_MS: that answer. It was complete
   *    before the turn, so nothing the turn does can be in it.
   * 2. Otherwise, while the remote is paused after a failure: none.
   * 3. Otherwise the question that is in flight for this remote, or a new one. Here the
   *    answer can arrive after the turn has started.
   */
  forTurn(remote: string): Promise<string[] | null> {
    const now = this.now();
    const kept = this.remotes.get(remote) ?? { answer: null, failedAt: null, question: null };
    this.remotes.delete(remote);
    this.remotes.set(remote, kept);
    while (this.remotes.size > REMOTE_ANSWERS_KEPT) this.remotes.delete(this.remotes.keys().next().value!);
    if (kept.answer && now - kept.answer.at < REMOTE_ANSWER_USE_MS) return Promise.resolve(kept.answer.tips);
    if (kept.failedAt !== null && now - kept.failedAt < REMOTE_FAILURE_PAUSE_MS) return Promise.resolve(null);
    kept.question ??= this.ask(remote).then((tips) => tips, () => null).then((tips) => {
      kept.question = null;
      if (tips) kept.answer = { tips, at: this.now() };
      else kept.failedAt = this.now();
      return tips;
    });
    return kept.question;
  }

  clear(): void { this.remotes.clear(); }
}
