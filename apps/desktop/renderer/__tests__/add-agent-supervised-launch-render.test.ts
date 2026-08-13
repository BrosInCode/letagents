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

let vite: ViteDevServer;
let AddAgentSupervisedLaunch: Component;
let AddAgentActionBar: Component;
let AddAgentSupervisedLaunchActions: Component;
let managedAgentSessionsKey: InjectionKey<unknown>;
let actionStyleNames: Record<string, string>;
let compiledActionCss: string;

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
  AddAgentSupervisedLaunchActions = (
    await vite.ssrLoadModule(
      "/renderer/src/components/desktop/content/add-agent/AddAgentSupervisedLaunchActions.ts",
    )
  ).AddAgentSupervisedLaunchActions;
  actionStyleNames = (
    await vite.ssrLoadModule(
      "/renderer/src/components/desktop/content/add-agent/AddAgentSupervisedLaunchActions.module.css",
    )
  ).default;
  compiledActionCss = (
    await vite.ssrLoadModule(
      "/renderer/src/components/desktop/content/add-agent/AddAgentSupervisedLaunchActions.module.css?inline",
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
    phases: [],
    currentPhaseId: "ready",
    ready: true,
    failed: false,
    stopped: false,
    stopFailed: false,
    status: "ready",
    durable: true,
    agentName: "MapleRidge · request-ready",
    providerLabel: "Codex",
    headline: "MapleRidge joined the room",
    failureDetail: null,
    failureImpact: null,
    failureDiagnostic: null,
    recovery: null,
    joinHint: null,
  });
  const conflict = ref({ provider: "codex" });
  const canAddAnotherSupervisedAgent = ref(true);
  let dismissCalls = 0;
  let stopCalls = 0;
  const launch = {
    view,
    conflict,
    canAddAnotherSupervisedAgent,
    stoppingEntryId: ref<string | null>(null),
    recoveryCandidate: ref(null),
    recoveringCandidate: ref(false),
    recoveryScanStatus: ref<"idle" | "checking" | "ready" | "error">("ready"),
    recoveryPending: ref(false),
    conflictLookupError: ref(null),
    conflictLookupTone: ref<"error" | "warning">("error"),
    handleRecover: () => undefined,
    detectRecoverableLaunch: () => undefined,
    dismiss: () => undefined,
    stop: () => { stopCalls += 1; },
    dismissReadyLaunchForAnother: () => {
      dismissCalls += 1;
      view.value = null as never;
      conflict.value = null as never;
      canAddAnotherSupervisedAgent.value = false;
    },
  };
  return {
    controller: { launch, recoverableProviderName: computed(() => null) },
    release: launch.dismissReadyLaunchForAnother,
    counts: () => ({ dismissCalls, stopCalls }),
  };
}

