import type { Express } from "express";

import {
  normalizeUsageLimitResetMs,
  PROVIDER_USAGE_LIMIT_SOURCE,
  providerUsageLimitNoticeText,
} from "../../../shared/provider-usage-limit.mjs";
import { isSupervisorHostGrantFeatureEnabled } from "../../shared/agent-session-bearer.js";
import { getAgentIdentityByCanonicalKey } from "../db.js";
import { assertSupervisorGrantFenceTx, SupervisorGrantFenceStaleError } from "../db/auth.js";
import { respondWithInternalError, type AuthenticatedRequest } from "../http/helpers.js";
import { normalizeRoomId } from "../rooms/routing.js";
import type { emitProjectMessage } from "../server/events.js";
import {
  requireCurrentSupervisorGrant,
  respondToStaleSupervisorGrantFence,
  type RoomResolverDeps,
} from "./supervisor-host-grants.js";

export type ProviderUsageLimitNoticeRouteDeps = RoomResolverDeps & {
  emitProjectMessage: typeof emitProjectMessage;
  requireCurrentSupervisorGrant?: typeof requireCurrentSupervisorGrant;
  getAgentIdentityByCanonicalKey?: typeof getAgentIdentityByCanonicalKey;
  assertSupervisorGrantFenceTx?: typeof assertSupervisorGrantFenceTx;
  nowMs?: () => number;
};

const PROVIDERS = new Set(["claude-code", "claude", "codex", "cursor", "open-model", "open_model", "antigravity"]);
/** The reset the provider named (epoch ms), or a day number when it named none. */
const OCCURRENCE_PATTERN = /^(?:(\d{12,14})|unknown:(\d{5}))$/;
const DAY_MS = 24 * 60 * 60_000;
/** One agent's notices are at least this far apart, whatever a desktop asks. */
export const USAGE_LIMIT_NOTICE_MIN_INTERVAL_MS = 10 * 60_000;
const lastNoticeAt = new Map<string, number>();

