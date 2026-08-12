export const threadPaneMinWidth = 320;
export const threadPaneDefaultWidth = 420;
export const threadPaneHardMaxWidth = 560;
export const threadPaneMinRoomWidth = 560;
export const threadPaneGapWidth = 10;

export function shouldOverlayThreadPane(containerWidth: number): boolean {
  return containerWidth > 0
    && containerWidth < threadPaneMinRoomWidth + threadPaneMinWidth + threadPaneGapWidth;
}

export function maxThreadPaneWidthForContainer(containerWidth: number): number {
  return Math.max(
    threadPaneMinWidth,
    Math.min(threadPaneHardMaxWidth, containerWidth - threadPaneMinRoomWidth - threadPaneGapWidth),
  );
}
