import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mainSource = readFileSync(
  fileURLToPath(new URL("../main/ipc.ts", import.meta.url)),
  "utf8",
);

const domainSources = {
  app: readDomainSource("app"),
  authSetup: readDomainSource("auth-setup"),
  rental: readDomainSource("rental"),
  rooms: readDomainSource("rooms"),
  repos: readDomainSource("repos"),
  supervisor: readDomainSource("supervisor"),
  workers: readDomainSource("workers"),
};

const expectedDirectChannels = [
  "desktop:app-agent:get-settings-status",
  "desktop:app-agent:list-actions",
  "desktop:app-agent:run",
  "desktop:app-agent:save-settings",
  "desktop:app:get-github-pull-request-stats",
  "desktop:app:get-info",
  "desktop:app:open-credential-storage",
  "desktop:app:open-external-url",
  "desktop:app:open-github-url",
  "desktop:auth:cancel-device-flow",
  "desktop:auth:get-status",
  "desktop:auth:open-verification",
  "desktop:auth:poll-device-flow",
  "desktop:auth:sign-out",
  "desktop:auth:start-device-flow",
  "desktop:chat-storage:create-local-room",
  "desktop:chat-storage:fork-room-to-local",
  "desktop:chat-storage:get-room-storage",
  "desktop:chat-storage:get-settings",
  "desktop:chat-storage:publish-local-room",
  "desktop:chat-storage:set-mode",
  "desktop:chat-storage:set-room-mode",
  "desktop:chat-storage:sync-local-room",
  "desktop:diagnostics:get-snapshot",
  "desktop:notifications:get-status",
  "desktop:notifications:set-enabled",
  "desktop:notifications:take-pending-activation",
  "desktop:open-model:get-settings-status",
  "desktop:open-model:save-settings",
  "desktop:repos:connect-project",
  "desktop:repos:create-worktree",
  "desktop:repos:get-status",
  "desktop:repos:list-project-bindings",
  "desktop:repos:migrate-project-bindings",
  "desktop:repos:open-room",
  "desktop:repos:pick-room",
  "desktop:repos:start-status-watch",
  "desktop:repos:stop-status-watch",
  "desktop:room:add-task",
  "desktop:room:archive-focus-room",
  "desktop:room:assign-board-manager",
  "desktop:room:conclude-focus-room",
  "desktop:room:create-ad-hoc-focus-room",
  "desktop:room:create-invite-room",
  "desktop:room:create-task-focus-room",
  "desktop:room:decide-board-intent",
  "desktop:room:delete-account-room",
  "desktop:room:discard-attachment",
  "desktop:room:get-artifacts",
  "desktop:room:get-board-governance",
  "desktop:room:get-github-events",
  "desktop:room:get-github-integration-status",
  "desktop:room:get-latest-messages",
  "desktop:room:get-live-metadata",
  "desktop:room:get-message",
  "desktop:room:get-message-info",
  "desktop:room:get-messages-before",
  "desktop:room:get-reasoning-session",
  "desktop:room:get-snapshot",
  "desktop:room:get-thread",
  "desktop:room:get-threads",
  "desktop:room:leave-account-room",
  "desktop:room:list-account-rooms",
  "desktop:room:mark-thread-read",
  "desktop:room:open-github-install",
  "desktop:room:pick-attachments",
  "desktop:room:release-board-manager",
  "desktop:room:rename",
  "desktop:room:repair-stream-delivery",
  "desktop:room:run-task-review-worker-action",
  "desktop:room:run-task-worker-action",
  "desktop:room:send-message",
  "desktop:room:set-board-manager-mode",
  "desktop:room:stage-dropped-attachment-contents",
  "desktop:room:start-stream",
  "desktop:room:stop-stream",
  "desktop:room:update-account-room",
  "desktop:room:update-focus-room-settings",
  "desktop:room:update-task",
  "desktop:room:update-task-lease",
  "desktop:room:update-task-review-lease",
  "desktop:setup:complete-mcp-onboarding",
  "desktop:setup:get-mcp-install-state",
  "desktop:setup:install-mcp-server",
  "desktop:setup:install-mcp-servers",
  "desktop:supervisor-grant:get",
  "desktop:supervisor-grant:get-storage-status",
  "desktop:supervisor-grant:provision",
  "desktop:supervisor-grant:revoke",
  "desktop:supervisor:commit-room-move",
  "desktop:supervisor:control-turn",
  "desktop:supervisor:create-agent",
  "desktop:supervisor:get-agent-configuration",
  "desktop:supervisor:get-agent-inspector-detail",
  "desktop:supervisor:get-current-room-move",
  "desktop:supervisor:get-launch-events",
  "desktop:supervisor:get-retirement-status",
  "desktop:supervisor:get-room-move",
  "desktop:supervisor:get-status",
  "desktop:supervisor:list-agents",
  "desktop:supervisor:prepare-room-move",
  "desktop:supervisor:purge-agent",
  "desktop:supervisor:read-attempt",
  "desktop:supervisor:reconnect-agent",
  "desktop:supervisor:recover-agent-runtime",
  "desktop:supervisor:resolve-turn-control",
  "desktop:supervisor:restore-agent-conversation",
  "desktop:supervisor:resume-ownership-transfer",
  "desktop:supervisor:retire-agent",
  "desktop:supervisor:retry-room-delivery",
  "desktop:supervisor:set-desired-state",
  "desktop:supervisor:skip-room-delivery",
  "desktop:supervisor:update-agent-configuration",
  "desktop:supervisor:watch-agent-stream",
  "desktop:updates:check",
  "desktop:updates:get-status",
  "desktop:updates:install",
  "desktop:workers:get-managed-agent-change-summary",
  "desktop:workers:inspect-managed-agent",
  "desktop:workers:list",
  "desktop:workers:list-agent-provider-models",
  "desktop:workers:list-agent-providers",
  "desktop:workers:list-managed-agent-sessions",
  "desktop:workers:resolve-managed-agent-permission",
  "desktop:workers:retry-managed-agent",
  "desktop:workers:run-agent-provider-preflight",
  "desktop:workers:run-agent-provider-setup",
  "desktop:workers:start-managed-agent",
  "desktop:workers:stop-managed-agent",
] as const;

