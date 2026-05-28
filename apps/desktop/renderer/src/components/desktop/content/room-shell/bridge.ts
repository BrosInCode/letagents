export function getRoomBridge(): Partial<typeof window.letagentsDesktop.room> | undefined {
  return window.letagentsDesktop?.room as Partial<typeof window.letagentsDesktop.room> | undefined;
}

export function desktopBridgeUpgradeMessage(): string {
  return "Restart LetAgents Desktop to load the latest room tools.";
}
