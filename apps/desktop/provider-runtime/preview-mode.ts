/** Set only by the packaged preview bootstrap, before desktop imports. */
export function isIsolatedDesktopPreview(): boolean {
  return Reflect.get(globalThis, Symbol.for("letagents.isolated-desktop-preview")) === "agent-room-refresh";
}

export function desktopProductName(): string {
  return isIsolatedDesktopPreview() ? "LetAgents Preview" : "LetAgents";
}

export function desktopLinkScheme(): string {
  return isIsolatedDesktopPreview() ? "letagents-preview" : "letagents";
}

/** Preview links share routing behavior without taking the production scheme. */
export function normalizeDesktopPreviewLink(value: string): string {
  return isIsolatedDesktopPreview() ? value.replace(/^letagents-preview:/i, "letagents:") : value;
}
