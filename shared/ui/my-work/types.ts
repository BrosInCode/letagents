import type {
  MyWorkCard,
  MyWorkJevNeedsMe,
  MyWorkPage,
} from "../../ticket-connectors.mjs";
import type { MyWorkTrackerFilter } from "./model";
export interface WorkQuery {
  cursor: string | null;
  limit: number;
  tracker: Exclude<MyWorkTrackerFilter, ""> | null;
  roomId: string | null;
  needsMe: boolean;
  includeCompleted: boolean;
}
export interface WorkMention {
  messageId: string;
  threadRootId: string;
  sender: string;
  text: string;
  timestamp: string;
}
/** UI transport adapters; the existing account/room wire contracts remain owned by each host. */
export interface MyWorkApi {
  read(query: WorkQuery): Promise<MyWorkPage>;
  mentions(card: MyWorkCard): Promise<WorkMention[]>;
  askNeedsMe?(card: MyWorkCard): Promise<MyWorkJevNeedsMe>;
}
