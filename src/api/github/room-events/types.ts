import type {
  GitHubRoomEventMetadata,
  GitHubRoomEventType,
} from "../../db/schema.js";
import type { RepoRoomEvent } from "../../repo-workflow.js";

export interface MaterializedGitHubRoomEvent {
  event_type: GitHubRoomEventType;
  action: string;
  idempotency_key: string;
  semantic_id: string | null;
  github_object_id: string | null;
  github_object_url: string | null;
  title: string | null;
  state: string | null;
  actor_login: string | null;
  provider_event_at: string | null;
  provider_object_updated_at: string | null;
  ref: string | null;
  base_ref: string | null;
  head_ref: string | null;
  head_sha: string | null;
  metadata: GitHubRoomEventMetadata | null;
  roomEvent: RepoRoomEvent | null;
}

export interface GitHubRepoEventBase {
  provider: "github";
  action: string;
  repositoryFullName: string;
  senderLogin: string | null;
}
