import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  ssrContextKey,
  type Component,
} from "vue";
import * as Vue from "vue";
import { compileScript, compileTemplate, parse } from "@vue/compiler-sfc";
import { renderToString } from "@vue/server-renderer";
import { createServer, transformWithEsbuild, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let AddAgentSupervisedLaunch: Component;
let AddAgentActionBar: Component;
let AddAgentSetupStatus: Component;
let AddAgentRuntimeSettings: Component;
let AddAgentSupervisedLaunchActions: Component;
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
  AddAgentSetupStatus = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/add-agent/AddAgentSetupStatus.vue",
  )).default;
  AddAgentRuntimeSettings = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/add-agent/AddAgentRuntimeSettings.vue",
  )).default;
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
        providerId: "codex",
        provider: {
          id: "codex",
          name: "Codex",
          description: "",
          capabilities: ["supervised_runtime"],
          runtimeCommand: null,
          mcpTargetId: "codex",
          permissionProfiles: [],
          defaultPermissionProfileId: null,
        },
        preflight: { nextAction: null, status: "ready" },
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
  assert.doesNotMatch(beforeRelease, />Start agent</);

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
  assert.match(afterRelease, />Start agent</);
});

test("pre-durable failures are compact, actionable, and explicit that nothing changed", async () => {
  const failed = failedController();
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSupervisedLaunch, { controller: failed.controller }),
  }));

  assert.match(html, /Background service didn’t start/);
  assert.match(html, /No agent was created\. Your room and project are unchanged\./);
  assert.match(html, /supervised-launch-recovery/);
  assert.match(html, /Try again[\s\S]*?<\/button>/);
  assert.match(html, /desktop-add-agent-dismiss-launch/);
  assert.doesNotMatch(html, /Saving your agent/, "unreachable future steps should not remain in a terminal card");
  assert.match(html, /<summary[^>]*>Technical details<\/summary>/);
  assert.match(html, /<p tabindex="0" aria-label="Technical diagnostic"[^>]*>The local supervisor socket did not answer\./);
  assert.doesNotMatch(html.match(/<details[^>]*>/)?.[0] ?? "", /\bopen\b/, "raw diagnostics stay available without dominating recovery");
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
  assert.match(html, /Open Keychain Access[\s\S]*?<\/button>/);
  assert.match(html, /supervised-launch-keychain-retry/);
  assert.match(html, /Try again[\s\S]*?<\/button>/);
  assert.match(html, /desktop-add-agent-dismiss-launch/);
});

const setupPresentationProps = {
  providerName: "Codex",
  preflight: { status: "ready", nextAction: null },
  loading: false,
  error: null,
  statusTitle: "Choose how it works here",
  statusDescription: "Choose a model and give it a task.",
  runtimeLabel: "codex-cli 0.153.4",
  bridgeLabel: "Managed at launch",
  repoLabel: "/project",
  showSecureStorage: true,
  secureStorageLabel: "Available",
  secureStorageNeedsAttention: false,
  canOpenSecureStorage: false,
  showWorktrees: false,
  worktrees: [],
  worktreeDescription: "",
  authCommand: "codex login",
  installCommand: null,
};

test("successful setup keeps diagnostics collapsed and the launch form prominent", async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSetupStatus, setupPresentationProps, {
      default: () => h("textarea", { "aria-label": "First message" }),
      actions: () => h("button", "Start agent"),
    }),
  }));
  const details = html.match(/<details[^>]*>/)?.[0] || "";
  assert.ok(details);
  assert.doesNotMatch(details, /\bopen\b/);
  assert.doesNotMatch(html, /desktop-add-agent-status-header|status-pill|Choose how it works here/);
  assert.match(html, /<summary tabindex="0"[^>]*>Setup details<\/summary>/);
  assert.match(html, /codex-cli 0.153.4/);
  assert.ok(html.indexOf("First message") < html.indexOf("Start agent"));
});

test("setup problems expand diagnostics and retain their actionable instructions", async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSetupStatus, {
      ...setupPresentationProps,
      preflight: { status: "auth_required", nextAction: "authenticate" },
      statusTitle: "Sign in to Codex",
      statusDescription: "Sign in to your agent app, then check again.",
    }),
  }));
  assert.match(html, /<details[^>]*\bopen\b/);
  assert.match(html, /Sign in to Codex/);
  assert.match(html, /codex login/);
  assert.match(html, /Check again/);
});

