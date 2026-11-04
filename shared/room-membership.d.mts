export declare const ROOM_MEMBERSHIP_REQUIRED: Readonly<{ error: 'room_membership_required'; code: 'ROOM_MEMBERSHIP_REQUIRED' }>;
export declare const REPO_COLLABORATOR_REQUIRED: Readonly<{ error: 'repo_collaborator_required'; code: 'REPO_COLLABORATOR_REQUIRED' }>;
export declare const REPO_ROOM_USES_GITHUB_ROLES: Readonly<{ error: 'repo_room_uses_github_roles'; code: 'REPO_ROOM_USES_GITHUB_ROLES' }>;
export declare const ROOM_MEMBERSHIP_REQUIRED_MESSAGE: string;
export declare const REPO_COLLABORATOR_REQUIRED_MESSAGE: string;
export declare const REPO_ROOM_USES_GITHUB_ROLES_MESSAGE: string;

export type RoomMemberRole = 'admin' | 'member';
export type RoomMemberSource = 'creator' | 'seed' | 'approved_request';
export type RoomJoinRequestState = 'pending' | 'approved' | 'declined' | 'cancelled';
export declare const ROOM_MEMBER_ROLES: readonly RoomMemberRole[];
export declare const ROOM_MEMBER_SOURCES: readonly RoomMemberSource[];
export declare const ROOM_JOIN_REQUEST_STATES: readonly RoomJoinRequestState[];
export declare const ROOM_JOIN_REQUEST_DECLINE_COOLDOWN_MS: number;

/** The caller's own latest request for a room. */
export interface RoomJoinRequestSummary {
  id: string;
  state: RoomJoinRequestState;
  created_at: string;
  decided_at: string | null;
  /** Set for a declined request: when the same person can ask again. */
  retry_after: string | null;
}

/** A request as a room admin sees it. */
export interface RoomJoinRequest extends RoomJoinRequestSummary {
  room_id: string;
  account_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  decided_by_login: string | null;
}

export interface RoomMember {
  account_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  role: RoomMemberRole;
  added_via: RoomMemberSource | null;
  joined_at: string;
}

/** GET /rooms/:room/membership */
export interface RoomMembershipState {
  room_id: string;
  /** The room whose members decide: the parent of a focus room, else the room. */
  access_room_id: string;
  display_name: string;
  /** 'github': a repo room; the GitHub role decides and the member fields are null. */
  managed_by: 'letagents' | 'github';
  member: boolean | null;
  role: RoomMemberRole | null;
  join_request: RoomJoinRequestSummary | null;
}

export interface RoomMembershipRequiredBody {
  error: 'room_membership_required';
  code: 'ROOM_MEMBERSHIP_REQUIRED';
  message: string;
  room_id: string;
  display_name: string | null;
  join_request: RoomJoinRequestSummary | null;
}

export interface RepoCollaboratorRequiredBody {
  error: 'repo_collaborator_required';
  code: 'REPO_COLLABORATOR_REQUIRED';
  message: string;
  room_id: string;
}

export declare function roomMembershipRequiredBody(input: {
  room_id: string;
  display_name?: string | null;
  join_request?: RoomJoinRequestSummary | null;
}): RoomMembershipRequiredBody;
export declare function repoCollaboratorRequiredBody(input: { room_id: string }): RepoCollaboratorRequiredBody;
export declare function roomAccessRefusal(body: unknown): 'membership_required' | 'repo_collaborator_required' | null;
