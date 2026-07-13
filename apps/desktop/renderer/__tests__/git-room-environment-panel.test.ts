import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let GitRoomEnvironmentPanel: object;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  GitRoomEnvironmentPanel = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/room-shell/GitRoomEnvironmentPanel.vue",
  )).default;
});

after(async () => {
  await vite?.close();
});

const room = {
  identifier: "github.com/BrosInCode/letagents:branch:feature/work-ledger",
  code: "",
  name: "letagents",
  displayName: "BrosInCode/letagents",
  role: "owner",
  authenticated: true,
  kind: "main",
  parentRoomId: null,
  focusKey: null,
  sourceTaskId: null,
  focusStatus: null,
  focusParentVisibility: null,
  focusActivityScope: null,
  focusGitHubEventRouting: null,
  focusSettings: null,
  focusArchivedAt: null,
  concludedAt: null,
  conclusionSummary: null,
  conclusionDetails: null,
  gitRoom: {
    repository: { fullName: "BrosInCode/letagents" },
    ref: { type: "branch", name: "feature/work-ledger", defaultBranch: "main" },
  },
};

const repoStatus = {
  rootPath: "/repo",
  isGitRepo: true,
  branch: "main",
  defaultBranch: "main",
  detached: false,
  changes: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  dirty: false,
  worktrees: [],
};

async function renderPanel(overrides: Record<string, unknown> = {}): Promise<string> {
  return renderToString(createSSRApp(GitRoomEnvironmentPanel, {
    room,
    repoStatus,
    gitRoomMatchesActiveRepo: true,
    roomArtifacts: [],
    githubEvents: null,
    ...overrides,
  }));
}

test("environment panel distinguishes unavailable changes from a verified clean tree", async () => {
  const html = await renderPanel();
  assert.match(html, /BrosInCode\/letagents/);
  assert.doesNotMatch(html, /<h2[^>]*>BrosInCode\/letagents<\/h2>/);
  assert.match(html, /feature\/work-ledger/);
  assert.match(html, /No checkout for feature\/work-ledger/);
  assert.match(html, /Create or open the feature\/work-ledger worktree/);
  assert.doesNotMatch(html, />\+0</);
  assert.doesNotMatch(html, />−0</);
});

test("environment panel renders a clean remote artifact without a local checkout", async () => {
  const html = await renderPanel({
    roomArtifacts: [{
      roomId: room.identifier,
      identityKey: "change:feature/work-ledger",
      provider: "git",
      kind: "change_summary",
      artifactId: "change_summary_clean",
      artifactNumber: null,
      title: "Work ledger clean",
      url: null,
      ref: "feature/work-ledger",
      state: "clean",
      detail: null,
      source: "task_workflow_artifact",
      firstSeenAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:02:00.000Z",
      linkedTaskIds: [],
    }],
  });

  assert.match(html, /data-available="true"/);
  assert.match(html, /Working tree clean/);
  assert.match(html, />Clean</);
  assert.doesNotMatch(html, /No checkout/);
});

test("environment panel renders the latest reported files as a work receipt", async () => {
  const html = await renderPanel({
    roomArtifacts: [{
      roomId: room.identifier,
      identityKey: "change:feature/work-ledger",
      provider: "git",
      kind: "change_summary",
      artifactId: "change_summary_1",
      artifactNumber: null,
      title: "Work ledger changes",
      url: null,
      ref: "feature/work-ledger",
      state: "dirty",
      detail: {
        type: "change_summary",
        version: 1,
        changedFileCount: 3,
        additions: 42,
        deletions: 7,
        stagedFileCount: 1,
        unstagedFileCount: 2,
        untrackedFileCount: 0,
        hiddenFileCount: 0,
        files: [{
          path: "apps/desktop/renderer/src/WorkLedger.vue",
          previousPath: null,
          status: "modified",
          additions: 32,
          deletions: 7,
          binary: false,
          staged: false,
          unstaged: true,
          untracked: false,
        }],
      },
      source: "task_workflow_artifact",
      firstSeenAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:01:00.000Z",
      linkedTaskIds: [],
    }],
  });

  assert.match(html, /data-available="true"/);
  assert.match(html, /3 files/);
  assert.match(html, />\+42</);
  assert.match(html, />−7</);
  assert.match(html, /WorkLedger\.vue/);
});
