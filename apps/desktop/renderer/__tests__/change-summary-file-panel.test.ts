import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ChangeSummaryFilePanel: any;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ChangeSummaryFilePanel = (
    await vite.ssrLoadModule(
      "/renderer/src/components/desktop/content/room-activity/ChangeSummaryFilePanel.vue",
    )
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

function detail(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

async function render(props: Record<string, unknown>): Promise<string> {
  return renderToString(createSSRApp(ChangeSummaryFilePanel, props));
}

test("desktop change-summary panel renders collapsed with an accessible, singular disclosure", async () => {
  const html = await render({
    detail: detail(),
    expanded: false,
    listId: "change-files-0",
    label: "Agent on feature/y",
  });

  assert.ok(html.includes("6 files"), "headline shows changed file count");
  assert.ok(html.includes("+10") && html.includes("−2"), "headline shows totals");
  assert.ok(html.includes("src/a.ts"), "first file rendered");
  assert.ok(!html.includes("src/d.ts"), "4th file hidden when collapsed");
  assert.ok(html.includes("src/old.ts → src/b.ts"), "rename rendered as old → new");
  assert.ok(html.includes(">bin<"), "binary file marked");
  assert.ok(html.includes("2 more not shown"), "backend hidden-file note");
  assert.ok(html.includes('aria-controls="change-files-0"'), "disclosure controls the list id");
  assert.ok(
    html.includes("Show 1 more file for Agent on feature/y"),
    "singular, artifact-scoped aria-label",
  );
});

test("desktop change-summary panel renders a linked pull request", async () => {
  const html = await render({
    detail: detail(),
    expanded: false,
    listId: "change-files-0",
    label: "Agent on feature/y",
    linkedPullRequest: { number: 42, url: "https://github.com/x/y/pull/42", state: "open" },
  });
  assert.ok(html.includes("PR #42"), "PR link label rendered");
  assert.ok(html.includes('href="https://github.com/x/y/pull/42"'), "PR link href rendered");
  assert.ok(!html.includes("PR #42 ("), "open PR has no state suffix");
});

test("desktop change-summary panel labels a non-open linked PR with its state", async () => {
  const html = await render({
    detail: detail(),
    expanded: false,
    listId: "change-files-0",
    label: "Agent on feature/y",
    linkedPullRequest: { number: 42, url: "https://github.com/x/y/pull/42", state: "closed" },
  });
  assert.ok(html.includes("PR #42 (closed)"), "closed PR shows its state");
});

test("desktop change-summary panel shows all files and a collapse control when expanded", async () => {
  const html = await render({
    detail: detail(),
    expanded: true,
    listId: "change-files-0",
    label: "Agent on feature/y",
  });

  assert.ok(html.includes("src/d.ts"), "all files rendered when expanded");
  assert.ok(html.includes("Show fewer files"), "collapse control shown");
});

test("desktop change-summary panel hides the disclosure when files fit the collapsed limit", async () => {
  const html = await render({
    detail: detail({ changedFileCount: 2, hiddenFileCount: 0, files: [file({ path: "src/a.ts" }), file({ path: "src/b.ts" })] }),
    expanded: false,
    listId: "change-files-0",
    label: "Agent on feature/y",
  });

  assert.ok(!html.includes("more file"), "no disclosure when files <= collapsed limit");
});
