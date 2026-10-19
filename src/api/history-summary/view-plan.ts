/** A node of the tree, by level and index. */
export interface RoomHistoryPart { level: number; idx: number }

/**
 * Which nodes a view shows: nodes that together cover all `leafCount`
 * messages once, oldest first, in at most about `maxLines` lines.
 *
 * Every leaf exists. A higher node has text exactly when its whole range lies
 * inside the tree and no node in its subtree is waiting for text (a parent
 * row is written in the transaction that gives its second child text), so
 * `unbuilt`, which is short, says which nodes have text.
 *
 * 1. Start from the fewest nodes with text that cover the tree; a leaf
 *    waiting for text is shown as itself (its message, clipped).
 * 2. While there is room, open the node whose span is largest for its age
 *    (span / distance from the end) into its two children. So recent
 *    messages get one line each and older stretches broader lines, each line
 *    covering about as many messages as it is old, scaled to fit the budget.
 * 3. If waiting leaves push the view past the budget, keep the newest lines.
 *    The budget is never below the fewest lines that cover a fully written
 *    tree (top + 1), so no written stretch is ever dropped for budget alone.
 */
export function planRoomHistoryView(
  leafCount: number,
  unbuilt: readonly RoomHistoryPart[],
  maxLines: number,
): { parts: RoomHistoryPart[]; omittedOlderLines: number } {
  if (leafCount <= 0) return { parts: [], omittedOlderLines: 0 };
  const waiting = new Map<number, number[]>();
  for (const node of unbuilt) {
    const list = waiting.get(node.level) ?? [];
    list.push(node.idx);
    waiting.set(node.level, list);
  }
  for (const list of waiting.values()) list.sort((a, b) => a - b);

  const span = (level: number) => 2 ** level;
  const full = (part: RoomHistoryPart) => (part.idx + 1) * span(part.level) <= leafCount;
  // Whether any waiting node lies in this node's subtree (itself included).
  const hasWaiting = (part: RoomHistoryPart) => {
    for (const [level, list] of waiting) {
      if (level > part.level) continue;
      const shift = part.level - level;
      const low = part.idx * 2 ** shift;
      const high = low + 2 ** shift;
      // First waiting index >= low.
      let lo = 0, hi = list.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid]! < low) lo = mid + 1; else hi = mid; }
      if (lo < list.length && list[lo]! < high) return true;
    }
    return false;
  };
  const built = (part: RoomHistoryPart) => part.level === 0
    ? !hasWaiting(part) : full(part) && !hasWaiting(part);

  let top = 0;
  while (span(top) < leafCount) top += 1;
  const parts: RoomHistoryPart[] = [];
  const cover = (part: RoomHistoryPart): void => {
    if (part.idx * span(part.level) >= leafCount) return;
    if (part.level === 0 || built(part)) { parts.push(part); return; }
    cover({ level: part.level - 1, idx: part.idx * 2 });
    cover({ level: part.level - 1, idx: part.idx * 2 + 1 });
  };
  cover({ level: top, idx: 0 });

  const budget = Math.max(maxLines, top + 1);
  while (parts.length < budget) {
    let best = -1;
    let bestScore = 0;
    for (const [position, part] of parts.entries()) {
      if (part.level === 0) continue;
      const age = leafCount - part.idx * span(part.level);
      const score = span(part.level) / age;
      // Ties go to the newer node.
      if (score >= bestScore) { best = position; bestScore = score; }
    }
    if (best < 0) break;
    const part = parts[best]!;
    parts.splice(best, 1, { level: part.level - 1, idx: part.idx * 2 }, { level: part.level - 1, idx: part.idx * 2 + 1 });
  }
  const omittedOlderLines = Math.max(0, parts.length - budget);
  return { parts: parts.slice(omittedOlderLines), omittedOlderLines };
}
