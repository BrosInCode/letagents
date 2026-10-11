import assert from "node:assert/strict";
import { readFile } from 'node:fs/promises';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import { transpileModule, ModuleKind } from 'typescript';
import * as Vue from 'vue';
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRenderer, createSSRApp, h, nextTick, ssrContextKey } from "vue";
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
  // As in the desktop component tests, attach client render functions to the
  // Vite-loaded production modules so handlers can run in a lightweight host.
  for (const path of [
    fileURLToPath(new URL('../src/components/room/activity/ActivityArtifactsPanel.vue', import.meta.url)),
    fileURLToPath(new URL('../../../shared/ui/agents/AgentChanges.vue', import.meta.url)),
    fileURLToPath(new URL('../../../shared/ui/agents/AgentDisclosure.vue', import.meta.url)),
  ]) {
    const component = (await vite.ssrLoadModule(path)).default;
    const descriptor = parse(await readFile(path, 'utf8')).descriptor;
    const script = compileScript(descriptor, { id: path });
    const template = compileTemplate({ source: descriptor.template!.content, filename: path, id: path, compilerOptions: { bindingMetadata: script.bindings } });
    assert.deepEqual(template.errors, []);
    const code = transpileModule(template.code, { compilerOptions: { module: ModuleKind.ESNext } }).outputText
      .replace(/import \{([\s\S]*?)\} from "vue";/g, (_all, names: string) => `const {${names.replace(/\s+as\s+/g, ': ')}} = vue;`)
      .replace('export function render', 'function render');
    component.render = Function('vue', code + '\nreturn render;')(Vue);
  }
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

function pullRequestArtifact(ref: string, artifactNumber: number | null, url: string | null) {
  return {
    room_id: "room_1",
    identity_key: `github:pull_request:${artifactNumber}:${url ?? "none"}`,
    provider: "github",
    kind: "pull_request",
    artifact_id: null,
    artifact_number: artifactNumber,
    title: `PR #${artifactNumber}`,
    url,
    ref,
    state: "open",
    detail: null,
    source: "github_event",
    first_seen_at: "2026-07-02T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    linked_task_ids: [],
  };
}

type PrRepoScope = { host: string; owner: string; name: string } | null
// Exercise the real disclosure before checking its file/PR contents. Closed
// Changes rows intentionally mount their details only on first expansion.
async function render(artifacts: unknown[], prRepo: PrRepoScope = null): Promise<string> {
  type Node = { tag: string; props: Record<string, any>; children: Node[]; text?: string; parent?: Node };
  const node = (tag = ''): Node => ({ tag, props: {}, children: [] });
  const renderer = createRenderer<Node, Node>({
    createElement: tag => node(tag), createText: text => ({ ...node(), text }), createComment: () => node(),
    setText(n, text) { n.text = text; }, setElementText(n, text) { n.children = []; n.text = text; },
    patchProp(n, key, _old, value) { n.props[key] = value; },
    insert(child, parent, anchor) { if (child.parent) { const i = child.parent.children.indexOf(child); if (i >= 0) child.parent.children.splice(i, 1); } child.parent = parent; const i = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(i < 0 ? parent.children.length : i, 0, child); },
    remove(n) { const i = n.parent?.children.indexOf(n) ?? -1; if (i >= 0) n.parent!.children.splice(i, 1); },
    parentNode: n => n.parent || null, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
  });
  const root = node('root');
  const app = renderer.createApp({ render: () => h(ActivityArtifactsPanel, { artifacts, tasks: [], prRepo }) });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(root);
  function all(n: Node): Node[] { return [n, ...n.children.flatMap(all)]; }
  try {
    for (const trigger of all(root).filter(n => n.props.class === 'agent-disclosure-trigger')) trigger.props.onClick({ detail: 0 });
    await nextTick();
    const escape = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    function html(n: Node): string {
      const text = (n.text === undefined ? '' : escape(n.text)) + n.children.map(html).join('');
      if (!n.tag) return text;
      const attrs = Object.entries(n.props).filter(([key, value]) => !key.startsWith('on') && value != null).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
      return `<${n.tag}${attrs}>${text}</${n.tag}>`;
    }
    return html(root);
  } finally { app.unmount(); }
}

