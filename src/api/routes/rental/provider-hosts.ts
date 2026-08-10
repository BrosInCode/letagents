import type { Express, Response } from "express";

import type { AuthenticatedRequest } from "../../http/helpers.js";
import {
  heartbeatRentalProviderHost,
  listRentalProviderHosts,
  registerRentalProviderHost,
  type RentalProviderHostInput,
} from "../../rental/provider-hosts.js";
import {
  decodeRentalProviderEventCursor,
  listRentalProviderEvents,
} from "../../rental/provider-events.js";
import {
  acknowledgeRentalLaunch,
  createRentalLaunchAuthority,
  type RentalLaunchAcknowledgement,
} from "../../rental/session-launch.js";
import { isRentEnabled } from "./provider.js";

export interface RentalProviderHostRouteDeps {
  registerHost: typeof registerRentalProviderHost;
  heartbeatHost: typeof heartbeatRentalProviderHost;
  listHosts: typeof listRentalProviderHosts;
  listEvents: typeof listRentalProviderEvents;
  createLaunchAuthority: typeof createRentalLaunchAuthority;
  acknowledgeLaunch: typeof acknowledgeRentalLaunch;
}

const defaultDeps: RentalProviderHostRouteDeps = {
  registerHost: registerRentalProviderHost,
  heartbeatHost: heartbeatRentalProviderHost,
  listHosts: listRentalProviderHosts,
  listEvents: listRentalProviderEvents,
  createLaunchAuthority: createRentalLaunchAuthority,
  acknowledgeLaunch: acknowledgeRentalLaunch,
};

function requireProvider(req: AuthenticatedRequest, res: Response): string | null {
  if (!isRentEnabled()) {
    res.status(404).json({ error: "rent_disabled" });
    return null;
  }
  if (!req.sessionAccount?.account_id || req.authKind !== "owner_token") {
    res.status(401).json({ error: "Provider host control requires owner-token authentication" });
    return null;
  }
  return req.sessionAccount.account_id;
}

function hostInput(
  req: AuthenticatedRequest,
  providerAccountId: string,
  hostIdOverride?: string,
): RentalProviderHostInput | null {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return null;
  const body = req.body as Record<string, unknown>;
  const hostId = hostIdOverride
    ?? (typeof body.hostId === "string" ? body.hostId : typeof body.host_id === "string" ? body.host_id : "");
  const installationId = typeof body.installationId === "string"
    ? body.installationId
    : typeof body.installation_id === "string"
      ? body.installation_id
      : "";
  const maxConcurrentSessions = body.maxConcurrentSessions ?? body.max_concurrent_sessions ?? 1;
  if (!hostId.trim() || !installationId.trim() || !Array.isArray(body.runtimes)
    || typeof maxConcurrentSessions !== "number") return null;
  return {
    providerAccountId,
    hostId,
    installationId,
    enabled: body.enabled === true,
    maxConcurrentSessions,
    runtimes: body.runtimes as RentalProviderHostInput["runtimes"],
    daemonGeneration: typeof body.generation === "number"
      ? body.generation
      : typeof body.daemonGeneration === "number"
        ? body.daemonGeneration
        : null,
    defaultLrtLimit: typeof body.defaultLrtLimit === "number" ? body.defaultLrtLimit : undefined,
    defaultTimeLimitMinutes: typeof body.defaultTimeLimitMinutes === "number"
      ? body.defaultTimeLimitMinutes
      : undefined,
    manualAcceptRequired: body.manualAcceptRequired !== false,
  };
}

function routeError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown_error";
  const conflicts = new Set([
    "provider_host_unavailable", "launch_not_authorized", "launch_selection_required",
    "launch_not_pending", "launch_attempt_stale", "launch_already_active",
    "launch_state_transition_invalid", "daemon_entry_fence_lost",
    "rental_worker_not_ready", "rental_worker_grant_mismatch",
    "unsafe_rental_runtime_profile", "accept_selection_mismatch",
  ]);
  if (conflicts.has(message)) {
    res.status(409).json({ error: message });
    return;
  }
  if (message === "agent_identity_not_owned" || message === "direct_room_required") {
    res.status(403).json({ error: message });
    return;
  }
  if (message.startsWith("invalid_")) {
    res.status(400).json({ error: message });
    return;
  }
  res.status(500).json({ error: "rental_provider_operation_failed" });
}

