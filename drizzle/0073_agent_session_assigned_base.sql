-- Persist the server-resolved BASE display name (before any collision suffix)
-- for each agent session. This is the provenance a replayed, already-decorated
-- label is normalized against: a re-registration replaying "MistyMorrow 2 1 1 1"
-- is reduced to "MistyMorrow" only because the identity previously held the
-- base "MistyMorrow", while a deliberately-requested "Agent 47" is recorded as
-- its own base and is therefore never demoted to "Agent". Additive and
-- backward-compatible; legacy rows keep NULL and fail closed (no stripping).
ALTER TABLE "room_agent_sessions" ADD COLUMN "assigned_base_display_name" text;