/** Agent names are shown, never read as instructions or mentions. */
function noticeAgentName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? value.replace(/[@\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim().slice(0, 64) : "";
  return name || fallback;
}

/**
 * A desktop tells its agent's room that the agent reached its model
 * provider's usage limit. Only a current supervisor grant for that room and
 * agent may ask. The room writes the text itself and posts it once per
 * occurrence as LetAgents; the notice never activates an agent.
 */
export function registerProviderUsageLimitNoticeRoutes(app: Express, deps: ProviderUsageLimitNoticeRouteDeps): void {
  if (!isSupervisorHostGrantFeatureEnabled()) return;

  app.post(
    "/supervisor-host-grants/:grantId/usage-limit-notices",
    async (req: AuthenticatedRequest, res) => {
      if (req.authKind !== "supervisor_grant" || req.supervisorGrant?.grant_id !== req.params.grantId) {
        res.status(403).json({ error: "A current supervisor grant is required." });
        return;
      }
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body as Record<string, unknown> : {};
      const requestedRoom = typeof body.room_id === "string" ? body.room_id.trim() : "";
      const agentKey = typeof body.agent_key === "string" ? body.agent_key.trim() : "";
      const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
      const phase = body.phase === "start" || body.phase === "turn" ? body.phase : null;
      const occurrence = typeof body.occurrence === "string" ? body.occurrence.trim() : "";
      const resetsAtMs = body.resets_at === null || body.resets_at === undefined ? null : normalizeUsageLimitResetMs(body.resets_at);
      // The occurrence must be the reset itself, or today when there is none,
      // so a desktop cannot invent new occurrences to post more notices.
      const occurrenceMatch = OCCURRENCE_PATTERN.exec(occurrence);
      const today = Math.floor((deps.nowMs?.() ?? Date.now()) / DAY_MS);
      const occurrenceFits = occurrenceMatch !== null && (resetsAtMs !== null
        ? occurrenceMatch[1] === String(resetsAtMs)
        : occurrenceMatch[2] !== undefined && Math.abs(Number(occurrenceMatch[2]) - today) <= 1);
      if (!requestedRoom || requestedRoom.length > 512 || !agentKey || !PROVIDERS.has(provider) || !phase
        || !occurrenceFits
        || (body.resets_at !== null && body.resets_at !== undefined && (typeof body.resets_at !== "string" || resetsAtMs === null))) {
        res.status(400).json({ error: "Invalid usage-limit notice." });
        return;
      }
      try {
        const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(requestedRoom));
        if (roomId !== requestedRoom) {
          res.status(400).json({ error: "A usage-limit notice must use the canonical room id.", code: "noncanonical_room_id" });
          return;
        }
        const grant = await (deps.requireCurrentSupervisorGrant ?? requireCurrentSupervisorGrant)(req, res, deps, { kind: "rooms", room_ids: [roomId] });
        if (!grant) return;
        if (!grant.allowed_room_ids.includes(roomId) || !grant.allowed_agent_keys.includes(agentKey)) {
          res.status(403).json({ error: "Grant does not authorize that room and agent identity." });
          return;
        }
        const agent = await (deps.getAgentIdentityByCanonicalKey ?? getAgentIdentityByCanonicalKey)(agentKey);
        if (!agent || agent.owner_account_id !== grant.owner_account_id) {
          res.status(403).json({ error: "Grant agent identity is no longer valid." });
          return;
        }
        const project = await deps.resolveRoomOrReply(roomId, res);
        if (!project) return;
        const throttleKey = `${project.id}\u0000${agent.canonical_key}`;
        const nowMs = deps.nowMs?.() ?? Date.now();
        const last = lastNoticeAt.get(throttleKey);
        if (last !== undefined && nowMs - last < USAGE_LIMIT_NOTICE_MIN_INTERVAL_MS) {
          res.setHeader("Retry-After", String(Math.ceil((USAGE_LIMIT_NOTICE_MIN_INTERVAL_MS - (nowMs - last)) / 1000)));
          res.status(429).json({ error: "This agent's usage-limit notice was posted moments ago." });
          return;
        }
        // Reserve the interval before posting, so requests that arrive
        // together cannot all pass the check; a failed post gives it back.
        lastNoticeAt.set(throttleKey, nowMs);
        if (lastNoticeAt.size > 10_000) lastNoticeAt.delete(lastNoticeAt.keys().next().value!);
        const fence = { grant_id: grant.grant_id, generation: grant.current_generation, token_version: grant.token_version };
        const assertFence = deps.assertSupervisorGrantFenceTx ?? assertSupervisorGrantFenceTx;
        const displayName = noticeAgentName(body.display_name, noticeAgentName(agent.display_name, "An agent"));
        const text = providerUsageLimitNoticeText({ agentName: displayName, provider, resetsAt: resetsAtMs, phase });
        let message: Awaited<ReturnType<typeof emitProjectMessage>>;
        try {
          message = await deps.emitProjectMessage(project.id, "letagents", text, {
            source: PROVIDER_USAGE_LIMIT_SOURCE,
            client_message_id: `${PROVIDER_USAGE_LIMIT_SOURCE}:${agent.canonical_key}:${phase}:${occurrence}`,
            // A grant revoked, rotated or handed off since the check above
            // must not post: the fence is checked again where the message is written.
            with_created_message_in_transaction: async (tx) => {
              if (!await assertFence(tx, fence)) throw new SupervisorGrantFenceStaleError();
            },
          });
        } catch (error) {
          if (lastNoticeAt.get(throttleKey) === nowMs) {
            if (last === undefined) lastNoticeAt.delete(throttleKey);
            else lastNoticeAt.set(throttleKey, last);
          }
          throw error;
        }
        res.setHeader("Cache-Control", "no-store");
        res.status(201).json({ status: "created", message_id: message.id, room_id: project.id });
      } catch (error) {
        if (respondToStaleSupervisorGrantFence(res, error)) return;
        respondWithInternalError(res, "provider-usage-limit-notice", error, "The usage-limit notice could not be posted.");
      }
    },
  );
}