export function registerRentalProviderHostRoutes(
  app: Express,
  deps: RentalProviderHostRouteDeps = defaultDeps,
): void {
  app.post("/api/rental/provider/hosts/register", async (req: AuthenticatedRequest, res) => {
    const accountId = requireProvider(req, res);
    if (!accountId) return;
    const input = hostInput(req, accountId);
    if (!input) return res.status(400).json({ error: "host identity, runtimes, and capacity are required" });
    try {
      res.status(201).json({ host: await deps.registerHost(input) });
    } catch (error) { routeError(res, error); }
  });

  app.post("/api/rental/provider/hosts/:hostId/heartbeat", async (req: AuthenticatedRequest, res) => {
    const accountId = requireProvider(req, res);
    if (!accountId) return;
    const input = hostInput(req, accountId, req.params.hostId as string);
    if (!input || input.hostId !== req.params.hostId) {
      return res.status(400).json({ error: "heartbeat host identity mismatch" });
    }
    try {
      res.json({ host: await deps.heartbeatHost(input) });
    } catch (error) { routeError(res, error); }
  });

  app.get("/api/rental/provider/hosts", async (req: AuthenticatedRequest, res) => {
    const accountId = requireProvider(req, res);
    if (!accountId) return;
    res.json({ hosts: await deps.listHosts(accountId) });
  });

  app.get("/api/rental/provider/events", async (req: AuthenticatedRequest, res) => {
    const accountId = requireProvider(req, res);
    if (!accountId) return;
    const rawCursor = typeof req.query.after === "string" ? req.query.after : undefined;
    const cursor = decodeRentalProviderEventCursor(rawCursor);
    if (rawCursor && !cursor) return res.status(400).json({ error: "invalid_cursor" });
    const limit = Number.parseInt(String(req.query.limit ?? "100"), 10);
    res.json(await deps.listEvents(accountId, cursor, Number.isFinite(limit) ? limit : 100));
  });

  app.post("/api/rental/provider/sessions/:id/launch-authority", async (req: AuthenticatedRequest, res) => {
    const accountId = requireProvider(req, res);
    if (!accountId) return;
    const agentKey = typeof req.body?.agentKey === "string"
      ? req.body.agentKey.trim()
      : typeof req.body?.agent_key === "string"
        ? req.body.agent_key.trim()
        : "";
    if (!agentKey) return res.status(400).json({ error: "agentKey is required" });
    try {
      const authority = await deps.createLaunchAuthority({
        sessionId: req.params.id as string,
        providerAccountId: accountId,
        agentKey,
      });
      if (!authority) return res.status(404).json({ error: "session_not_found" });
      res.status(201).json(authority);
    } catch (error) { routeError(res, error); }
  });

  app.post("/api/rental/provider/sessions/:id/launch-ack", async (req: AuthenticatedRequest, res) => {
    const accountId = requireProvider(req, res);
    if (!accountId) return;
    const body = req.body as Record<string, unknown>;
    const state = body.state;
    const launchAttempt = body.launchAttempt ?? body.launch_attempt;
    if ((state !== "provisioning" && state !== "active" && state !== "launch_failed")
      || typeof launchAttempt !== "number" || !Number.isInteger(launchAttempt)) {
      return res.status(400).json({ error: "integer launchAttempt and valid state are required" });
    }
    const acknowledgement: RentalLaunchAcknowledgement = {
      state,
      launchAttempt,
      daemonEntryId: typeof body.daemonEntryId === "string" ? body.daemonEntryId : undefined,
      roomAgentSessionId: typeof body.roomAgentSessionId === "string" ? body.roomAgentSessionId : undefined,
      errorCode: typeof body.errorCode === "string" ? body.errorCode : undefined,
      errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : undefined,
    };
    try {
      const session = await deps.acknowledgeLaunch({
        sessionId: req.params.id as string,
        providerAccountId: accountId,
        acknowledgement,
      });
      if (!session) return res.status(404).json({ error: "session_not_found" });
      res.json(session);
    } catch (error) { routeError(res, error); }
  });
}
