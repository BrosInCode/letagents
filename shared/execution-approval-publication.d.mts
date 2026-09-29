import type { ExecutionApprovalProjectionV1 } from "./execution-approval-projection.mjs";
import type { ExecutionApprovalPublicationItem } from "./execution-approval-publication-item.mjs";

export {
  isExecutionApprovalPublicationDigest,
  isExecutionApprovalPublicationIdentity,
  isExecutionApprovalPublicationVersion,
  parseExecutionApprovalPublicationItem,
} from "./execution-approval-publication-item.mjs";
export type { ExecutionApprovalPublicationItem } from "./execution-approval-publication-item.mjs";

export const EXECUTION_APPROVAL_PUBLICATION_VERSION: 1;
export const EXECUTION_APPROVAL_PUBLICATION_MAX_JSON_BYTES: number;

export type ExecutionApprovalPublicationInput = {
  version: 1;
  room_id: string;
  source_message_id: string;
  delegation_instance_id: string;
  delegation_revision: number;
  request_id: string;
  request_version: number;
  request_sha256: string;
  projection_sha256: string;
  projection_json: string;
  produced_at: string;
  expires_at: string;
};

export type ExecutionApprovalPublicationReceipt = {
  status: "created" | "replayed";
  publication_digest: string;
  publication: ExecutionApprovalPublicationItem;
};

export type ExecutionApprovalPublicationCloseInput = {
  publication_digest: string;
};

export type ExecutionApprovalPublicationCloseReceipt = {
  status: "closed" | "replayed";
  publication_id: string;
  publication_digest: string;
  closed_at: string;
};

export function parseExecutionApprovalPublicationInput(value: unknown): ExecutionApprovalPublicationInput | null;
export function parseExecutionApprovalPublicationReceipt(value: unknown): ExecutionApprovalPublicationReceipt | null;
export function parseExecutionApprovalPublicationCloseInput(value: unknown): ExecutionApprovalPublicationCloseInput | null;
export function parseExecutionApprovalPublicationCloseReceipt(value: unknown): ExecutionApprovalPublicationCloseReceipt | null;
export function executionApprovalPublicationSha256(value: unknown): string | null;

export type { ExecutionApprovalProjectionV1 };
