import type { PersonWorkEvent } from "./person-work";

/** Platform operations used by the same person-work panel on desktop and web. */
export interface PersonWorkServices {
  getEvents(roomId: string, options: {
    limit: number;
    eventType: "pull_request" | "pull_request_review";
    since: string;
    after: string | null;
  }): Promise<{
    events: PersonWorkEvent[];
    hasMore: boolean;
    roomIdentifier: string;
    githubRoomIdentifier?: string | null;
  }>;
  getTicket(roomId: string, taskId: string): Promise<{ externalRef: string; url: string | null } | null>;
  openExternalUrl(url: string): Promise<void>;
}
