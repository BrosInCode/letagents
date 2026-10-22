import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createRenderer,
  createSSRApp,
  h,
  markRaw,
  nextTick,
  reactive,
  ssrContextKey,
} from "vue";
import { renderToString } from "@vue/server-renderer";
import { createServer, type ViteDevServer } from "vite";
import {
  CONNECTORS_NOT_CONFIGURED_MESSAGE,
  type TrackerConnectionView,
} from "../../../../shared/ticket-connectors.mjs";
import type { ConnectorsApi } from "../../../../shared/ui/connectors/types";
import { remoteConnectorUrl } from "../src/components/desktop/settings/connectors.js";
let vite: ViteDevServer, Page: any, Details: any, Setup: any;
before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  for (const name of ["ConnectorsPage", "TrackerDetails", "TrackerSetup"]) {
    const component = (
      await vite.ssrLoadModule(
        fileURLToPath(
          new URL(
            `../../../../shared/ui/connectors/${name}.vue`,
            import.meta.url,
          ),
        ),
      )
    ).default;
    if (name === "ConnectorsPage") Page = component;
    else if (name === "TrackerDetails") Details = component;
    else Setup = component;
  }
});
after(async () => {
  await vite?.close();
});
function tracker(
  id = "one",
  provider: "jira" | "linear" | "github" = "jira",
): TrackerConnectionView {
  return {
    id,
    provider,
    display_name: "Acme",
    site_url: null,
    auth_kind: provider === "github" ? "github_app" : "api_token",
    tracker_user_id: "user1",
    tracker_user_label: "Emmy",
    status_map: { Open: "todo" },
    unmapped_statuses: [],
    jev_linking_enabled: false,
    status: "active",
    last_error: null,
    last_verified_at: null,
    created_at: "2026-10-22",
    updated_at: "2026-10-22",
  };
}
const available = {
  jira: { oauth: true, api_token: true },
  linear: { oauth: false, api_token: true },
  github: { oauth: false, api_token: false, github_app: true },
};
function api(): ConnectorsApi {
  return {
    trackers: {
      list: async () => ({
        connections: [tracker()],
        providers: available,
        jev_linking_disclosure: "Full server-provided consent.",
      }),
      saveApiToken: async () => tracker(),
      connectGitHub: async () => tracker("github", "github"),
      test: async (id) => ({
        ok: true,
        connection: tracker(id),
        items: [],
        error: null,
      }),
      update: async (id, patch) => ({ ...tracker(id), ...patch }),
      remove: async () => {},
      webhook: async () =>
        ({ url: "https://example.test/hook", secret: "test" }) as any,
      rules: {
        list: async () => ({ rules: [], rooms: [] }),
        create: async () => ({}) as any,
        update: async () => ({}) as any,
        setEnabled: async () => ({}) as any,
        versions: async () => [],
        rollback: async () => ({}) as any,
        remove: async () => {},
      },
    },
    remote: {
      list: async () => ({ connections: [] }),
      disconnect: async () => {},
    },
  };
}
const renderer = createRenderer<any, any>({
  patchProp() {},
  insert() {},
  remove() {},
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null,
});
async function mount(t: any, component: any, props: any) {
  const original = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, {
    window: {
      addEventListener() {},
      removeEventListener() {},
      letagentsDesktop: {
        connectors: api().trackers,
        mcpConnections: api().remote,
      },
    },
    document: { activeElement: null },
  });
  const reactiveProps = reactive(props);
  let vm: any;
  const emitted: any[] = [];
  const app = renderer.createApp({
    setup() {
      vm = component.setup(reactiveProps, {
        expose() {},
        emit: (...args: any[]) => emitted.push(args),
      });
      return () => h("div");
    },
  });
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount({});
  let closed = 0,
    opened = 0;
  if (vm.detailDialog)
    vm.detailDialog.value = markRaw({
      isConnected: true,
      showModal() {
        opened++;
      },
      close() {
        closed++;
      },
      querySelector() {
        return null;
      },
    });
  if (vm.catalogDialog)
    vm.catalogDialog.value = markRaw({
      showModal() {},
      close() {},
      querySelector() {
        return null;
      },
    });
  let active = true;
  const unmount = () => {
    if (active) {
      active = false;
      app.unmount();
    }
  };
  t.after(() => {
    unmount();
    Object.assign(globalThis, original);
  });
  await settle();
  return {
    vm,
    emitted,
    unmount,
    props: reactiveProps,
    closed: () => closed,
    opened: () => opened,
  };
}
async function settle() {
  for (let i = 0; i < 8; i++) await nextTick();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const pageProps = (transport = api()) => ({
  api: transport,
  agentTargets: [],
  desktop: false,
  remoteUrl: "https://example.test/mcp",
  initialTab: "all",
});

test("shared catalog has category tabs, individual provider assets and honest local configuration", async () => {
  const html = await renderToString(
    createSSRApp({
      render: () =>
        h(Page, {
          ...pageProps(),
          desktop: true,
          agentTargets: [
            {
              id: "codex",
              name: "Codex",
              status: "installed",
              configPaths: [],
              configPath: "~/.codex/config.toml",
            },
          ],
        }),
    }),
  );
  for (const label of [
    "All",
    "Trackers",
    "Agent apps",
    "Remote sign-ins",
    "Claude Code",
    "Codex",
    "Cursor",
    "Antigravity",
  ])
    assert.ok(html.includes(label), label);
  assert.match(html, /Configured/);
  assert.match(html, /codex\.png/);
  assert.doesNotMatch(html, /<table/);
});
test("not-configured server disables only trackers and errors are normalized", async (t) => {
  const transport = api();
  transport.trackers.list = async () => ({
    connections: [],
    providers: available,
    jev_linking_disclosure: "",
    not_configured: true,
  });
  const { vm } = await mount(t, Page, pageProps(transport));
  assert.equal(vm.notConfigured.value, true);
  assert.ok(
    vm.catalog.value
      .filter((row: any) => row.kind === "tracker")
      .every(
        (row: any) => row.unavailable === CONNECTORS_NOT_CONFIGURED_MESSAGE,
      ),
  );
  assert.ok(
    vm.catalog.value
      .filter((row: any) => row.kind !== "tracker")
      .every((row: any) => !row.unavailable),
  );
  transport.trackers.list = async () => {
    throw new Error(
      "Error invoking remote method 'desktop:connectors:list': DesktopApiError: Connection refused",
    );
  };
  await vm.refresh();
  assert.equal(vm.trackerError.value, "Connection refused");
});
test("stale list response cannot resurrect a removed tracker", async (t) => {
  const transport = api();
  const { vm } = await mount(t, Page, pageProps(transport));
  const pending = deferred<any>();
  transport.trackers.list = () => pending.promise;
  const loading = vm.refresh();
  vm.removeTracker("one");
  pending.resolve({
    connections: [tracker()],
    providers: available,
    jev_linking_disclosure: "",
  });
  await loading;
  assert.deepEqual(vm.trackers.value, []);
});
test("unmounted account does not accept a pending list response", async (t) => {
  const transport = api(),
    pending = deferred<any>();
  transport.trackers.list = () => pending.promise;
  const { vm, unmount } = await mount(t, Page, pageProps(transport));
  unmount();
  pending.resolve({
    connections: [tracker("old-account")],
    providers: available,
    jev_linking_disclosure: "",
  });
  await settle();
  assert.deepEqual(vm.trackers.value, []);
});
test("slow remote disconnect closes only its original detail", async (t) => {
  const transport = api(),
    pending = deferred<void>();
  transport.remote.list = async () => ({
    connections: [
      {
        id: "remote1",
        client_name: "Claude",
        redirect_hosts: ["claude.ai"],
        scope: "mcp",
        created_at: "2026-10-22",
        last_used_at: "2026-10-22",
        expires_at: "2027-10-22",
      },
    ],
  });
  transport.remote.disconnect = () => pending.promise;
  const { vm, closed } = await mount(t, Page, pageProps(transport));
  await vm.openRow(vm.rows.value.find((row: any) => row.kind === "remote"));
  const disconnect = vm.disconnectRemote();
  vm.closeDetail();
  await vm.openRow(vm.rows.value.find((row: any) => row.kind === "tracker"));
  const before = closed();
  pending.resolve();
  await disconnect;
  assert.equal(vm.selection.value.id, "one");
  assert.equal(closed(), before);
  assert.equal(vm.remotes.value.length, 0);
});
test("refresh removal closes a now-missing connection detail", async (t) => {
  const transport = api();
  const { vm } = await mount(t, Page, pageProps(transport));
  await vm.openRow(vm.rows.value[0]);
  transport.trackers.list = async () => ({
    connections: [],
    providers: available,
    jev_linking_disclosure: "",
  });
  await vm.refresh();
  await settle();
  assert.equal(vm.selection.value, null);
});
test("detail actions use only the selected connection and retain full consent", async (t) => {
  const transport = api(),
    ids: string[] = [];
  transport.trackers.update = async (id, patch) => {
    ids.push(id);
    return { ...tracker(id), ...patch };
  };
  const { vm, emitted } = await mount(t, Details, {
    connection: tracker("selected"),
    api: transport.trackers,
    disclosure: "Full consent from server.",
  });
  await vm.toggleJev();
  assert.deepEqual(ids, ["selected"]);
  assert.equal(emitted[0][1].jev_linking_enabled, true);
  const html = await renderToString(
    createSSRApp({
      render: () =>
        h(Details, {
          connection: tracker("g", "github"),
          api: transport.trackers,
          disclosure: "Full consent from server.",
        }),
    }),
  );
  assert.match(html, /Full consent from server/);
  assert.match(html, /Read-only connection/);
  assert.doesNotMatch(html, /settings-connector-rules-g/);
  assert.doesNotMatch(html, /Show webhook setup/);
});
test("web OAuth-only setup has no token fields and cannot submit tokens", async (t) => {
  const transport = api();
  let saves = 0;
  transport.trackers.saveApiToken = async () => {
    saves++;
    return tracker();
  };
  const props = {
    provider: "jira",
    availability: { oauth: true, api_token: false },
    api: transport.trackers,
  };
  const html = await renderToString(
    createSSRApp({ render: () => h(Setup, props) }),
  );
  assert.match(html, /Open the desktop app/);
  assert.doesNotMatch(html, /type="password"/);
  assert.doesNotMatch(html, />Connect<\/button>/);
  const { vm } = await mount(t, Setup, props);
  await vm.save();
  assert.equal(saves, 0);
});
test("desktop OAuth offers an explicit token fallback without eagerly rendering password fields", async () => {
  const transport = api();
  transport.trackers.connectOAuth = async () => tracker();
  const html = await renderToString(
    createSSRApp({
      render: () =>
        h(Setup, {
          provider: "jira",
          availability: available.jira,
          api: transport.trackers,
        }),
    }),
  );
  assert.match(html, /Sign in with Jira/);
  assert.match(html, /Use an API token instead/);
  assert.doesNotMatch(html, /type="password"/);
});
test("remote URL is bound to the configured server", () => {
  assert.equal(
    remoteConnectorUrl("https://example.test/"),
    "https://example.test/mcp",
  );
  assert.equal(remoteConnectorUrl(null), "https://letagents.chat/mcp");
});

test("same-ID tracker test discovers statuses without overwriting unsaved mapping edits", async (t) => {
  const transport = api();
  const { vm, props } = await mount(t, Details, {
    connection: tracker("selected"),
    api: transport.trackers,
    disclosure: "Consent",
  });
  vm.mapping.value[0].state = "in_review";
  props.connection = {
    ...tracker("selected"),
    unmapped_statuses: ["Waiting for review"],
  };
  await settle();
  assert.deepEqual(
    vm.mapping.value.map((row: any) => [row.name, row.state]),
    [
      ["Open", "in_review"],
      ["Waiting for review", "in_progress"],
    ],
  );
  props.connection = {
    ...tracker("selected"),
    unmapped_statuses: ["Waiting for review", "Blocked"],
  };
  await settle();
  assert.equal(
    vm.mapping.value.filter((row: any) => row.name === "Waiting for review")
      .length,
    1,
  );
  assert.equal(
    vm.mapping.value.find((row: any) => row.name === "Blocked").state,
    "in_progress",
  );
});

test("opening another agent setup resets the completed wizard before selecting its target", async (t) => {
  const Settings = (
    await vite.ssrLoadModule(
      "/renderer/src/components/desktop/content/SettingsView.vue",
    )
  ).default;
  const { vm, emitted } = await mount(t, Settings, {
    initialPane: "account:connectors",
    mcpWizardStep: "done",
  });
  vm.openAgentSetup("codex");
  assert.deepEqual(emitted.slice(0, 3), [
    ["back-mcp"],
    ["clear-mcp-target-selection"],
    ["select-mcp-target", "codex"],
  ]);
  assert.equal(vm.activePane.value, "account:connectors-setup");
  vm.selectPane("account:connectors-agents");
  vm.openAgentSetup("cursor");
  assert.deepEqual(emitted.slice(3, 6), [
    ["back-mcp"],
    ["clear-mcp-target-selection"],
    ["select-mcp-target", "cursor"],
  ]);
});

test("removing a connection before its opening tick cannot reopen an empty dialog", async (t) => {
  const { vm, opened } = await mount(t, Page, pageProps());
  const opening = vm.openRow(vm.rows.value[0]);
  vm.removeTracker("one");
  await opening;
  assert.equal(opened(), 0);
  assert.equal(vm.selection.value, null);
});

test("tracker disconnect completion belongs to its account page after the detail closes", async (t) => {
  const transport = api(),
    pending = deferred<void>();
  transport.trackers.list = async () => ({
    connections: [tracker("jira"), tracker("github", "github")],
    providers: available,
    jev_linking_disclosure: "Consent",
  });
  transport.trackers.remove = () => pending.promise;
  const page = await mount(t, Page, pageProps(transport));
  await page.vm.openRow(
    page.vm.rows.value.find((row: any) => row.id === "jira"),
  );
  const detail = await mount(t, Details, {
    connection: tracker("jira"),
    api: page.vm.trackerDetailsApi.value,
    disclosure: "Consent",
  });
  const removal = detail.vm.remove();
  detail.unmount();
  page.vm.closeDetail();
  await page.vm.openRow(
    page.vm.rows.value.find((row: any) => row.id === "github"),
  );
  const before = page.closed();
  pending.resolve();
  await removal;
  assert.deepEqual(
    page.vm.trackers.value.map((connection: any) => connection.id),
    ["github"],
  );
  assert.equal(page.vm.selection.value.id, "github");
  assert.equal(page.closed(), before);
  assert.equal(page.vm.detailFeedback.value, "");
});

test("failed tracker disconnect keeps the row without leaking feedback into another detail", async (t) => {
  const transport = api(),
    pending = deferred<void>();
  transport.trackers.list = async () => ({
    connections: [tracker("jira"), tracker("github", "github")],
    providers: available,
    jev_linking_disclosure: "Consent",
  });
  transport.trackers.remove = () => pending.promise;
  const page = await mount(t, Page, pageProps(transport));
  await page.vm.openRow(
    page.vm.rows.value.find((row: any) => row.id === "jira"),
  );
  const detail = await mount(t, Details, {
    connection: tracker("jira"),
    api: page.vm.trackerDetailsApi.value,
    disclosure: "Consent",
  });
  const removal = detail.vm.remove();
  detail.unmount();
  page.vm.closeDetail();
  await page.vm.openRow(
    page.vm.rows.value.find((row: any) => row.id === "github"),
  );
  const before = page.closed();
  pending.reject(new Error("Disconnect refused"));
  await removal;
  assert.deepEqual(
    page.vm.trackers.value.map((connection: any) => connection.id),
    ["jira", "github"],
  );
  assert.equal(page.vm.selection.value.id, "github");
  assert.equal(page.closed(), before);
  assert.equal(page.vm.detailFeedback.value, "");
  assert.equal(detail.vm.feedback.value, "");
});

test("tracker disconnect cannot update an account page after it unmounts", async (t) => {
  const transport = api(),
    pending = deferred<void>();
  transport.trackers.remove = () => pending.promise;
  const page = await mount(t, Page, pageProps(transport));
  const removal = page.vm.trackerDetailsApi.value.remove("one");
  page.unmount();
  pending.resolve();
  await removal;
  assert.deepEqual(
    page.vm.trackers.value.map((connection: any) => connection.id),
    ["one"],
  );
});

test("failed tracker disconnect remains visible in the original live detail", async (t) => {
  const transport = api();
  transport.trackers.remove = async () => {
    throw new Error("Disconnect refused");
  };
  const page = await mount(t, Page, pageProps(transport));
  const detail = await mount(t, Details, {
    connection: tracker(),
    api: page.vm.trackerDetailsApi.value,
    disclosure: "Consent",
  });
  await detail.vm.remove();
  assert.equal(detail.vm.feedback.value, "Disconnect refused");
  assert.equal(page.vm.trackers.value.length, 1);
});
