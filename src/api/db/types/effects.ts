export type WorkflowEffectState = "pending" | "succeeded" | "failed" | "ambiguous";

export type WorkflowEffectKind = "github_review_verdict";

export interface WorkflowEffect {
  id: string;
  room_id: string;
  task_id: string;
  lease_id: string;
  kind: WorkflowEffectKind;
  provider: "github";
  idempotency_key: string;
  correlation_key: string;
  request_fingerprint: string;
  request_payload: Record<string, unknown>;
  state: WorkflowEffectState;
  attempt_count: number;
  max_attempts: number;
  processing_token: string | null;
  processing_started_at: string | null;
  next_attempt_at: string | null;
  external_id: string | null;
  external_url: string | null;
  response_payload: Record<string, unknown> | null;
  last_error: string | null;
  quarantined_at: string | null;
  quarantine_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type WorkflowEffectRow = WorkflowEffect;