function readDomainSource(domain: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../main/ipc-handlers/${domain}.ts`, import.meta.url)),
    "utf8",
  );
}

function registeredChannels(source: string): string[] {
  return Array.from(
    source.matchAll(/targetIpcMain\.handle\(\s*["']([^"']+)/g),
    (match) => match[1],
  );
}

test("desktop IPC composition root delegates without owning channel behavior", () => {
  assert.doesNotMatch(mainSource, /targetIpcMain\.handle/);
  for (const registrar of [
    "registerDesktopAuthAndSetupIpcHandlers",
    "registerDesktopAppIpcHandlers",
    "registerDesktopRoomIpcHandlers",
    "registerDesktopRentalDomainIpcHandlers",
    "registerDesktopRepoIpcHandlers",
    "registerDesktopSupervisorIpcHandlers",
    "registerDesktopWorkerIpcHandlers",
  ]) {
    assert.equal(
      mainSource.match(new RegExp(`${registrar}\\(targetIpcMain\\)`, "g"))?.length,
      1,
      `${registrar} must be composed exactly once`,
    );
  }
});

test("desktop IPC channels are unique across bounded domain registrars", () => {
  const channels = Object.values(domainSources).flatMap(registeredChannels);
  const duplicates = channels.filter(
    (channel, index) => channels.indexOf(channel) !== index,
  );

  assert.deepEqual(
    [...channels].sort(),
    expectedDirectChannels,
    "the native capability inventory changed",
  );
  assert.deepEqual(duplicates, []);
});

test("rental IPC domain delegates to the existing rental capability registrar", () => {
  assert.equal(
    domainSources.rental.match(
      /registerDesktopRentalIpcHandlers\(targetIpcMain,/g,
    )?.length,
    1,
  );
});

test("desktop IPC channel prefixes stay in their owning domains", () => {
  const expectedPrefixes: Record<keyof typeof domainSources, string[]> = {
    app: [
      "desktop:app:",
      "desktop:updates:",
      "desktop:notifications:",
      "desktop:app-agent:",
      "desktop:open-model:",
    ],
    authSetup: [
      "desktop:auth:",
      "desktop:setup:",
      "desktop:supervisor-grant:",
    ],
    rental: [],
    rooms: ["desktop:room:", "desktop:chat-storage:"],
    repos: ["desktop:repos:"],
    supervisor: ["desktop:supervisor:"],
    workers: ["desktop:workers:", "desktop:diagnostics:"],
  };

  for (const [domain, source] of Object.entries(domainSources) as Array<
    [keyof typeof domainSources, string]
  >) {
    for (const channel of registeredChannels(source)) {
      assert.ok(
        expectedPrefixes[domain].some((prefix) => channel.startsWith(prefix)),
        `${channel} is registered in the wrong IPC domain (${domain})`,
      );
    }
  }
});