const REPO = { host: "github.com", owner: "octo", name: "repo" };
const prIn = (n: number) => `https://github.com/octo/repo/pull/${n}`;
const hasLink = (html: string) => html.includes("activity-artifact-changes-pr");

test("change_summary panel links a same-repo same-branch PR (open-preferred, latest)", async () => {
  const html = await render(
    [
      changeArtifact(), // ref feature/y
      pullRequestArtifact("feature/y", 11, prIn(11)),
      { ...pullRequestArtifact("feature/y", 15, prIn(15)), state: "closed" }, // higher but closed
    ],
    REPO,
  );
  assert.ok(hasLink(html), "change-summary PR link rendered");
  assert.ok(html.includes("· PR #11"), "open PR #11 preferred over closed #15");
  assert.ok(!html.includes("· PR #15"), "closed higher-number PR not chosen");
});

test("change_summary panel labels a lone non-open linked PR with its state", async () => {
  const html = await render(
    [changeArtifact(), { ...pullRequestArtifact("feature/y", 42, prIn(42)), state: "closed" }],
    REPO,
  );
  assert.ok(html.includes("· PR #42 (closed)"), "closed PR labeled with state");
});

test("change_summary panel shows no PR link when branch or repo differs, or repo unknown", async () => {
  assert.ok(!hasLink(await render([changeArtifact(), pullRequestArtifact("other", 42, prIn(42))], REPO)), "branch differs");
  assert.ok(
    !hasLink(await render([changeArtifact(), pullRequestArtifact("feature/y", 42, "https://github.com/other/repo/pull/42")], REPO)),
    "repo differs",
  );
  assert.ok(!hasLink(await render([changeArtifact(), pullRequestArtifact("feature/y", 42, prIn(42))], null)), "repo unknown");
});

test("change_summary panel rejects a deceptive host and a URL whose number disagrees", async () => {
  assert.ok(
    !hasLink(await render([changeArtifact(), pullRequestArtifact("feature/y", 42, "https://evil.example/octo/repo/pull/42")], REPO)),
    "deceptive host",
  );
  assert.ok(
    !hasLink(await render([changeArtifact(), pullRequestArtifact("feature/y", 42, prIn(99))], REPO)),
    "URL number disagrees with artifact number",
  );
});

test("change_summary panel excludes candidates missing a number or URL", async () => {
  assert.ok(!hasLink(await render([changeArtifact(), pullRequestArtifact("feature/y", null, prIn(5))], REPO)), "number-only missing");
  assert.ok(!hasLink(await render([changeArtifact(), pullRequestArtifact("feature/y", 5, null)], REPO)), "url missing");
});

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

// The Agents archive uses the same production components as desktop, including
// the task->Changes entry point and contributor-aware Work search.
test('history search finds work through every linked contributor and owner', async () => {
  const History = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../shared/ui/agents/AgentHistory.vue', import.meta.url)))).default;
  const { mergeHistoryWork } = await import('../../../shared/ui/agents/types');
  const people = [
    { id: 'one', name: 'OwlMoon', kind: 'agent', owner: 'EmmyMay', provider: 'Codex', room: 'sky-lake', firstSeen: null, lastSeen: null, past: true },
    { id: 'two', name: 'StoneFox', kind: 'agent', owner: 'Ada', provider: 'Claude Code', room: 'sky-lake', branch: 'feature/usage', firstSeen: null, lastSeen: null, past: false },
  ];
  const work = mergeHistoryWork(people.map(person => ({ id: 'task_7', title: 'Wire real usage', people: [person.id], byline: person.name, state: 'merged', time: '2026-10-10T12:00:00Z', links: [] })));
  assert.equal(work.length, 1);
  for (const query of ['Ada', 'StoneFox', 'feature/usage', 'task_7']) {
    const html = await renderToString(createSSRApp(History, { mode: 'history', tab: 'Work', query, people, work }));
    assert.match(html, /Wire real usage/, query);
    assert.doesNotMatch(html, /No matching work/, query);
  }
});

