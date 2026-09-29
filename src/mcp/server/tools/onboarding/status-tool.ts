import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getRoomFromConfig } from "../../../config-reader.js";
import {
  buildActiveGitRoomContext,
  getGitCurrentBranch,
  getGitDefaultBranch,
  getGitRoomContext,
} from "../../../git-remote.js";
import { resolveGitRoot } from "../../repo-context.js";
import {
  API_URL,
  currentAgentIdentity,
  currentAgentIdentityKey,
  currentRoom,
  getLocalStatePath,
  getPendingDeviceAuth,
  getStoredAgentIdentity,
  getStoredAuth,
  getStoredCurrentRoom,
  toPublicAgentIdentity,
  toPublicRoomState,
  toPublicStoredRoomSession,
} from "../../runtime.js";
import { jsonTextResponse } from "./responses.js";
import { getWorkerBearerRuntime } from "../../runtime/worker-bearer.js";

type ApiHealthFetch = (
  url: string,
  init: { signal: AbortSignal }
) => Promise<{ ok: boolean; status: number }>;

export interface OnboardingApiHealth {
  url: string;
  reachable: boolean;
  status: number | null;
  error: string | null;
}

export async function checkOnboardingApiHealth(
  apiUrl: string = API_URL,
  fetchImpl: ApiHealthFetch = globalThis.fetch,
  timeoutMs = 1500
): Promise<OnboardingApiHealth> {
  const url = `${apiUrl.replace(/\/+$/, "")}/api/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    return {
      url,
      reachable: response.ok,
      status: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      url,
      reachable: false,
      status: null,
      error: error instanceof Error ? error.message : "fetch failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function apiUrlHint(health: OnboardingApiHealth): string | null {
  if (health.reachable) {
    return null;
  }

  const localApi = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(API_URL);
  if (localApi) {
    return "The MCP server is configured for a local LetAgents API, but the health check failed. Start the local API, or set LETAGENTS_API_URL=https://letagents.chat and restart the MCP server.";
  }

  return "The configured LetAgents API did not pass the health check. join_room and auth tools may fail until the backend is reachable.";
}

function authHint(authenticated: boolean): string | null {
  return authenticated
    ? null
    : "Public Git Rooms and ad-hoc rooms can be joined without auth. Private Git Rooms require start_device_auth, browser verification, then poll_device_auth to persist a LetAgents token.";
}

export function registerGetOnboardingStatusTool(server: McpServer): void {
  server.tool(
    "get_onboarding_status",
    "Inspect local Let Agents MCP auth and room-session state so a user can finish onboarding without guessing what is missing.",
    {
      cwd: z
        .string()
        .optional()
        .describe("Working directory to inspect for repo context. Defaults to the current process directory."),
    },
    async ({ cwd }) => {
      const workerRuntime = getWorkerBearerRuntime();
      if (workerRuntime.mode === "invalid") {
        return jsonTextResponse({ success: false, error: "worker_bearer_configuration_invalid", message: workerRuntime.error });
      }
      if (workerRuntime.mode === "worker" || workerRuntime.mode === "supervised") {
        return jsonTextResponse({
          api_url: API_URL,
          worker_bearer_mode: workerRuntime.mode === "worker",
          supervised_bounded_mode: workerRuntime.mode === "supervised",
          authenticated: true,
          auth_source: workerRuntime.mode === "worker" ? "worker_bearer" : "daemon_supervised",
          account: null,
          pending_device_auth: null,
          next_step: "join_room",
          note: "Owner-auth onboarding and saved-auth state are disabled in worker credential mode.",
        });
      }
      const workingDir = cwd || process.cwd();
      const repoRoot = resolveGitRoot(workingDir);
      const configRoom = getRoomFromConfig(workingDir);
      const gitContext = repoRoot ? getGitRoomContext(repoRoot) : null;
      const configGitContext = configRoom
        ? buildActiveGitRoomContext({
            repoRoom: configRoom,
            currentBranch: repoRoot ? getGitCurrentBranch(repoRoot) : null,
            defaultBranch: repoRoot ? getGitDefaultBranch(repoRoot) : null,
          })
        : null;
      const storedAuth = getStoredAuth();
      const pendingAuth = getPendingDeviceAuth();
      const savedCurrentRoom = getStoredCurrentRoom();
      const detectedRoom = configGitContext?.activeRoomLocator ?? gitContext?.activeRoomLocator ?? null;
      const api_health = await checkOnboardingApiHealth();
      const authenticated = Boolean(process.env.LETAGENTS_TOKEN || storedAuth);

      let nextStep = "join_room";
      if (!storedAuth && pendingAuth) {
        nextStep = "poll_device_auth";
      } else if (savedCurrentRoom && !currentRoom) {
        nextStep = "resume_room_session";
      }

      return jsonTextResponse({
        api_url: API_URL,
        api_health,
        api_url_hint: apiUrlHint(api_health),
        local_state_path: getLocalStatePath(),
        authenticated,
        auth_source: process.env.LETAGENTS_TOKEN
          ? "env"
          : storedAuth
            ? "local_state"
            : "none",
        auth_hint: authHint(authenticated),
        account: storedAuth?.account ?? null,
        token_expires_at: storedAuth?.expires_at ?? null,
        pending_device_auth: pendingAuth,
        agent_identity: toPublicAgentIdentity(
          currentAgentIdentity ?? getStoredAgentIdentity(currentAgentIdentityKey),
        ),
        current_room: toPublicRoomState(currentRoom),
        saved_current_room: toPublicStoredRoomSession(savedCurrentRoom),
        detected_room_from_context: detectedRoom,
        configured_room_from_file: configRoom,
        configured_active_room_from_context: configGitContext?.activeRoomLocator ?? null,
        derived_repo_room_from_git: gitContext?.repoRoom ?? null,
        derived_active_git_room: gitContext?.activeRoomLocator ?? null,
        derived_branch_room_from_git: gitContext?.activeRefRoomLocator ?? null,
        git_current_branch: gitContext?.currentBranch ?? configGitContext?.currentBranch ?? null,
        git_default_branch: gitContext?.defaultBranch ?? configGitContext?.defaultBranch ?? null,
        repo_root: repoRoot,
        next_step: nextStep,
      });
    },
  );
}
