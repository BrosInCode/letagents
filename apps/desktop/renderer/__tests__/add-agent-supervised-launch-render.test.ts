import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { computed, createSSRApp, h, ref, Fragment, type Component, type InjectionKey } from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";

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
  let dismissCalls = 0;
  let stopCalls = 0;
  const launch = {
    view,
    conflict,
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

test("rendered ready Codex action releases its local card and restores Start without stopping", async () => {
  const ready = readyController();
  const beforeRelease = await renderReadyLaunch(ready.controller);

  assert.match(beforeRelease, /desktop-add-agent-add-another-codex/);
  assert.match(beforeRelease, /Add another Codex agent/);
  assert.doesNotMatch(beforeRelease, /desktop-add-agent-stop-supervised-runtime/);
  assert.doesNotMatch(beforeRelease, />Start supervised agent</);

  // This is the exact handler wired to the rendered button. It clears only
  // local card state; the durable stop handler remains untouched.
  ready.release();
  const afterRelease = await renderReadyLaunch(ready.controller);
  assert.equal(ready.counts().dismissCalls, 1);
  assert.equal(ready.counts().stopCalls, 0);
  assert.doesNotMatch(afterRelease, /desktop-add-agent-add-another-codex/);
  assert.match(afterRelease, />Start supervised agent</);
});
