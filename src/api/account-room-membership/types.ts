export type RoomKind = "main" | "focus";
export type FocusRoomStatus = "active" | "concluded";

export type AccountRoomMembershipRole = "admin" | "participant";

export interface AccountRoomListFocusRoom {
  room_id: string;
  display_name: string;
  kind: "focus";
  parent_room_id: string;
  focus_key: string | null;
  source_task_id: string | null;
  focus_status: FocusRoomStatus | null;
  role: AccountRoomMembershipRole;
  source: string | null;
  first_opened_at: string | null;
  last_opened_at: string | null;
  latest_message_id: string | null;
  latest_message_at: string | null;
}

export interface AccountRoomListEntry {
  room_id: string;
  display_name: string;
  kind: "main";
  role: AccountRoomMembershipRole;
  source: string | null;
  pinned: boolean;
  archived: boolean;
  can_leave: boolean;
  can_delete: boolean;
  delete_reason: string | null;
  first_opened_at: string | null;
  last_opened_at: string | null;
  latest_message_id: string | null;
  latest_message_at: string | null;
  focus_rooms: AccountRoomListFocusRoom[];
}

export interface AccountRoomProject {
  id: string;
  display_name: string;
  kind: RoomKind;
  parent_room_id: string | null;
  focus_key: string | null;
  source_task_id: string | null;
  focus_status: FocusRoomStatus | null;
  focus_archived_at: string | null;
  created_at: string;
}

export type AccountRoomProjectRow = Omit<AccountRoomProject, "kind" | "focus_status"> & {
  kind: string;
  focus_status: string | null;
};

export interface AccountRoomCandidate {
  project: AccountRoomProject;
  role: AccountRoomMembershipRole;
  source: string | null;
  pinned: boolean;
  archived: boolean;
  canDelete: boolean;
  directParentAccess: boolean;
  first_opened_at: string | null;
  last_opened_at: string | null;
}