test("a failed check says what to do in its own words, with no technical details toggle", async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSetupStatus, {
      ...setupPresentationProps,
      preflight: { status: "error", nextAction: null },
      statusTitle: "The Antigravity CLI needs an update.",
      statusDescription: "This computer has agy 1.5.10. LetAgents agents need 1.5.12 or newer: run `agy update`, then choose Check again.",
    }),
  }));
  assert.match(html, /run `agy update`/);
  assert.doesNotMatch(html, /Technical details/);
  // A load error keeps only the plain instruction: its raw text is not shown.
  const failedLoad = await renderToString(createSSRApp({
    render: () => h(AddAgentSetupStatus, {
      ...setupPresentationProps,
      error: "Couldn't load agent providers: ECONNREFUSED /tmp/daemon.sock",
      preflight: null,
      statusTitle: "Could not check the agent app",
    }),
  }));
  assert.match(failedLoad, /Check the agent app and selected project, then choose Check again\./);
  assert.doesNotMatch(failedLoad, /ECONNREFUSED|Technical details/);
});

test("supervisor failure is shown once alongside the installed agent version", async () => {
  const { controller, release } = readyController();
  release();
  controller.launch.recoveryScanStatus.value = "error";
  const detail = "The supervisor could not prepare its database.";
  const launch = { ...controller.launch, conflictLookupError: ref(detail) };
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSetupStatus, {
      ...setupPresentationProps,
      preflight: { status: "error", blockedBySupervisor: true },
      statusTitle: "Local supervisor unavailable", statusDescription: detail,
    }, {
      default: () => h(AddAgentSupervisedLaunch, {
        controller: { ...controller, launch }, supervisorErrorShown: true,
      }),
    }),
  }));
  assert.equal(html.split(detail).length, 2);
  assert.match(html, /codex-cli 0.153.4/);
  assert.match(html, /Check again/);
  assert.doesNotMatch(html, /Check the agent app|supervised-lookup-error/);
});

test("locked credentials remain visible even when provider preflight succeeds", async () => {
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentSetupStatus, {
      ...setupPresentationProps,
      secureStorageNeedsAttention: true,
      canOpenSecureStorage: true,
      secureStorageLabel: "Unlock required",
      statusTitle: "Unlock secure credential storage",
    }),
  }));
  assert.match(html, /<details[^>]*\bopen\b/);
  assert.match(html, /Unlock secure credential storage/);
  assert.match(html, /Open Keychain Access/);
});

test("collapsed access options still disclose the selected high-risk permissions", async () => {
  const profile = { id: "full-access", label: "Full access", risk: "high", status: "available", description: "Can run commands outside this project." };
  const html = await renderToString(createSSRApp({
    render: () => h(AddAgentRuntimeSettings, {
      provider: { id: "codex", capabilities: ["supervised_runtime"] },
      executionDescription: "Runs on this Mac.",
      charter: "Inspect this project.",
      permissionProfiles: [profile],
      selectedPermissionProfile: profile,
    }),
  }));
  const details = html.match(/<details[^>]*>/)?.[0] || "";
  assert.ok(details);
  assert.doesNotMatch(details, /\bopen\b/);
  assert.match(html, /<summary tabindex="0"[^>]*>[\s\S]*?Full access[\s\S]*?High risk[\s\S]*?<\/summary>/);
  assert.match(html, /<small[^>]*>First message<\/small>/);
});

