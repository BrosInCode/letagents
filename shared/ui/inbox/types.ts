export type InboxSection = 'needs-you' | 'updates' | 'answered';

/** Presentation shared by desktop and web; each caller keeps its own actions. */
export interface InboxQueueItem {
  key: string;
  title: string;
  actor: string;
  roomName: string;
}

export interface InboxRoomOption { id: string; label: string }
