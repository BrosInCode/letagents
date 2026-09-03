import {
  executionApprovalPublicationSha256,
  parseExecutionApprovalPublicationCloseInput,
  parseExecutionApprovalPublicationCloseReceipt,
  parseExecutionApprovalPublicationInput,
  parseExecutionApprovalPublicationReceipt,
  type ExecutionApprovalPublicationInput,
} from "../../../shared/execution-approval-publication.mjs";
import { hostGrantApiOrigin, SupervisorGrantRequestError } from "./cloud-http.js";

export type ExecutionApprovalPublicationHttpInput = {
  apiOrigin: string;
  grantId: string;
  supervisorGrant: string;
  grantGeneration: number;
  sessionId: string;
  agentKey: string;
  publication: ExecutionApprovalPublicationInput;
  signal: AbortSignal;
};

export type ExecutionApprovalPublicationHttpResult =
  | { status: "acknowledged"; publicationId: string; publicationDigest: string; publishedAtMs: number }
  | { status: "conflict" }
  | { status: "terminal"; reason: "expired" | "invalid_delegation" };

export type ExecutionApprovalPublicationCloseHttpInput = Omit<ExecutionApprovalPublicationHttpInput, "publication"> & {
  publicationId: string;
  publicationDigest: string;
};

export type ExecutionApprovalPublicationCloseHttpResult =
  | { status: "closed"; closedAtMs: number }
  | { status: "conflict" }
  | { status: "terminal"; reason: "expired" | "invalid_delegation" };

/** Optional evidence upload only. It never renews credentials or runs provider work. */
export async function publishExecutionApproval(
  input: ExecutionApprovalPublicationHttpInput,
): Promise<ExecutionApprovalPublicationHttpResult> {
  const publication = parseExecutionApprovalPublicationInput(input.publication);
  if (!publication || hostGrantApiOrigin(input.apiOrigin) !== input.apiOrigin
    || !Number.isSafeInteger(input.grantGeneration) || input.grantGeneration < 1) {
    throw new Error("Invalid execution approval publication.");
  }
  const response = await fetch(`${input.apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}`
    + `/worker-sessions/${encodeURIComponent(input.sessionId)}/execution-approval-publications`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${input.supervisorGrant}`,
      "content-type": "application/json",
      "x-letagents-supervisor-generation": String(input.grantGeneration),
    },
    body: JSON.stringify(publication),
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]),
  });
  const body = await response.json() as unknown;
  if (response.status === 409 && body && typeof body === "object"
    && ["publication_conflict", "approval_conflict"].includes(String((body as Record<string, unknown>).code))) {
    return { status: "conflict" };
  }
  if (response.status === 409 && body && typeof body === "object") {
    const code = String((body as Record<string, unknown>).code);
    if (code === "publication_terminal") return { status: "terminal", reason: "expired" };
    if (code === "delegation_revision_conflict") return { status: "terminal", reason: "invalid_delegation" };
    if (code === "publication_work_not_ready" || code === "publication_capacity") {
      throw new SupervisorGrantRequestError(response.status, code === "publication_work_not_ready"
        ? "Execution approval publication work custody"
        : "Execution approval publication capacity");
    }
  }
  if (response.status === 403 && body && typeof body === "object"
    && String((body as Record<string, unknown>).code) === "publisher_not_authorized") {
    return { status: "terminal", reason: "invalid_delegation" };
  }
  if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Execution approval publication");
  const receipt = parseExecutionApprovalPublicationReceipt(body);
  const expectedDigest = executionApprovalPublicationSha256(publication);
  if (!receipt || receipt.publication_digest !== expectedDigest
    || receipt.publication.room_id !== publication.room_id
    || receipt.publication.agent_key !== input.agentKey
    || receipt.publication.delegation_instance_id !== publication.delegation_instance_id
    || receipt.publication.delegation_revision !== publication.delegation_revision
    || receipt.publication.request_id !== publication.request_id
    || receipt.publication.request_version !== publication.request_version
    || receipt.publication.request_sha256 !== publication.request_sha256
    || receipt.publication.projection_sha256 !== publication.projection_sha256
    || receipt.publication.expires_at !== publication.expires_at) {
    throw new Error("Execution approval publication returned a different receipt.");
  }
  return { status: "acknowledged", publicationId: receipt.publication.publication_id,
    publicationDigest: receipt.publication_digest, publishedAtMs: Date.parse(receipt.publication.published_at) };
}

/** Close one exact acknowledged publication without sending the local decision or reason. */
export async function closeExecutionApprovalPublication(
  input: ExecutionApprovalPublicationCloseHttpInput,
): Promise<ExecutionApprovalPublicationCloseHttpResult> {
  const body = parseExecutionApprovalPublicationCloseInput({ publication_digest: input.publicationDigest });
  if (!body || hostGrantApiOrigin(input.apiOrigin) !== input.apiOrigin
    || !Number.isSafeInteger(input.grantGeneration) || input.grantGeneration < 1) {
    throw new Error("Invalid execution approval publication closure.");
  }
  const response = await fetch(`${input.apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}`
    + `/worker-sessions/${encodeURIComponent(input.sessionId)}/execution-approval-publications/`
    + `${encodeURIComponent(input.publicationId)}/close`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${input.supervisorGrant}`,
      "content-type": "application/json",
      "x-letagents-supervisor-generation": String(input.grantGeneration),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(20_000)]),
  });
  const responseBody = await response.json() as unknown;
  if (response.status === 409 && responseBody && typeof responseBody === "object") {
    const code = String((responseBody as Record<string, unknown>).code);
    if (code === "publication_conflict") return { status: "conflict" };
    if (code === "publication_terminal") return { status: "terminal", reason: "expired" };
  }
  if (response.status === 403 && responseBody && typeof responseBody === "object"
    && String((responseBody as Record<string, unknown>).code) === "publisher_not_authorized") {
    return { status: "terminal", reason: "invalid_delegation" };
  }
  if (!response.ok) throw new SupervisorGrantRequestError(response.status, "Execution approval publication closure");
  const receipt = parseExecutionApprovalPublicationCloseReceipt(responseBody);
  if (!receipt || receipt.publication_id !== input.publicationId
    || receipt.publication_digest !== input.publicationDigest) {
    throw new Error("Execution approval publication closure returned a different receipt.");
  }
  return { status: "closed", closedAtMs: Date.parse(receipt.closed_at) };
}
