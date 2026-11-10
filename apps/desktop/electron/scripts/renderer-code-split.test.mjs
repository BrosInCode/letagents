import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

// Builds the renderer in memory (the real vite.config.ts, nothing written) and
// checks the chunk graph that Electron loads from disk.

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = resolve(desktopRoot, "../..");

/** Views a room's first paint does not need: none may be statically reachable from the entry. */
const onDemandViews = [
  "apps/desktop/renderer/src/components/desktop/content/SettingsView.vue",
  "apps/desktop/renderer/src/components/desktop/content/InboxView.vue",
  "apps/desktop/renderer/src/components/desktop/content/MyWorkView.vue",
  "apps/desktop/renderer/src/components/desktop/content/CompanyHome.vue",
  "apps/desktop/renderer/src/components/desktop/content/DesktopNewRoomModal.vue",
  "apps/desktop/renderer/src/components/desktop/content/AddAgentModal.vue",
  "apps/desktop/renderer/src/components/desktop/content/agent-inspector/AgentInspectorHost.vue",
  "apps/desktop/renderer/src/components/desktop/content/RoomBoardView.vue",
  "apps/desktop/renderer/src/components/desktop/content/RoomActivityTabView.vue",
  "apps/desktop/renderer/src/components/desktop/content/RoomEventsView.vue",
  "apps/desktop/renderer/src/components/desktop/content/RoomMemoryView.vue",
  "apps/desktop/renderer/src/components/desktop/content/RoomDetailsView.vue",
  "apps/desktop/renderer/src/components/desktop/content/RentMarketplaceView.vue",
  "apps/desktop/renderer/src/components/desktop/setup/FirstRunOnboardingView.vue",
  "apps/desktop/renderer/src/components/desktop/settings/panes/SettingsAgentsPane.vue",
  "shared/ui/connectors/ConnectorsPage.vue",
  "shared/ui/board/BoardWorkspace.vue",
  "shared/ui/board/BoardSettings.vue",
  "shared/rooms/RoomsDirectory.vue",
  "shared/ui/my-work/MyWork.vue",
];

/** A module id as a repository path with "/" separators, on Windows too. */
function repositoryPath(id) {
  return relative(repositoryRoot, id).replaceAll("\\", "/");
}

let built;
function renderer() {
  built ??= (async () => {
    const result = await build({
      root: desktopRoot,
      configFile: join(desktopRoot, "vite.config.ts"),
      logLevel: "error",
      build: { write: false, reportCompressedSize: false, chunkSizeWarningLimit: Infinity },
    });
    const output = (Array.isArray(result) ? result[0] : result).output;
    const chunks = new Map(output.filter((item) => item.type === "chunk").map((chunk) => [chunk.fileName, chunk]));
    const entry = [...chunks.values()].find((chunk) => chunk.isEntry);
    const staticClosure = new Set();
    const pending = [entry.fileName];
    while (pending.length) {
      const fileName = pending.pop();
      if (staticClosure.has(fileName)) continue;
      staticClosure.add(fileName);
      pending.push(...chunks.get(fileName).imports);
    }
    /** The chunk that holds a component's code: its script, not its style sub-modules. */
    const chunkOf = (path) => [...chunks.values()].find((chunk) => Object.keys(chunk.modules).some((id) => {
      const [file, query = ""] = id.split("?");
      return repositoryPath(file) === path && (query === "" || query.startsWith("vue&type=script"));
    }));
    const html = output.find((item) => item.fileName === "index.html").source;
    return { output, chunks, entry, staticClosure, chunkOf, html };
  })();
  return built;
}

test("views a room's first paint does not need are not statically reachable from the entry chunk", async () => {
  const { staticClosure, chunkOf } = await renderer();
  for (const view of onDemandViews) {
    const chunk = chunkOf(view);
    assert.ok(chunk, `${view} is in no chunk`);
    assert.ok(!staticClosure.has(chunk.fileName), `${view} is statically reachable from the entry (in ${chunk.fileName})`);
  }
});

