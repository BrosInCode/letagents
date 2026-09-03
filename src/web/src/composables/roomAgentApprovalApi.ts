import {
  isExecutionApprovalPublicationIdentity,
  parseExecutionApprovalPublicationItem,
  type ExecutionApprovalPublicationItem,
} from '../../../../shared/execution-approval-publication-item.mjs'
import {
  EXECUTION_APPROVAL_PROJECTION_MAX_BYTES,
  EXECUTION_APPROVAL_PROJECTION_VERSION,
  parseExecutionApprovalProjectionV1,
  serializeExecutionApprovalProjectionV1,
  type ExecutionApprovalProjectionV1,
} from '../../../../shared/execution-approval-projection.mjs'
import type { ExecutionDelegationDecisionChoice } from '../../../../shared/execution-delegation-decision.mjs'
import { roomPath } from './room/api'

export interface RoomAgentApprovalPage {
  publications: ExecutionApprovalPublicationItem[]
  nextCursor: string | null
  serverNow: number | null
}

export type RoomAgentApprovalEvidence =
  | {
      status: 'ready'
      projectionJson: string
      projection: ExecutionApprovalProjectionV1
    }
  | { status: 'unsupported' }
  | { status: 'invalid'; message: string }
  | { status: 'unavailable' }

export class RoomAgentApprovalHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

async function responseError(response: Response): Promise<RoomAgentApprovalHttpError> {
  const raw = await response.text().catch(() => '')
  let message = raw || `HTTP ${response.status}`
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.error === 'string' && parsed.error) message = parsed.error
  } catch {
    // The status still carries the actionable transport distinction.
  }
  return new RoomAgentApprovalHttpError(message, response.status)
}

function parsePage(value: unknown, serverNow: number | null): RoomAgentApprovalPage | null {
  if (!exactKeys(value, ['publications', 'next_cursor'])
    || !Array.isArray(value.publications)
    || value.publications.length > 50
    || (value.next_cursor !== null
      && !isExecutionApprovalPublicationIdentity(value.next_cursor))) return null
  const publications = value.publications.map(parseExecutionApprovalPublicationItem)
  if (publications.some((item) => item === null)) return null
  return {
    publications: publications as ExecutionApprovalPublicationItem[],
    nextCursor: value.next_cursor as string | null,
    serverNow,
  }
}

function parseServerNow(value: string | null): number | null {
  if (value === null) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export async function fetchRoomAgentApprovals(
  roomIdentifier: string,
  after: string | null = null,
): Promise<RoomAgentApprovalPage> {
  const query = after ? `?after=${encodeURIComponent(after)}` : ''
  const response = await fetch(`${roomPath(roomIdentifier)}/agent-approvals${query}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw await responseError(response)
  const parsed = parsePage(await response.json(), parseServerNow(response.headers.get('Date')))
  if (!parsed) throw new Error('The approval inventory response was not valid.')
  return parsed
}

async function sha256(value: ArrayBuffer): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null
  const digest = await globalThis.crypto.subtle.digest('SHA-256', value)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function fetchRoomAgentApprovalEvidence(
  roomIdentifier: string,
  publication: ExecutionApprovalPublicationItem,
): Promise<RoomAgentApprovalEvidence> {
  const response = await fetch(
    `${roomPath(roomIdentifier)}/agent-approvals/${encodeURIComponent(publication.publication_id)}/projection`,
    {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    },
  )
  if (response.status === 404) return { status: 'unavailable' }
  if (!response.ok) throw await responseError(response)
  const projectionBytes = await response.arrayBuffer()
  if (projectionBytes.byteLength > EXECUTION_APPROVAL_PROJECTION_MAX_BYTES) {
    return { status: 'invalid', message: 'Approval reference exceeds the public size limit.' }
  }
  const digest = await sha256(projectionBytes)
  if (digest === null || digest !== publication.projection_sha256) {
    return { status: 'invalid', message: 'Approval reference could not be verified.' }
  }
  const bytes = new Uint8Array(projectionBytes)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { status: 'invalid', message: 'Approval reference must not contain a byte-order mark.' }
  }
  let projectionJson: string
  try {
    projectionJson = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { status: 'invalid', message: 'Approval reference is not valid UTF-8.' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(projectionJson)
  } catch {
    return { status: 'invalid', message: 'Approval reference is not valid JSON.' }
  }
  const version = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { version?: unknown }).version
    : null
  if (Number.isSafeInteger(version) && version !== EXECUTION_APPROVAL_PROJECTION_VERSION) {
    return { status: 'unsupported' }
  }
  const projection = parseExecutionApprovalProjectionV1(raw)
  if (!projection || serializeExecutionApprovalProjectionV1(projection) !== projectionJson) {
    return { status: 'invalid', message: 'Approval reference is not canonical.' }
  }
  return { status: 'ready', projectionJson, projection }
}

export async function submitRoomAgentApprovalDecision(
  publication: ExecutionApprovalPublicationItem,
  decision: ExecutionDelegationDecisionChoice,
  clientRequestId: string,
): Promise<void> {
  const response = await fetch(
    `/execution-delegations/${encodeURIComponent(publication.delegation_instance_id)}/decisions`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expected_revision: publication.delegation_revision,
        request_id: publication.request_id,
        request_version: publication.request_version,
        request_sha256: publication.request_sha256,
        projection_sha256: publication.projection_sha256,
        decision,
        client_request_id: clientRequestId,
      }),
    },
  )
  if (!response.ok) throw await responseError(response)
}
