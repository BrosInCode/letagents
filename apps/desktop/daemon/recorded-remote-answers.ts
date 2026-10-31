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