/** Give an SSR-loaded SFC a client render so the host renderer can mount it. */
async function attachClientRender(component: object, modulePath: string): Promise<void> {
  const source = await readFile(fileURLToPath(new URL(`../src/${modulePath}`, import.meta.url)), "utf8");
  const descriptor = parse(source, { filename: modulePath }).descriptor;
  assert.ok(descriptor.template);
  const script = compileScript(descriptor, { id: modulePath });
  const compiled = compileTemplate({
    source: descriptor.template.content,
    filename: modulePath,
    id: modulePath,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  assert.deepEqual(compiled.errors, []);
  const clientCode = compiled.code
    .replace(/^import \{([\s\S]*?)\} from "vue"\n/, (_match, bindings: string) => `const {${bindings.replace(/\s+as\s+/g, ": ")}} = vue\n`)
    .replace("export function render", "function render");
  const transformed = await transformWithEsbuild(clientCode, `${modulePath}.ts`, { loader: "ts", target: "esnext" });
  (component as { render?: unknown }).render = Function("vue", `${transformed.code}\nreturn render;`)(Vue);
}

test("the private first message shows its exact failure and opens recorded Work without retrying", async () => {
  const modulePath = 'components/desktop/content/room-chat/RoomFirstMessage.vue';
  const FirstMessage = (await vite.ssrLoadModule(`/renderer/src/${modulePath}`)).default;
  const { composerAgentLaunchKey } = await vite.ssrLoadModule('/renderer/src/components/desktop/content/room-chat/composer-agent-launch.ts');
  const agent = ref({ id: 'first-agent', displayName: 'Endpoint QA', charter: 'Read the README.', createdAt: '2026-11-15T20:00:00Z',
    deliveryReceipts: [{ sourceMessageId: 'desktop-initial-message:first-agent', state: 'acknowledged_failed',
      error: 'Cannot connect to API. Authorization: Bearer secret-canary' }] });
  const host = { context: () => ({}), openAddAgent() {}, chooseWorktree() {}, openFirstMessageWork: (entryId: string) => { opened.push(entryId); } };
  const opened: string[] = [];
  const ssr = createSSRApp({ render: () => h(FirstMessage, { agent: agent.value }) });
  ssr.provide(composerAgentLaunchKey, host);
  const html = await renderToString(ssr);
  assert.match(html, /First message did not finish/);
  assert.match(html, /Cannot connect to API/);
  assert.match(html, /First message · Only you/);
  assert.doesNotMatch(html, /secret-canary|Retry|Try again/);
  await attachClientRender(FirstMessage, modulePath);
  const root = hostNode('root');
  const app = testRenderer.createApp({ setup: () => () => h(FirstMessage, { agent: agent.value }) });
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.provide(composerAgentLaunchKey, host);
  app.mount(root);
  const details = findByTestId(root, 'room-first-message-details');
  assert.ok(details);
  (details.props.onClick as () => void)();
  assert.deepEqual(opened, ['first-agent']);
  assert.equal(agent.value.deliveryReceipts[0]!.state, 'acknowledged_failed');
  agent.value = { ...agent.value, deliveryReceipts: [{ ...agent.value.deliveryReceipts[0]!, sourceMessageId: 'unrelated-message' }] };
  await nextTick();
  assert.equal(findByTestId(root, 'room-first-message-failure'), null, 'another ask cannot be attributed to this first message');
  agent.value = { ...agent.value, deliveryReceipts: [{ ...agent.value.deliveryReceipts[0]!, sourceMessageId: 'desktop-initial-message:first-agent', state: 'acknowledged' }] };
  await nextTick();
  assert.equal(findByTestId(root, 'room-first-message-failure'), null);
  app.unmount();
});

test("a first task set with only a change event survives choosing another access level", async () => {
  // Accessibility automation can set a textarea's value without an input
  // event. The access choice re-renders the form; it must not write the old
  // task back over the text.
  const sandboxed = { id: "sandboxed_write", label: "Workspace writes", risk: "medium", status: "available", description: "Edits a copy." };
  const fullAccess = { id: "full_access", label: "Full access", risk: "high", status: "available", description: "Host files and network." };
  const charter = ref("You are part of this room's team. Work on the tasks assigned to you, answer when you are addressed, and coordinate with the team in the room.");
  const selected = ref(sandboxed);
  await attachClientRender(AddAgentRuntimeSettings, "components/desktop/content/add-agent/AddAgentRuntimeSettings.vue");
  const FirstMessage = (await vite.ssrLoadModule('/renderer/src/components/desktop/content/add-agent/AddAgentFirstMessage.vue')).default;
  await attachClientRender(FirstMessage, 'components/desktop/content/add-agent/AddAgentFirstMessage.vue');

  const root = hostNode("root");
  const app = testRenderer.createApp(defineComponent({
    setup: () => () => h(AddAgentRuntimeSettings, {
      provider: { id: "cursor", capabilities: ["supervised_runtime"] },
      executionDescription: "Runs on this Mac.",
      charter: charter.value,
      permissionProfiles: [sandboxed, fullAccess],
      selectedPermissionProfile: selected.value,
      "onUpdate:charter": (value: string) => { charter.value = value; },
      onSelectPermission: (profile: typeof sandboxed) => { selected.value = profile; },
    }),
  }));
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(root);
  const field = findByTestId(root, "desktop-add-agent-supervised-charter");
  assert.ok(field);
  assert.equal(typeof field.props.onChange, "function", "the first task must listen for change events");
  (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "Review PR 4 at its latest head" } });
  selected.value = fullAccess;
  await nextTick();
  assert.equal(charter.value, "Review PR 4 at its latest head");
  assert.equal(findByTestId(root, "desktop-add-agent-supervised-charter")?.props.value, "Review PR 4 at its latest head");
  app.unmount();
});