test("each view the app opens on demand is a dynamic entry of its own", async () => {
  const { chunkOf } = await renderer();
  const owners = new Map();
  for (const view of onDemandViews.filter((path) => path.startsWith("apps/desktop/renderer/src/components/desktop/") && !path.includes("/panes/"))) {
    const chunk = chunkOf(view);
    assert.ok(chunk.isDynamicEntry, `${view} is not loaded with import()`);
    assert.equal(owners.get(chunk.fileName), undefined, `${view} shares ${chunk.fileName} with ${owners.get(chunk.fileName)}`);
    owners.set(chunk.fileName, view);
  }
});

test("the split views bring no stylesheet of their own: their styles stay in the entry CSS, in the old order", async () => {
  const { chunkOf, entry, output } = await renderer();
  for (const view of onDemandViews) {
    if (view.endsWith("RentMarketplaceView.vue")) continue; // was already split, with its own CSS
    const chunk = chunkOf(view);
    assert.deepEqual([...chunk.viteMetadata.importedCss], [], `${view} loads its own CSS`);
  }
  const entryCss = [...entry.viteMetadata.importedCss];
  assert.equal(entryCss.length, 1);
  const css = output.find((item) => item.fileName === entryCss[0]).source;
  // One rule from a view's scoped styles, and one from a stylesheet a view imports.
  assert.match(css, /\.settings-shell\b/);
  assert.match(css, /\.connector-detail \.primary-button/);
  // Pairs of rules with equal specificity where the later rule wins today. Loaded
  // as chunk CSS, a split view's stylesheet would come last and win instead. The
  // checks match the first rule with each selector (minified: `selector{`), not
  // the declarations, so a normal style change does not break them.
  const firstRule = (selector) => css.search(new RegExp(`(?:^|[{};])${selector}\\{`));
  const before = (first, second, protects) => {
    const a = firstRule(first);
    const b = firstRule(second);
    assert.ok(a >= 0, `No rule ${first} in the entry CSS. ${protects} If the rule was renamed on purpose, update this check.`);
    assert.ok(b >= 0, `No rule ${second} in the entry CSS. ${protects} If the rule was renamed on purpose, update this check.`);
    assert.ok(a < b, `${first} must come before ${second}. ${protects} A split view's styles moved out of the entry CSS or out of their import's place: keep them in the entry with "lazy-view-styles:" (vite.config.ts).`);
  };
  before(
    "\\.desktop-segmented-control\\[data-size=large\\]\\[data-v-[0-9a-f]+\\]",
    "\\.desktop-board-panel \\.desktop-board-segmented\\.desktop-segmented-control",
    "It keeps the board's own segmented-control look (global 06-task-board.css) over the control's default.",
  );
  before(
    "\\.knowledge-notice",
    "\\.inbox-desktop-detail",
    "It keeps inbox-view.css after room-knowledge.css, so the Inbox page padding wins over the shared one.",
  );
});

test("the built page and its dynamic imports use relative paths, as Electron loads them from file://", async () => {
  const { entry, html, chunks } = await renderer();
  assert.match(html, /<script type="module" crossorigin src="\.\/assets\/index-[\w-]+\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" crossorigin href="\.\/assets\/index-[\w-]+\.css">/);
  assert.doesNotMatch(html, /(src|href)="\/assets/);
  for (const chunk of chunks.values()) {
    assert.doesNotMatch(chunk.code, /["'`]\/assets\//, `${chunk.fileName} names an absolute /assets URL`);
  }
  const specifiers = [...entry.code.matchAll(/import\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((match) => match[1]);
  assert.ok(specifiers.length >= onDemandViews.length - 6);
  for (const specifier of specifiers) assert.match(specifier, /^\.\/[\w.-]+\.js$/);
});

test("the packaging script copies the whole renderer output, so every chunk ships", async () => {
  const script = await readFile(join(desktopRoot, "electron/scripts/package-artifact.mjs"), "utf8");
  const help = "The app loads split views from dist-renderer/assets at run time; the package must copy that whole folder, not a list of files.";
  const loop = script.match(/for \(const directory of \[([^\]]*)\]\)([\s\S]*?)\n\}/);
  assert.ok(loop, `package-artifact.mjs no longer copies its build folders in one loop. ${help}`);
  assert.match(loop[1], /"dist-renderer"/, `package-artifact.mjs does not copy dist-renderer. ${help}`);
  assert.match(loop[2], /\bcp\([\s\S]*recursive: true/, `package-artifact.mjs does not copy the folders recursively. ${help}`);
});