test('Past agents excludes active agents and humans without losing them from People', async () => {
  const History = (await vite.ssrLoadModule(fileURLToPath(new URL('../../../shared/ui/agents/AgentHistory.vue', import.meta.url)))).default;
  const people = [
    { id: 'past', name: 'PastOwl', kind: 'agent', owner: '', provider: 'Codex', room: 'sky-lake', firstSeen: null, lastSeen: null, past: true },
    { id: 'live', name: 'LiveFox', kind: 'agent', owner: '', provider: 'Codex', room: 'sky-lake', firstSeen: null, lastSeen: null, past: false },
    { id: 'human', name: 'HumanEmmy', kind: 'human', owner: '', provider: '', room: 'sky-lake', firstSeen: null, lastSeen: null, past: true },
  ];
  const past = await renderToString(createSSRApp(History, { mode: 'past', query: '', people, work: [] }));
  assert.match(past, /PastOwl/);
  assert.doesNotMatch(past, /LiveFox|HumanEmmy/);
  const history = await renderToString(createSSRApp(History, { mode: 'history', tab: 'People', query: '', people, work: [] }));
  for (const person of people) assert.ok(history.includes(person.name));
});

test('web roster does not turn assigned tasks or stale provider state into live work', async () => {
  const Live = (await vite.ssrLoadModule('/src/components/room/activity/ActivityLiveView.vue')).default;
  const agents = [
    { key: 'idle', label: 'IdleFox', kind: 'agent', ownerLabel: 'Emmy', ideLabel: 'Codex', activityState: 'away', freshness: 'active', status: 'idle', currentTasks: [{ title: 'Assigned work' }], activeReasoning: [] },
    { key: 'stale', label: 'StaleOwl', kind: 'agent', ownerLabel: 'Emmy', ideLabel: 'Codex', activityState: 'active', freshness: 'stale', status: 'working', activeReasoning: [] },
  ];
  const html = await renderToString(createSSRApp(Live, { participants: agents, connectedAgents: agents, recentlyDisconnectedAgents: [], humans: [], selectedParticipant: agents[0], selectedParticipantKey: 'idle', clearedLiveCount: 0, canManageParticipants: false, clearBusy: false, taskGithubStatus: {}, roomIdentifier: '', activeWakeRules: new Map(), recentWakeRules: new Map(), wakeRuleApi: null }));
  assert.match(html, /Updates delayed/);
  assert.match(html, /Working <span>0<\/span>/);
  assert.match(html, /Online/);
  assert.doesNotMatch(html, /<dialog[^>]*\sopen(?:[\s>])/);
});


test('Changes groups compact collapsed rows, searches metadata and never prints internal identities', async () => {
  const { agentChange, groupChanges } = await import('../../../shared/ui/agents/changes');
  const artifacts = [changeArtifact(), { ...pullRequestArtifact('feature/y', 7, prIn(7)), updated_at: '2026-07-01T10:00:00Z', state: 'merged' }];
  const html = await renderToString(createSSRApp(ActivityArtifactsPanel, { artifacts, tasks: [] }));
  assert.equal((html.match(/class="agents-record-day"/g) || []).length, 2);
  assert.equal((html.match(/aria-expanded="false"/g) || []).length, 2);
  assert.doesNotMatch(html, /managed-agent:key|Task workflow|first seen|linked task|src\/a.ts/);
  assert.match(html, /Pull request #7 · GitHub/);
  const empty = await renderToString(createSSRApp(ActivityArtifactsPanel, { artifacts, tasks: [], query: 'missing' }));
  assert.match(empty, /No matching changes/);
  const record = agentChange({ id: 'internal', kind: 'change_summary', provider: 'git', tasks: ['Room motion'], state: 'updated', time: '2026-10-10T10:00:00', title: null });
  assert.equal(record.title, 'Changes');
  const groups = groupChanges([record], 'room motion', new Date('2026-10-11T12:00:00'));
  assert.equal(groups[0]?.day, 'Yesterday');
  assert.equal(groupChanges([record], 'missing').length, 0);
  assert.equal(groupChanges([{ ...record, time: 'invalid' }], '')[0]?.day, 'Date not recorded');
});
