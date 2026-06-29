import type {
  GitRoomBindingSource,
  GitRoomProvider,
  GitRoomRefType,
  GitRoomVisibility,
} from "../schema.js";

export type {
  GitRoomBindingSource,
  GitRoomProvider,
  GitRoomRefType,
  GitRoomVisibility,
} from "../schema.js";

export interface GitRoomBinding {
  room_id: string;
  provider: GitRoomProvider;
  host: string;
  repository_id: string | null;
  repository_full_name: string;
  repository_owner: string;
  repository_name: string;
  ref_type: GitRoomRefType;
  ref_name: string | null;
  default_branch: string | null;
  base_ref: string | null;
  head_ref: string | null;
  head_repository_id: string | null;
  head_repository_full_name: string | null;
  head_repository_owner: string | null;
  head_repository_name: string | null;
  visibility: GitRoomVisibility;
  is_default: boolean;
  source: GitRoomBindingSource;
  created_at: string;
  updated_at: string;
}

export interface GitRoomSummary {
  room_id: string;
  provider: GitRoomProvider;
  host: string;
  repository: {
    id: string | null;
    owner: string;
    name: string;
    full_name: string;
  };
  ref: {
    type: GitRoomRefType;
    name: string | null;
    default_branch: string | null;
    base_ref: string | null;
    head_ref: string | null;
    head_repository: {
      id: string | null;
      owner: string;
      name: string;
      full_name: string;
    } | null;
    is_default: boolean;
  };
  visibility: GitRoomVisibility;
  access_mode: GitRoomVisibility;
  source: GitRoomBindingSource;
  updated_at: string | null;
}
