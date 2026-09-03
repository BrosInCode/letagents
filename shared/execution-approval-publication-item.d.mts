export type ExecutionApprovalPublicationItem = {
  publication_id: string;
  room_id: string;
  agent_key: string;
  delegation_instance_id: string;
  delegation_revision: number;
  request_id: string;
  request_version: number;
  request_sha256: string;
  projection_sha256: string;
  published_at: string;
  expires_at: string;
};

export function isExecutionApprovalPublicationIdentity(value: unknown): value is string;
export function isExecutionApprovalPublicationDigest(value: unknown): value is string;
export function isExecutionApprovalPublicationVersion(value: unknown): value is number;
export function parseExecutionApprovalPublicationItem(
  value: unknown,
): ExecutionApprovalPublicationItem | null;
