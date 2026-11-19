import { boundEditPatch, type AgentEditEvidence } from "../../../shared/agent-edit-evidence.mjs";
import { ROOM_CONTRIBUTION_EDIT_LIMITS, type RoomContributionEditFile, type RoomContributionEdits } from "../../../shared/room-agent-work.mjs";

/** Providers whose stream reports each edit call. Any other provider's turn has no edit evidence (v3 card). */
export const EDIT_REPORTING_PROVIDERS: ReadonlySet<string> = new Set(["claude-code", "codex"]);
/** A bound on the paths remembered only to be counted; one more beyond it still counts. */
const HIDDEN_PATHS_LIMIT = 10_000;

type Turn = { inboxItemId: string; files: Map<string, RoomContributionEditFile>; hidden: Set<string>; hiddenOverflow: number; patchChars: number };

/**
 * The files each agent's current delivered turn changed with its own edit
 * tools, from the provider's edit events. A summary, never proof: the turn's
 * compared trees stay the record. In memory only, like the turn's other
 * evidence; it does not outlive this process. Evidence that arrives while the
 * agent has no turn is dropped.
 */
export class TurnEditLedger {
  private readonly turns = new Map<string, Turn>();

  /** A delivered turn began, or moved to its next phase (the same inbox item keeps its edits). */
  turnStarted(agentId: string, inboxItemId: string): void {
    if (this.turns.get(agentId)?.inboxItemId === inboxItemId) return;
    this.turns.set(agentId, { inboxItemId, files: new Map(), hidden: new Set(), hiddenOverflow: 0, patchChars: 0 });
  }

  /** The turn ended; null ends whichever turn is current (the agent stopped). */
  turnEnded(agentId: string, inboxItemId: string | null): void {
    const turn = this.turns.get(agentId);
    if (turn && (inboxItemId === null || turn.inboxItemId === inboxItemId)) this.turns.delete(agentId);
  }

  forget(agentId: string): void { this.turns.delete(agentId); }

  /** Merge one event's evidence: counts add up per path, patches append in call order within the limits. */
  observe(agentId: string, evidence: readonly AgentEditEvidence[]): void {
    const turn = this.turns.get(agentId);
    if (!turn) return;
    const limits = ROOM_CONTRIBUTION_EDIT_LIMITS;
    for (const incoming of evidence) {
      const current = turn.files.get(incoming.path);
      if (!current) {
        if (turn.files.size >= limits.files) {
          if (turn.hidden.has(incoming.path)) continue;
          if (turn.hidden.size < HIDDEN_PATHS_LIMIT) turn.hidden.add(incoming.path); else turn.hiddenOverflow++;
          continue;
        }
        turn.files.set(incoming.path, { path: incoming.path, additions: 0, deletions: 0, patch: "", patch_truncated: false });
      }
      const file = turn.files.get(incoming.path)!;
      file.additions = Math.min(Number.MAX_SAFE_INTEGER, file.additions + incoming.additions);
      file.deletions = Math.min(Number.MAX_SAFE_INTEGER, file.deletions + incoming.deletions);
      // A patch that was cut stays cut: a later call's hunks would not follow on from it.
      if (file.patch_truncated) continue;
      const joined = file.patch && incoming.patch ? `${file.patch}\n${incoming.patch}` : file.patch || incoming.patch;
      const bounded = boundEditPatch(joined, Math.min(limits.patchChars, file.patch.length + limits.totalPatchChars - turn.patchChars));
      turn.patchChars += bounded.patch.length - file.patch.length;
      file.patch = bounded.patch;
      file.patch_truncated = bounded.truncated || incoming.patch_truncated;
    }
  }

  /**
   * This turn's edits, or null when its provider does not report edits or the
   * ledger saw no start of this turn. Zero files is an answer: the provider
   * reports edits and reported none.
   */
  take(agentId: string, inboxItemId: string, provider: string): RoomContributionEdits | null {
    const turn = this.turns.get(agentId);
    if (!EDIT_REPORTING_PROVIDERS.has(provider) || turn?.inboxItemId !== inboxItemId) return null;
    return { files: [...turn.files.values()].map((file) => ({ ...file })), hidden_files: turn.hidden.size + turn.hiddenOverflow };
  }
}
