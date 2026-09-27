import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse, compileScript } from "@vue/compiler-sfc";
import ts from "typescript";
import * as Vue from "vue";
import { desktopUpdatePresentation } from "../src/domain/desktop-update-status";

type Host = { children: Host[]; parent: Host | null; props: Record<string, any>; text: string };
const node = (text = ""): Host => ({ children: [], parent: null, props: {}, text });
const renderer = Vue.createRenderer<Host, Host>({
  createElement: () => node(), createText: node, createComment: node,
  setText: (n, text) => { n.text = text; }, setElementText: (n, text) => { n.text = text; },
  patchProp: (n, key, _old, value) => { n.props[key] = value; },
  insert(n, parent, anchor) { n.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; if (at < 0) parent.children.push(n); else parent.children.splice(at, 0, n); },
  remove(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); },
  parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1] ?? null,
});
function all(root: Host): Host[] { return [root, ...root.children.flatMap(all)]; }
const find = (root: Host, id: string) => all(root).find(n => n.props["data-testid"] === id);
async function flush() { for (let i = 0; i < 4; i++) { await Promise.resolve(); await Vue.nextTick(); } }

async function component(maintenance: { getStatus(): Promise<{ held: boolean; ready: boolean }>; restart(resume: boolean): Promise<void> } | undefined) {
  const path = new URL("../src/components/desktop/settings/panes/SettingsUpdatesPane.vue", import.meta.url);
  const source = await readFile(path, "utf8");
  const descriptor = parse(source, { filename: path.pathname }).descriptor;
  const compiled = compileScript(descriptor, { id: "maintenance-test", inlineTemplate: true });
  const modules: Record<string, any> = {
    vue: Vue,
    "@lucide/vue": Object.fromEntries(["CircleCheck", "Download", "RefreshCw", "Sparkles", "TriangleAlert"].map(name => [name, { render: () => null }])),
    "../../../../ipc/index.js": { desktopIpc: { maintenance } },
    "../../../../domain/desktop-update-status": { desktopUpdatePresentation },
    "../SettingsRow.vue": { default: { render: () => null } },
  };
  const javascript = ts.transpileModule(compiled.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/import\s+\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];?/g, (_all, names: string, name: string) => {
      assert.ok(modules[name], `unexpected component dependency ${name}`);
      return `const {${names.replace(/\s+as\s+/g, ": ")}} = modules[${JSON.stringify(name)}];`;
    })
    .replace(/import\s+(\w+)\s+from\s+["']([^"']+)["'];?/g, (_all, binding: string, name: string) => {
      assert.ok(modules[name], `unexpected component dependency ${name}`);
      return `const ${binding} = modules[${JSON.stringify(name)}].default;`;
    }).replace("export default", "return");
  return Function("modules", javascript)(modules);
}

test("maintenance Settings refresh exposes resume after cold startup and coalesces button clicks", async () => {
  let ready = false; const actions: boolean[] = []; let finish!: () => void;
  const root = node();
  const pane = await component({ getStatus: async () => ({ held: true, ready }), restart: async resume => { actions.push(resume); await new Promise<void>(resolve => { finish = resolve; }); } });
  const app = renderer.createApp(pane, { appInfo: { platform: "darwin" }, updateStatus: null }); app.mount(root);
  try {
    await flush(); assert.equal(find(root, "resume-supervision"), undefined);
    const refresh = find(root, "refresh-service-status"); assert.ok(refresh);
    ready = true; await refresh.props.onClick(); await flush();
    assert.ok(find(root, "resume-supervision"));
    const force = find(root, "force-restart-service")!;
    const one = force.props.onClick(); const two = force.props.onClick(); await flush();
    assert.deepEqual(actions, [false]); assert.equal(force.props.disabled, true);
    finish(); await Promise.all([one, two]); await flush();
    const resume = find(root, "resume-supervision")!.props.onClick(); await flush();
    assert.deepEqual(actions, [false, true]); finish(); await resume;
  } finally { app.unmount(); }
});

test("maintenance Settings keeps force restart available and reports refusal without claiming success", async () => {
  const root = node(); const pane = await component({ getStatus: async () => ({ held: false, ready: false }), restart: async () => { throw new Error("Exact service could not be identified"); } });
  const app = renderer.createApp(pane, { appInfo: { platform: "darwin" }, updateStatus: null }); app.mount(root);
  try {
    await flush(); await find(root, "force-restart-service")!.props.onClick(); await flush();
    assert.match(all(root).map(n => n.text).join(" "), /Exact service could not be identified/);
    assert.equal(find(root, "force-restart-service")!.props.disabled, false);
    assert.equal(find(root, "resume-supervision"), undefined);
  } finally { app.unmount(); }
});


test("maintenance recovery remains reachable without room app info or daemon status", async () => {
  const actions: boolean[] = [];
  const root = node();
  const pane = await component({ getStatus: async () => { throw new Error("Service unavailable"); }, restart: async resume => { actions.push(resume); } });
  const app = renderer.createApp(pane, { appInfo: null, updateStatus: null }); app.mount(root);
  try {
    await flush();
    const force = find(root, "force-restart-service"); assert.ok(force);
    assert.equal(force.props.disabled, false);
    await force.props.onClick(); await flush();
    assert.deepEqual(actions, [false]);
    assert.equal(find(root, "resume-supervision"), undefined);
  } finally { app.unmount(); }
});

test("maintenance controls are absent when this desktop has no native capability", async () => {
  const root = node(); const pane = await component(undefined);
  const app = renderer.createApp(pane, { appInfo: null, updateStatus: null }); app.mount(root);
  try { await flush(); assert.equal(find(root, "force-restart-service"), undefined); }
  finally { app.unmount(); }
});