test("Cursor access cards distinguish restricted profiles from Full access", async () => {
  const profiles = [
    { id: "read_only", label: "Read-only", risk: "low", status: "available", description: "Inspect only." },
    { id: "sandboxed_write", label: "Workspace writes", risk: "medium", status: "available", description: "Edits a copy." },
    { id: "full_access", label: "Full access", risk: "high", status: "available", description: "Host files and network." },
  ];
  for (const [index, selected] of profiles.entries()) {
    const html = await renderToString(createSSRApp({
      render: () => h(AddAgentRuntimeSettings, {
        provider: { id: "cursor", capabilities: ["supervised_runtime"] },
        executionDescription: "Runs on this Mac.", charter: "Inspect this project.",
        permissionProfiles: profiles, selectedPermissionProfile: selected,
      }),
    }));
    assert.equal((html.match(/role="radio"/g) ?? []).length, 3);
    const limits = [...html.matchAll(/data-testid="desktop-add-agent-permission-limits"[^>]*>([^<]*)</g)].map(match => match[1]);
    assert.equal(limits.length, 1, 'the selected access level has its provider-specific limit');
    if (index < 2) assert.match(limits[0], /No network access: can(?:&#39;|')t push or open PRs\./);
    else assert.match(limits[0], /can reach the network and files outside the project/);
  }
});

test("the model field says which Claude models need a newer CLI, and refreshes from the note", async () => {
  const AddAgentModelSettings = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/add-agent/AddAgentModelSettings.vue",
  )).default;
  const props = {
    loading: false, modelChoice: "default", modelOptions: [{ value: "default", label: "Use provider default" }],
    custom: false, customModelId: "", modelDescription: "Use the model configured by the provider app.",
    showEffort: false, effort: "", effortOptions: [], effortDescription: "",
    catalogLabel: "1 provider model available.", catalogError: false,
    cliUpdate: { message: "Fable 5.2 and Opus 5.5 need a newer Claude Code (installed: 2.1.278).", command: "claude update" },
  };
  const html = await renderToString(createSSRApp({ render: () => h(AddAgentModelSettings, props) }));
  const note = html.match(/<p[^>]*id="desktop-add-agent-model-cli-update"[^>]*>[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.match(note, /data-tone="status"/);
  assert.doesNotMatch(note, /role=/, "read with the Model field, not announced on its own each time the dialog opens");
  assert.match(note, /Fable 5\.2 and Opus 5\.5 need a newer Claude Code \(installed: 2\.1\.278\)\. Run <code[^>]*>claude update<\/code>, then\s*<button[^>]*type="button"[^>]*>refresh models<\/button>\.<\/p>/);
  assert.match(html, /aria-describedby="desktop-add-agent-model-description desktop-add-agent-model-cli-update"/);

  const refreshing = await renderToString(createSSRApp({ render: () => h(AddAgentModelSettings, { ...props, loading: true }) }));
  assert.match(refreshing, /<button[^>]*disabled[^>]*>refreshing…<\/button>/);
  // A catalog error is the one line shown there.
  const failed = await renderToString(createSSRApp({ render: () => h(AddAgentModelSettings, { ...props, catalogError: true, catalogLabel: "Claude Code did not answer." }) }));
  assert.match(failed, /role="alert"[^>]*>Claude Code did not answer\.<\/p>/);
  assert.doesNotMatch(failed, /need a newer Claude Code/);
  const current = await renderToString(createSSRApp({ render: () => h(AddAgentModelSettings, { ...props, cliUpdate: null }) }));
  assert.doesNotMatch(current, /desktop-add-agent-model-cli-update/);
});

test("custom model validation is visible and associated with its input only in custom mode", async () => {
  const AddAgentModelSettings = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/add-agent/AddAgentModelSettings.vue",
  )).default;
  const props = {
    loading: false, modelChoice: "custom", modelOptions: [{ value: "custom", label: "Custom model id" }],
    custom: true, customModelId: "", customModelError: "Enter a model ID or choose provider default.",
    modelDescription: "", showEffort: false, effort: "", effortOptions: [], effortDescription: "",
    catalogLabel: "", catalogError: false,
  };
  const render = (overrides = {}) => renderToString(createSSRApp({
    render: () => h(AddAgentModelSettings, { ...props, ...overrides }),
  }));
  const invalid = await render();
  assert.match(invalid, /<input[^>]*aria-invalid="true"[^>]*aria-describedby="desktop-add-agent-model-custom-error"/);
  assert.match(invalid, /<span[^>]*id="desktop-add-agent-model-custom-error"[^>]*role="alert"[^>]*>Enter a model ID or choose provider default\.<\/span>/);
  const valid = await render({ customModelId: "my-model", customModelError: null });
  assert.match(valid, /aria-invalid="false"/);
  assert.doesNotMatch(valid, /desktop-add-agent-model-custom-error/);
  const defaultMode = await render({ custom: false, modelChoice: "default", customModelError: null });
  assert.doesNotMatch(defaultMode, /desktop-add-agent-model-custom-(?:input|error)/);
});

