/**
 * Unsaved guidelines, kept while the app is open. Room settings can close in
 * many ways (Escape, a click outside, opening the room contract, search), and
 * none of them should cost someone the text they were writing.
 */
export interface KeptGuidelinesDraft {
  draft: string;
  /** The saved text the draft was written against. */
  writtenAgainst: string;
}

const guidelinesDrafts = new Map<string, KeptGuidelinesDraft>();

export function rememberGuidelinesDraft(roomIdentifier: string, draft: string, writtenAgainst: string): void {
  guidelinesDrafts.set(roomIdentifier, { draft, writtenAgainst });
}

export function forgetGuidelinesDraft(roomIdentifier: string): void {
  guidelinesDrafts.delete(roomIdentifier);
}

export function keptGuidelinesDraft(roomIdentifier: string): KeptGuidelinesDraft | null {
  return guidelinesDrafts.get(roomIdentifier) ?? null;
}
