import assert from "node:assert/strict";
import test from "node:test";

import type {
  DesktopManagedAgentChangeSummary,
  DesktopManagedAgentPublicChangeSummary,
  DesktopRoomStorageState,
} from "../ipc-types.js";
import { buildManagedAgentChangeSummaryAttachmentDraft } from "../main/agents/managed-agent-change-attachments.js";
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

    // The change set (file paths + counts) rides along as structured detail.
    const detail = artifact.detail as Record<string, unknown>;
    assert.equal(detail.type, "change_summary");
    assert.equal(detail.version, 1);
    assert.equal(detail.changedFileCount, 2);
    assert.equal(detail.additions, 5);
    assert.equal(detail.deletions, 1);
    const files = detail.files as Array<Record<string, unknown>>;
    assert.equal(files.length, 2);
    assert.equal(files[0].path, "src/api/db/schema/artifacts.ts");
    assert.equal(files[0].additions, 4);
    assert.equal(files[0].deletions, 1);
    // Detail is a summary only — it must never carry source content.
    assert.equal(
      JSON.stringify(detail).includes("content"),
      false,
      "change summary detail must not contain code/content",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clean worktree publishes a change summary artifact without file detail", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") });
    return new Response(
      JSON.stringify({ artifact: { identity_key: "git:change_summary:id:clean" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    await publishManagedAgentChangeSummaryArtifact({
      roomIdentifier: "github.com/example/repo",
      storage: cloudStorage(),
      workerSession: workerSession(),
      summary: {
        ...publicSummary(),
        changedFileCount: 0,
        stagedFileCount: 0,
        unstagedFileCount: 0,
        additions: 0,
        deletions: 1,
        files: [],
      },
      taskId: null,
    });

    const artifact = calls[0].body.artifact as Record<string, unknown>;
    assert.equal(artifact.state, "clean");
    assert.equal(artifact.detail, undefined);
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

test("legacy change-summary attachment caps files at 20 while the artifact keeps the full set", () => {
  const files = Array.from({ length: 25 }, (_value, index) => ({
    path: `src/f${index}.ts`,
    previousPath: null,
    status: "modified" as const,
    additions: 1,
    deletions: 0,
    binary: false,
    staged: false,
    unstaged: true,
    untracked: false,
  }));
  const summary: DesktopManagedAgentChangeSummary = {
    sessionId: "session_1",
    providerId: "claude-code",
    repoRootPath: "/tmp/repo",
    repoBranch: "feature/x",
    changedFileCount: 25,
    stagedFileCount: 0,
    unstagedFileCount: 25,
    untrackedFileCount: 0,
    additions: 25,
    deletions: 0,
    files,
    hiddenFileCount: 0,
    isGitRepo: true,
    updatedAt: new Date(0).toISOString(),
    error: null,
  };

  const draft = buildManagedAgentChangeSummaryAttachmentDraft(summary);
  assert.ok(draft);
  const parsed = JSON.parse(draft.buffer.toString("utf8")) as {
    summary: { files: unknown[]; hiddenFileCount: number };
  };
  assert.equal(parsed.summary.files.length, 20);
  assert.equal(parsed.summary.hiddenFileCount, 5);
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
    files: [
      {
        path: "src/api/db/schema/artifacts.ts",
        previousPath: null,
        status: "modified",
        additions: 4,
        deletions: 1,
        binary: false,
        staged: true,
        unstaged: false,
        untracked: false,
      },
      {
        path: "src/api/db/mappers.ts",
        previousPath: null,
        status: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
        staged: false,
        unstaged: true,
        untracked: false,
      },
    ],
    hiddenFileCount: 0,
    isGitRepo: true,
    updatedAt: new Date(0).toISOString(),
    error: null,
  };
}
