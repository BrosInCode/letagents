import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ActivityArtifactsPanel: any;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ActivityArtifactsPanel = (
    await vite.ssrLoadModule("/src/components/room/activity/ActivityArtifactsPanel.vue")
  ).default;
});

after(async () => {
  await vite?.close();
});

function file(overrides: Record<string, unknown> = {}) {
  return {
    path: "src/a.ts",
    previousPath: null,
    status: "modified",
    additions: 5,
    deletions: 1,
    binary: false,
    staged: false,
    unstaged: true,
    untracked: false,
    ...overrides,
  };
}

function changeArtifact(
  detailOverrides: Record<string, unknown> = {},
  identityKey = "git:change_summary:id:managed-agent:key:emmy/x:branch:feature/y",
) {
  return {
    room_id: "room_1",
    identity_key: identityKey,
    provider: "git",
    kind: "change_summary",
    artifact_id: "managed-agent:key:emmy/x:branch:feature/y",
    artifact_number: null,
    title: "Agent on feature/y",
    url: null,
    ref: "feature/y",
    state: "updated",
    detail: {
      type: "change_summary",
      version: 1,
      changedFileCount: 6,
      additions: 10,
      deletions: 2,
      stagedFileCount: 0,
      unstagedFileCount: 4,
      untrackedFileCount: 0,
      hiddenFileCount: 2,
      files: [
        file({ path: "src/a.ts", additions: 5, deletions: 1 }),
        file({ path: "src/b.ts", previousPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0 }),
        file({ path: "img.png", binary: true, additions: 0, deletions: 0 }),
        file({ path: "src/d.ts", additions: 3, deletions: 0 }),
      ],
      ...detailOverrides,
    },
    source: "task_workflow_artifact",
    first_seen_at: "2026-07-02T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    linked_task_ids: [],
  };
}

async function render(artifacts: unknown[]): Promise<string> {
  return renderToString(createSSRApp(ActivityArtifactsPanel, { artifacts, tasks: [] }));
}

test("change_summary panel: collapsed to 3 files with an accessible disclosure", async () => {
  const html = await render([changeArtifact()]);

  // Headline uses changedFileCount + / - totals.
  assert.ok(html.includes("6 files"), "headline shows changed file count");
  assert.ok(html.includes("+10"), "headline shows additions");
  assert.ok(html.includes("−2"), "headline shows deletions");

  // Collapsed to the first 3 files — the 4th must not render initially.
  assert.ok(html.includes("src/a.ts"), "first file rendered");
  assert.ok(!html.includes("src/d.ts"), "4th file hidden when collapsed");

  // Rename shown visibly, not tooltip-only.
  assert.ok(html.includes("src/old.ts → src/b.ts"), "rename rendered as old → new");

  // Binary file marked.
  assert.ok(html.includes(">bin<"), "binary file marked");

  // Backend-truncated note.
  assert.ok(html.includes("2 more not shown"), "backend hidden-file note rendered");

  // Accessible disclosure: aria-controls to the list id + descriptive, singular aria-label.
  assert.match(html, /aria-controls="[^"]*change-files-\d+"/, "disclosure controls the file list");
  assert.ok(
    html.includes("Show 1 more file for Agent on feature/y"),
    "descriptive, singular aria-label",
  );
});

test("change_summary panels get collision-safe distinct list ids", async () => {
  // Two artifacts whose refs would sanitize identically must still get distinct ids.
  const html = await render([
    changeArtifact({}, "git:change_summary:id:a:branch:feature/x"),
    changeArtifact({}, "git:change_summary:id:a:branch:feature-x"),
  ]);
  const ids = [...html.matchAll(/id="([^"]*change-files-\d+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2, "two file lists rendered");
  assert.equal(new Set(ids).size, 2, "the two list ids are distinct");
});

test("change_summary panel hides the disclosure when files fit within the collapsed limit", async () => {
  const html = await render([
    changeArtifact({
      changedFileCount: 2,
      hiddenFileCount: 0,
      files: [file({ path: "src/a.ts" }), file({ path: "src/b.ts" })],
    }),
  ]);

  assert.ok(html.includes("src/a.ts") && html.includes("src/b.ts"), "both files rendered");
  assert.ok(!html.includes("more files"), "no disclosure when files <= collapsed limit");
});