test("failed launch keeps its cause and current step visible while phase history is optional and actions retain their owners", async () => {
  const failed = failedController();
  const progress = failed.controller.launch.view;
  progress.value.phases.unshift({ id: "checking_setup", label: "Checking setup", detail: "The provider is installed and signed in.", state: "done" });
  progress.value.durable = true;
  failed.controller.launch.conflict.value = { id: "saved-launch" } as never;
  let stopCalls = 0;
  failed.controller.launch.stop = () => { stopCalls += 1; };
  const progressModulePath = "components/desktop/content/SupervisedLaunchProgress.vue";
  const Progress = (await vite.ssrLoadModule(`/renderer/src/${progressModulePath}`)).default;
  await attachClientRender(Progress, progressModulePath);
  await attachClientRender(AddAgentSupervisedLaunch, "components/desktop/content/add-agent/AddAgentSupervisedLaunch.vue");

  const root = hostNode("root");
  const app = testRenderer.createApp({ render: () => h(AddAgentSupervisedLaunch, { controller: failed.controller }) });
  app.provide(ssrContextKey, { modules: new Set<string>() });
  app.mount(root);
  const failure = findByTestId(root, "supervised-launch-failure");
  assert.equal(failure?.props.role, "alert");
  assert.ok(findByTestId(root, "supervised-launch-phase-connecting_supervisor"));
  assert.equal(findByTestId(root, "supervised-launch-phase-checking_setup"), null);
  assert.equal(findByTestId(root, "supervised-launch-phase-saving_agent"), null);
  const toggle = findByTestId(root, "supervised-launch-progress-toggle");
  assert.ok(toggle);
  assert.equal(toggle.props["aria-expanded"], false);
  assert.ok(toggle.props["aria-controls"]);
  (toggle.props.onClick as () => void)();
  await nextTick();
  assert.equal(toggle.props["aria-expanded"], true);
  assert.ok(findByTestId(root, "supervised-launch-phase-checking_setup"));
  assert.ok(findByTestId(root, "supervised-launch-phase-connecting_supervisor"));
  assert.equal(findByTestId(root, "supervised-launch-phase-saving_agent"), null, "history must not imply an unreachable phase ran");
  progress.value = { ...progress.value, phases: progress.value.phases.map((phase) => ({ ...phase })) };
  await nextTick();
  assert.equal(toggle.props["aria-expanded"], true, "a fresh same-phase supervisor snapshot must preserve the user's open history");
  assert.ok(findByTestId(root, "supervised-launch-phase-checking_setup"));
  (toggle.props.onClick as () => void)();
  await nextTick();
  assert.equal(findByTestId(root, "supervised-launch-phase-checking_setup"), null);
  assert.ok(findByTestId(root, "supervised-launch-phase-connecting_supervisor"));
  (toggle.props.onClick as () => void)();
  await nextTick();
  progress.value = { ...progress.value, currentPhaseId: "saving_agent", phases: progress.value.phases.map((phase) => ({
    ...phase, state: phase.id === "saving_agent" ? "failed" : "done",
  })) };
  await nextTick();
  assert.equal(toggle.props["aria-expanded"], false, "a different failed phase resets history to its current step");
  assert.equal(findByTestId(root, "supervised-launch-phase-checking_setup"), null);
  assert.equal(findByTestId(root, "supervised-launch-phase-connecting_supervisor"), null);
  assert.ok(findByTestId(root, "supervised-launch-phase-saving_agent"));

  const recover = findByTestId(root, "supervised-launch-recovery");
  const cancel = findByTestId(root, "desktop-add-agent-stop-supervised-runtime");
  assert.ok(recover);
  assert.ok(cancel);
  assert.equal(cancel.parent?.parent, recover.parent, "Cancel and recovery share one action row without moving controller ownership");
  assert.equal(findByTestId(root, "desktop-add-agent-dismiss-launch"), null, "a saved launch retains stop, not pre-durable dismiss");
  (recover.props.onClick as () => void)();
  assert.deepEqual(failed.counts().recoverCalls, ["reconnect"]);
  assert.equal(stopCalls, 0);
  (cancel.props.onClick as () => void)();
  assert.equal(stopCalls, 1);
  assert.equal(progress.value.failed, true, "presentation does not manufacture a successful recovery");
  failed.controller.launch.recoveryPending.value = true;
  await nextTick();
  assert.equal(findByTestId(root, "supervised-launch-recovery")?.props.disabled, true);
  app.unmount();
});