function failedController() {
  const recoverCalls: string[] = [];
  let dismissCalls = 0;
  const launch = {
    view: ref({
      phases: [
        {
          id: "connecting_supervisor",
          label: "Starting the background service",
          detail: "Opening the local service that keeps room agents running.",
          state: "failed",
        },
        {
          id: "saving_agent",
          label: "Saving your agent",
          detail: "Recording this agent so setup can continue if you close the app.",
          state: "pending",
        },
      ],
      currentPhaseId: "connecting_supervisor",
      status: "blocked",
      durable: false,
      ready: false,
      failed: true,
      stopped: false,
      stopFailed: false,
      agentName: null,
      providerLabel: "Open Model",
      headline: "Background service didn’t start",
      failureDetail: "LetAgents couldn’t start the local service that manages room agents.",
      failureImpact: "No agent was created. Your room and project are unchanged.",
      failureDiagnostic: "The local supervisor socket did not answer.",
      recovery: "reconnect",
      joinHint: null,
    }),
    conflict: ref(null),
    canAddAnotherSupervisedAgent: ref(false),
    stoppingEntryId: ref<string | null>(null),
    recoveryCandidate: ref(null),
    recoveringCandidate: ref(false),
    recoveryPending: ref(false),
    recoveryScanStatus: ref<"idle" | "checking" | "ready" | "error">("ready"),
    conflictLookupError: ref(null),
    conflictLookupTone: ref<"error" | "warning">("error"),
    handleRecover: (action: string) => { recoverCalls.push(action); },
    detectRecoverableLaunch: () => undefined,
    dismiss: () => { dismissCalls += 1; },
    stop: () => undefined,
    dismissReadyLaunchForAnother: () => undefined,
  };
  return {
    controller: { launch, recoverableProviderName: computed(() => null) },
    counts: () => ({ recoverCalls, dismissCalls }),
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

test("mounted ready supervised button dispatches dismiss and restores Start without stopping", async () => {
  const ready = readyController();
  const beforeRelease = await renderReadyLaunch(ready.controller);

  assert.match(beforeRelease, /desktop-add-agent-add-another-supervised/);
  assert.match(beforeRelease, /Add another Codex agent/);
  assert.doesNotMatch(beforeRelease, /desktop-add-agent-stop-supervised-runtime/);
  assert.doesNotMatch(beforeRelease, />Start supervised agent</);

  const root = hostNode("root");
  const app = testRenderer.createApp(defineComponent({
    setup: () => () => ready.controller.launch.view.value
      ? h(AddAgentSupervisedLaunchActions, {
          progress: ready.controller.launch.view.value,
          canAddAnotherSupervisedAgent: ready.controller.launch.canAddAnotherSupervisedAgent.value,
          providerName: "Codex",
          hasStopAction: Boolean(ready.controller.launch.conflict.value)
            && !ready.controller.launch.canAddAnotherSupervisedAgent.value,
          stopping: false,
          onAddAnother: ready.release,
          onStop: ready.controller.launch.stop,
          onDismiss: ready.controller.launch.dismiss,
        })
      : h("div", { "data-testid": "form-restored" }),
  }));
  app.mount(root);
  const button = findByTestId(root, "desktop-add-agent-add-another-supervised");
  assert.ok(button, "the mounted eligible branch must contain Add another");
  const actionContainer = button.parent;
  assert.ok(actionContainer);
  assert.equal(actionContainer.props.class, actionStyleNames.actions);
  assert.ok(String(button.props.class).includes(actionStyleNames.button));
  assert.match(compiledActionCss, new RegExp(`\\.${actionStyleNames.button.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*\\{`));
  assert.match(compiledActionCss, /:hover:not\(:disabled\)/);
  assert.match(compiledActionCss, /\.\S+:disabled/);
  assert.match(compiledActionCss, /prefers-reduced-motion: reduce/);
  const click = button.props.onClick;
  assert.equal(typeof click, "function");
  (click as () => void)();
  await nextTick();

  const afterRelease = await renderReadyLaunch(ready.controller);
  assert.equal(ready.counts().dismissCalls, 1);
  assert.equal(ready.counts().stopCalls, 0);
  assert.doesNotMatch(afterRelease, /desktop-add-agent-add-another-supervised/);
  assert.match(afterRelease, />Start supervised agent</);
});

test("pre-durable failures are compact, actionable, and explicit that nothing changed", async () => {
  const failed = failedController();
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSupervisedLaunch, { controller: failed.controller }),
  }));

  assert.match(html, /Background service didn’t start/);
  assert.match(html, /No agent was created\. Your room and project are unchanged\./);
  assert.match(html, /supervised-launch-recovery/);
  assert.match(html, /Try again<\/button>/);
  assert.match(html, /desktop-add-agent-dismiss-launch/);
  assert.doesNotMatch(html, /Saving your agent/, "unreachable future steps should not remain in a terminal card");
  assert.match(html, /<summary[^>]*>Details<\/summary>/);
});

test("Keychain failures render self-service recovery and a separate retry", async () => {
  const failed = failedController();
  Object.assign(failed.controller.launch.view.value, {
    currentPhaseId: "saving_agent",
    headline: "Unlock Keychain to finish setup",
    failureDetail: "LetAgents needs access to your Mac login keychain to save this agent securely.",
    recovery: "open_keychain",
  });
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSupervisedLaunch, { controller: failed.controller }),
  }));

  assert.match(html, /Unlock Keychain to finish setup/);
  assert.match(html, /Open Keychain Access<\/button>/);
  assert.match(html, /supervised-launch-keychain-retry/);
  assert.match(html, /Try again<\/button>/);
  assert.match(html, /desktop-add-agent-dismiss-launch/);
});
