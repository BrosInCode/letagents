import assert from "node:assert/strict";
import test from "node:test";

import type {
  DesktopManagedAgentPublicChangeSummary,
  DesktopRoomStorageState,
} from "../ipc-types.js";
import { publishManagedAgentChangeSummaryArtifact } from "../main/agents/managed-agent-change-summary-artifacts.js";
import type { StoredAgentSessionState } from "../main/agents/state.js";

test("cloud rooms publish change summary artifacts through the room artifacts API", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
    });
    return new Response(
      JSON.stringify({
        artifact: {
          identity_key: "git:change_summary:id:managed-agent:key:emmy/cedarvista:branch:feature/x",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await publishManagedAgentChangeSummaryArtifact({
      roomIdentifier: "github.com/example/repo",
      storage: cloudStorage(),
      workerSession: workerSession(),
      summary: publicSummary(),
      taskId: "task_1",
    });

    assert.equal(
      result?.artifactIdentityKey,
      "git:change_summary:id:managed-agent:key:emmy/cedarvista:branch:feature/x",
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rooms\/github\.com%2Fexample%2Frepo\/artifacts$/);

    const artifact = calls[0].body.artifact as Record<string, unknown>;
    assert.equal(artifact.provider, "git");
    assert.equal(artifact.kind, "change_summary");
    assert.equal(artifact.id, "managed-agent:key:emmy/cedarvista:branch:feature/x");
    assert.equal(artifact.ref, "feature/x");
    assert.equal(artifact.state, "updated");
    assert.equal(calls[0].body.task_id, "task_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cloud publish skips summaries that are not publishable", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const result = await publishManagedAgentChangeSummaryArtifact({
      roomIdentifier: "github.com/example/repo",
      storage: cloudStorage(),
      workerSession: workerSession(),
      summary: { ...publicSummary(), isGitRepo: false, error: "no repo" },
      taskId: null,
    });
    assert.equal(result, null);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function cloudStorage(): DesktopRoomStorageState {
  return {
    roomIdentifier: "github.com/example/repo",
    defaultMode: "cloud",
    overrideMode: "inherit",
    effectiveMode: "cloud",
    isLocalRoom: false,
    localRoom: null,
    databasePath: "/tmp/unused.sqlite",
    localFilesPath: "/tmp/unused",
  };
}

function workerSession(): StoredAgentSessionState {
  return {
    session_id: "agent_session_cloud_artifact",
    session_token: "token_cloud_artifact",
    room_id: "github.com/example/repo",
    session_kind: "worker",
    runtime: "claude-code:token",
    host_id: null,
    host_kind: null,
    host_label: null,
    liveness_capability: null,
    tool_bridge_id: null,
    actor_label: "CedarVista | Emmy's agent | Claude Code",
    agent_key: "emmy/cedarvista",
    agent_instance_id: "desktop-claude-code:token",
    display_name: "CedarVista",
    owner_label: "Emmy",
    ide_label: "Claude Code",
    repo_branch: "feature/x",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    last_seen_at: new Date(0).toISOString(),
    ended_at: null,
  };
}

function publicSummary(): DesktopManagedAgentPublicChangeSummary {
  return {
    providerId: "claude-code",
    repoBranch: "feature/x",
    changeScope: "working_tree",
    changedFileCount: 2,
    stagedFileCount: 1,
    unstagedFileCount: 1,
    untrackedFileCount: 0,
    additions: 5,
    deletions: 1,
    files: [],
    hiddenFileCount: 0,
    isGitRepo: true,
    updatedAt: new Date(0).toISOString(),
    error: null,
  };
}
