import type { FocusRoomConclusionDetails } from "../../focus-rooms/conclusion.js";
import type { FocusActivityScope, FocusGitHubEventRouting, FocusParentVisibility } from "../../focus-rooms/settings.js";

export type RoomKind = "main" | "focus";

export type FocusRoomStatus = "active" | "concluded";

export interface Project {
  id: string;
  code: string | null;
  display_name: string;
  name?: string;
  kind: RoomKind;
  parent_room_id: string | null;
  focus_key: string | null;
  source_task_id: string | null;
  focus_status: FocusRoomStatus | null;
  focus_parent_visibility: FocusParentVisibility | null;
  focus_activity_scope: FocusActivityScope | null;
  focus_github_event_routing: FocusGitHubEventRouting | null;
  focus_archived_at: string | null;
  concluded_at: string | null;
  conclusion_summary: string | null;
  conclusion_details: FocusRoomConclusionDetails | null;
  created_at: string;
}

export interface RoomAlias {
  alias: string;
  room_id: string;
  created_at: string;
}
