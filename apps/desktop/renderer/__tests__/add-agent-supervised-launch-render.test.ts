import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  computed,
  createRenderer,
  createSSRApp,
  defineComponent,
  h,
  nextTick,
  ref,
  Fragment,
  type Component,
  type InjectionKey,
} from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";
import { AddAgentSupervisedLaunchActions } from "../src/components/desktop/content/add-agent/AddAgentSupervisedLaunchActions";

let vite: ViteDevServer;
let AddAgentSupervisedLaunch: Component;
let AddAgentActionBar: Component;
let managedAgentSessionsKey: InjectionKey<unknown>;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  AddAgentSupervisedLaunch = (
    await vite.ssrLoadModule(
      "/renderer/src/components/desktop/content/add-agent/AddAgentSupervisedLaunch.vue",
    )
  ).default;
  AddAgentActionBar = (
    await vite.ssrLoadModule(
      "/renderer/src/components/desktop/content/add-agent/AddAgentActionBar.vue",
    )
  ).default;
  managedAgentSessionsKey = (
    await vite.ssrLoadModule(
      "/renderer/src/components/desktop/content/add-agent/managed-agent-sessions-context.ts",
    )
  ).managedAgentSessionsKey;
});

after(async () => {
  await vite?.close();
});

function readyController() {
  const view = ref({
    ready: true,
    failed: false,
    stopped: false,
    stopFailed: false,
    status: "ready",
    agentName: "MapleRidge · request-ready",
    providerLabel: "Codex",
  });
  const conflict = ref({ provider: "codex" });
  const canAddAnotherCodexAgent = ref(true);
  let dismissCalls = 0;
  let stopCalls = 0;
  const launch = {
    view,
    conflict,
    canAddAnotherCodexAgent,
    stoppingEntryId: ref<string | null>(null),
    recoveryCandidate: ref(null),
    recoveringCandidate: ref(false),
    recoveryScanStatus: ref<"idle" | "checking" | "ready" | "error">("ready"),
    conflictLookupError: ref(null),
    conflictLookupTone: ref<"error" | "warning">("error"),
    handleRecover: () => undefined,
    detectRecoverableLaunch: () => undefined,
    dismiss: () => undefined,
    stop: () => { stopCalls += 1; },
    dismissReadyCodexLaunchForAnother: () => {
      dismissCalls += 1;
      view.value = null as never;
      conflict.value = null as never;
      canAddAnotherCodexAgent.value = false;
    },
  };
  return {
    controller: { launch, recoverableProviderName: computed(() => null) },
    release: launch.dismissReadyCodexLaunchForAnother,
    counts: () => ({ dismissCalls, stopCalls }),
  };
}

async function renderReadyLaunch(controller: ReturnType<typeof readyController>["controller"]): Promise<string> {
  const app = createSSRApp({
    render: () => h(Fragment, [
      h(AddAgentSupervisedLaunch, { controller }),
      h(AddAgentActionBar, {
        roomIdentifier: "room-1",
        providerId: "codex",
        provider: {
          id: "codex",
          name: "Codex",
          description: "",
          capabilities: ["desktop_managed_runtime", "supervised_runtime"],
          runtimeCommand: null,
          mcpTargetId: "codex",
          permissionProfiles: [],
          defaultPermissionProfileId: null,
        },
        preflight: { nextAction: null, status: "ready" },
        permissionProfile: null,
        launchMode: "supervised",
        setupBusy: false,
        setupActionLabel: "",
        copyingAuthCommand: false,
        canCreateWorktree: false,
        matchingWorktreeCount: 0,
        creatingWorktree: false,
        createWorktreeLabel: "",
        canStartBase: true,
        startingAgent: false,
        setupConfirmationActive: false,
        externalInstruction: null,
        permissionBlocker: null,
        permissionWarning: null,
        supervised: controller,
        charterMissing: false,
      }),
    ]),
  });
  app.provide(managedAgentSessionsKey, {
    sessions: ref([]),
    refresh: async () => undefined,
    upsert: () => undefined,
  });
  return renderToString(app);
}

interface HostNode {
  type: string;
  text: string;
  props: Record<string, unknown>;
  children: HostNode[];
  parent: HostNode | null;
}

function hostNode(type: string, text = ""): HostNode {
  return { type, text, props: {}, children: [], parent: null };
}

const testRenderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, next) { node.props[key] = next; },
  insert(child, parent, anchor) {
    child.parent = parent;
    if (!anchor) parent.children.push(child);
    else parent.children.splice(parent.children.indexOf(anchor), 0, child);
  },
  remove(child) {
    const index = child.parent?.children.indexOf(child) ?? -1;
    if (index >= 0) child.parent!.children.splice(index, 1);
    child.parent = null;
  },
  createElement(type) { return hostNode(type); },
  createText(text) { return hostNode("#text", text); },
  createComment(text) { return hostNode("#comment", text); },
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.text = text; node.children = []; },
  parentNode(node) { return node.parent; },
  nextSibling(node) {
    const siblings = node.parent?.children ?? [];
    return siblings[siblings.indexOf(node) + 1] ?? null;
  },
  querySelector() { return null; },
  setScopeId() { return undefined; },
  cloneNode(node) { return { ...node, props: { ...node.props }, children: [...node.children] }; },
  insertStaticContent(content, parent, anchor) {
    const node = hostNode("#static", content);
    node.parent = parent;
    if (!anchor) parent.children.push(node);
    else parent.children.splice(parent.children.indexOf(anchor), 0, node);
    return [node, node];
  },
});

function findByTestId(node: HostNode, testId: string): HostNode | null {
  if (node.props["data-testid"] === testId) return node;
  for (const child of node.children) {
    const match = findByTestId(child, testId);
    if (match) return match;
  }
  return null;
}

test("mounted ready Codex button dispatches dismiss and restores Start without stopping", async () => {
  const ready = readyController();
  const beforeRelease = await renderReadyLaunch(ready.controller);

  assert.match(beforeRelease, /desktop-add-agent-add-another-codex/);
  assert.match(beforeRelease, /Add another Codex agent/);
  assert.doesNotMatch(beforeRelease, /desktop-add-agent-stop-supervised-runtime/);
  assert.doesNotMatch(beforeRelease, />Start supervised agent</);

  const root = hostNode("root");
  const app = testRenderer.createApp(defineComponent({
    setup: () => () => ready.controller.launch.view.value
      ? h(AddAgentSupervisedLaunchActions, {
          progress: ready.controller.launch.view.value,
          canAddAnotherCodexAgent: ready.controller.launch.canAddAnotherCodexAgent.value,
          hasStopAction: Boolean(ready.controller.launch.conflict.value)
            && !ready.controller.launch.canAddAnotherCodexAgent.value,
          stopping: false,
          onAddAnother: ready.release,
          onStop: ready.controller.launch.stop,
          onDismiss: ready.controller.launch.dismiss,
        })
      : h("div", { "data-testid": "form-restored" }),
  }));
  app.mount(root);
  const button = findByTestId(root, "desktop-add-agent-add-another-codex");
  assert.ok(button, "the mounted eligible branch must contain Add another");
  const click = button.props.onClick;
  assert.equal(typeof click, "function");
  (click as () => void)();
  await nextTick();

  const afterRelease = await renderReadyLaunch(ready.controller);
  assert.equal(ready.counts().dismissCalls, 1);
  assert.equal(ready.counts().stopCalls, 0);
  assert.doesNotMatch(afterRelease, /desktop-add-agent-add-another-codex/);
  assert.match(afterRelease, />Start supervised agent</);
});
