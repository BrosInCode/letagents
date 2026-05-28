import type { GitHubRoomEventMetadata, GitHubRoomEventType } from "../schema.js";

export interface GitHubRepositoryLink {
  github_repo_id: string;
  room_id: string;
  owner_login: string;
  repo_name: string;
  full_name: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubAppInstallation {
  installation_id: string;
  target_type: string;
  target_login: string;
  target_github_id: string;
  repository_selection: string;
  permissions_json: string | null;
  suspended_at: string | null;
  uninstalled_at: string | null;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubAppRepository {
  github_repo_id: string;
  installation_id: string;
  owner_login: string;
  repo_name: string;
  full_name: string;
  room_id: string;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type GitHubWebhookDeliveryStatus = "received" | "processed" | "ignored" | "failed";

export interface GitHubWebhookDelivery {
  delivery_id: string;
  event_name: string;
  action: string | null;
  installation_id: string | null;
  github_repo_id: string | null;
  room_id: string | null;
  status: GitHubWebhookDeliveryStatus;
  error: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface GitHubRoomEvent {
  id: string;
  room_id: string | null;
  delivery_id: string | null;
  event_type: GitHubRoomEventType;
  action: string;
  idempotency_key: string;
  github_object_id: string | null;
  github_object_url: string | null;
  title: string | null;
  state: string | null;
  actor_login: string | null;
  metadata: GitHubRoomEventMetadata | null;
  linked_task_id: string | null;
  created_at: string;
}

/**
 * GitHub artifact status summary for a single task.
 * Materialized from github_room_events linked to the task.
 */
export interface TaskGitHubArtifactStatus {
  task_id: string;
  pr_state: string | null;
  pr_title: string | null;
  pr_url: string | null;
  pr_number: string | null;
  pr_author: string | null;
  pr_actor: string | null;
  pr_draft: boolean | null;
  pr_merged: boolean | null;
  checks: Array<{
    name: string;
    conclusion: string | null;
    state: string | null;
    actor: string | null;
  }>;
  reviews: Array<{
    actor: string | null;
    state: string | null;
  }>;
  check_summary: {
    total: number;
    success: number;
    failure: number;
    pending: number;
  };
  review_summary: {
    total: number;
    approved: number;
    changes_requested: number;
  };
}
