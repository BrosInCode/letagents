/** Keep the quick identity picker next to its chip, inside the visible window. */
export function composerIdentityPosition(anchor: { left: number; top: number; bottom: number }, viewport: { left: number; top: number; width: number; height: number }) {
  const gap = 10, margin = 12;
  const width = Math.min(410, Math.max(0, viewport.width - margin * 2));
  const left = Math.max(viewport.left + margin, Math.min(anchor.left, viewport.left + viewport.width - margin - width));
  // A software keyboard can leave the layout anchor outside the visual viewport.
  const clampY = (value: number) => Math.max(viewport.top + margin, Math.min(value, viewport.top + viewport.height - margin));
  const anchorTop = clampY(anchor.top), anchorBottom = clampY(anchor.bottom);
  const above = Math.max(0, anchorTop - gap - viewport.top - margin);
  const below = Math.max(0, viewport.top + viewport.height - margin - anchorBottom - gap);
  const opensAbove = above >= below;
  const height = Math.min(640, opensAbove ? above : below);
  const top = opensAbove ? anchorTop - gap - height : anchorBottom + gap;
  return { left, top, width, height, opensAbove };
}
