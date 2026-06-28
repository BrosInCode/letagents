import type {
  RoomSharedArtifactKind,
  RoomSharedArtifactProvider,
  RoomSharedArtifactSource,
} from "../schema.js";

export type {
  RoomSharedArtifactKind,
  RoomSharedArtifactProvider,
  RoomSharedArtifactSource,
} from "../schema.js";

export interface RoomSharedArtifact {
  room_id: string;
  identity_key: string;
  provider: RoomSharedArtifactProvider;
  kind: RoomSharedArtifactKind;
  artifact_id: string | null;
  artifact_number: number | null;
  title: string | null;
  url: string | null;
  ref: string | null;
  state: string | null;
  source: RoomSharedArtifactSource;
  first_seen_at: string;
  updated_at: string;
  linked_task_ids: string[];
}

export interface RoomSharedArtifactTaskLink {
  room_id: string;
  artifact_identity_key: string;
  task_id: string;
  source: RoomSharedArtifactSource;
  linked_at: string;
  updated_at: string;
}
