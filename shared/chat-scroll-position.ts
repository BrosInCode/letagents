/** In-memory room reading position; message identity survives paging and reflow. */
export interface ChatScrollPosition {
  top: number;
  latest: boolean;
  anchor: { messageId: string; offsetTop: number } | null;
}
