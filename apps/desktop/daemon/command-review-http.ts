import { hostGrantApiOrigin } from "./cloud-http.js";
import { roomRequest } from "./local-room-runtime.js";

export type CommandReviewHttpInput = {
  apiOrigin: string;
  grantId: string;
  supervisorGrant: string;
  grantGeneration: number;
  roomId: string;
  commands: readonly string[];
  project: string;
  signal: AbortSignal;
};

const REVIEW_TIMEOUT_MS = 8_000;

/**
 * Ask the server whether these commands may run without asking their owner.
 * Only the exact reviewed "allow" is an allowance. A refusal, an error, a
 * timeout, or any other body means a person decides.
 */
export async function requestCommandReview(input: CommandReviewHttpInput): Promise<"allow" | "ask"> {
  try {
    if (hostGrantApiOrigin(input.apiOrigin) !== input.apiOrigin
      || !Number.isSafeInteger(input.grantGeneration) || input.grantGeneration < 1) return "ask";
    const response = await roomRequest(
      `${input.apiOrigin}/supervisor-host-grants/${encodeURIComponent(input.grantId)}/command-reviews`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${input.supervisorGrant}`,
          "content-type": "application/json",
          "x-letagents-supervisor-generation": String(input.grantGeneration),
        },
        body: JSON.stringify({ room_id: input.roomId, commands: input.commands, project: input.project }),
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]),
      });
    if (!response.ok) return "ask";
    const body = await response.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return "ask";
    const { decision, reason, ...rest } = body as Record<string, unknown>;
    return decision === "allow" && reason === "reviewed" && Object.keys(rest).length === 0 ? "allow" : "ask";
  } catch {
    return "ask";
  }
}
