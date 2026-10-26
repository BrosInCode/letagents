import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { parse, compileScript, compileTemplate } from "@vue/compiler-sfc";
import * as Vue from "vue";
import { computed, createRenderer, effectScope, nextTick, ref, shallowRef, ssrContextKey, type App, type ComputedRef } from "vue";
import { createServer, transformWithEsbuild, type ViteDevServer } from "vite";
import type { DesktopSupervisorManifestEntry } from "../../electron/ipc-types";

/*
 * Counts how often the room timeline and its rows redraw. A redraw of the
 * message list costs one pass over every mounted row, so typing, activity
 * events and the start-up clock must not cause one when nothing in the list
 * changes.
 */

interface HostNode {
  kind: "element" | "text" | "comment";
  type?: string;
  text: string;
  children: HostNode[];
  parent: HostNode | null;
  props: Record<string, unknown>;
  [key: string]: unknown;
}

function hostNode(kind: HostNode["kind"], type?: string, text = ""): HostNode {
  return {
    getRootNode: () => ({ activeElement: null }),
    kind, type, text, children: [], parent: null, props: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0, style: {},
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 800, width: 800, height: 0 }; },
    classList: { add: () => undefined, remove: () => undefined }, focus: () => undefined, scrollTo: () => undefined,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => undefined, removeEventListener: () => undefined,
  };
}

const teleportTarget = hostNode("element", "body");
Object.assign(globalThis, {
  Document: class Document {},
  ShadowRoot: class ShadowRoot {},
  window: {
    setTimeout, clearTimeout, addEventListener: () => undefined, removeEventListener: () => undefined,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout, innerWidth: 1200, innerHeight: 800,
    location: { href: "http://localhost/" }, getSelection: () => null,
    matchMedia: (media: string) => ({ matches: false, media, addEventListener: () => undefined, removeEventListener: () => undefined }),
    document: { documentElement: { style: { scrollBehavior: "" } } },
  },
  document: { documentElement: { style: { scrollBehavior: "" } }, addEventListener() {}, removeEventListener() {}, visibilityState: "visible", hasFocus: () => true },
});

const renderer = createRenderer<HostNode, HostNode>({
  patchProp(node, key, _previous, next) { node.props[key] = next; },
  insert(child, parent, anchor) {
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, child); else parent.children.push(child);
    child.parent = parent;
  },
  remove(child) {
    const parent = child.parent;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(child), 1);
    child.parent = null;
  },
  createElement: (type) => hostNode("element", type),
  createText: (text) => hostNode("text", undefined, text),
  createComment: (text) => hostNode("comment", undefined, text),
  setText(node, text) { node.text = text; },
  setElementText(node, text) { node.children = [hostNode("text", undefined, text)]; },
  parentNode: (node) => node.parent,
  nextSibling(node) {
    const siblings = node.parent?.children || [];
    return siblings[siblings.indexOf(node) + 1] || null;
  },
  insertStaticContent(content, parent, anchor) {
    const node = hostNode("text", undefined, content);
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index >= 0) parent.children.splice(index, 0, node); else parent.children.push(node);
    node.parent = parent;
    return [node, node];
  },
  querySelector: () => teleportTarget,
});

function descendants(node: HostNode): HostNode[] {
  return [node, ...node.children.flatMap(descendants)];
}

async function attachClientRender(component: object, modulePath: string): Promise<void> {
  const source = await readFile(fileURLToPath(new URL(`../src/${modulePath}`, import.meta.url)), "utf8");
  const descriptor = parse(source, { filename: modulePath }).descriptor;
  assert.ok(descriptor.template, `${modulePath} must have a template`);
  const script = compileScript(descriptor, { id: modulePath });
  const compiled = compileTemplate({
    source: descriptor.template.content, filename: modulePath, id: modulePath,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  assert.deepEqual(compiled.errors, [], `client template compilation failed for ${modulePath}`);
  const clientCode = compiled.code
    .replace(/^import \{([\s\S]*?)\} from "vue"\n/, (_match, bindings: string) => `const {${bindings.replace(/\s+as\s+/g, ": ")}} = vue\n`)
    .replace("export function render", "function render");
  const transformed = await transformWithEsbuild(clientCode, `${modulePath}.ts`, { loader: "ts", target: "esnext" });
  (component as { render?: unknown }).render = Function("vue", `${transformed.code}\nreturn render;`)(Vue);
}

const components = {
  DesktopChatMessage: "components/desktop/content/DesktopChatMessage.vue",
  RoomMessageViewport: "components/desktop/content/room-chat/RoomMessageViewport.vue",
  RoomComposer: "components/desktop/content/room-chat/RoomComposer.vue",
  RoomActivityLine: "components/desktop/content/room-chat/RoomActivityLine.vue",
  ActivityOrb: "components/desktop/content/room-chat/ActivityOrb.vue",
  RoomAgentStartupRow: "components/desktop/content/room-chat/RoomAgentStartupRow.vue",
  RoomAgentStartupEntry: "components/desktop/content/room-chat/RoomAgentStartupEntry.vue",
  DesktopAttachmentDrafts: "components/desktop/content/DesktopAttachmentDrafts.vue",
  RoomGitHubUpdates: "../../../../shared/ui/RoomGitHubUpdates.vue",
} as const;
type ComponentName = keyof typeof components;

let vite: ViteDevServer;
const loaded = {} as Record<ComponentName, object>;
let messageDrafts: typeof import("../src/domain/desktop-message-drafts");
let roomActivity: typeof import("../src/components/desktop/content/room-chat/room-activity");
let supervisorEntries: typeof import("../src/domain/supervisor-entries-resource");

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent",
    server: { middlewareMode: true },
  });
  messageDrafts = await vite.ssrLoadModule("/renderer/src/domain/desktop-message-drafts.ts") as typeof messageDrafts;
  roomActivity = await vite.ssrLoadModule("/renderer/src/components/desktop/content/room-chat/room-activity.ts") as typeof roomActivity;
  supervisorEntries = await vite.ssrLoadModule("/renderer/src/domain/supervisor-entries-resource.ts") as typeof supervisorEntries;
  for (const [name, path] of Object.entries(components) as Array<[ComponentName, string]>) {
    const url = path.startsWith("../") ? fileURLToPath(new URL(`../src/${path}`, import.meta.url)) : `/renderer/src/${path}`;
    loaded[name] = (await vite.ssrLoadModule(url)).default as object;
    await attachClientRender(loaded[name], path);
  }
});

after(async () => { await vite?.close(); });

/** Mounts `setup` and counts the updates of each loaded component type. */
function mountCounting(setup: () => () => unknown): { root: HostNode; app: App; updates: (name: ComponentName) => number; reset: () => void } {
  const root = hostNode("element", "root");
  const app = renderer.createApp({ setup });
  app.provide(ssrContextKey, { modules: new Set<string>() });
  // Children without a client template render nothing here; the counts are about the list.
  app.config.warnHandler = () => undefined;
  for (const name of ["DesktopGitHubEventCard", "DesktopLongMessageContent", "DesktopMessageAttachments", "ProviderBadge"]) {
    app.component(name, { render: () => null });
  }
  const counts = new Map<object, number>();
  app.mixin({
    updated(this: { $: { type: object } }) { counts.set(this.$.type, (counts.get(this.$.type) ?? 0) + 1); },
  });
  app.mount(root);
  return {
    root, app,
    updates: (name) => counts.get(loaded[name]) ?? 0,
    reset: () => counts.clear(),
  };
}

const ROOM = "room-counts";

/** Message rows on screen, so a zero update count cannot come from rows that never mounted. */
function mountedRows(root: HostNode): number {
  return descendants(root).filter((node) => typeof node.props["data-message-id"] === "string").length;
}

function messages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg_${index}`, sender: "Emmy", text: `Message ${index}`, attachments: [], agentPromptKind: null,
    source: "browser", timestamp: new Date(Date.parse("2026-10-26T09:00:00.000Z") + index * 60_000).toISOString(),
    actorLabel: null, agentIdentity: null, threadRootId: null, threadReplyToId: null, thread: null, replyTo: null,
  }));
}

// One set of list inputs for every render, as RoomChatView keeps them between renders.
const baseViewportProps = {
  active: true, activeSearchMessageId: null, activeThreadParentId: null, hasOlderMessages: false,
  loadingOlderMessages: false, messages: messages(40), threadMessages: [], messageNamespace: ROOM,
  localAgentWork: [], deliveryReceiptsByMessage: {}, hasFilteredRoomActivity: false, roomIdentifier: ROOM,
  githubActivityAvailable: false, roomLoading: false, searchQuery: "", taskReferenceIds: new Set<string>(),
};

function viewportProps(overrides: Record<string, unknown> = {}) {
  return { ...baseViewportProps, ...overrides };
}

function supervisorEntry(overrides: Partial<DesktopSupervisorManifestEntry> = {}): DesktopSupervisorManifestEntry {
  return {
    id: "supervised_wren", roomId: ROOM, displayName: "Wren", provider: "claude-code", model: "Opus 5.5", charter: "",
    desiredState: "running", observedState: "starting", condition: "none", lastError: null,
    permissionProfileId: "ask_before_write", deliveryMode: "daemon_inbox", createdBy: "desktop",
    createdAt: new Date().toISOString(), workspacePath: "/tmp/w", workAttemptId: "attempt", agentSessionId: null,
    agentSessionBindingState: "none", bindingUpdatedAt: null, executionGenerationId: null, providerContinuationId: null,
    providerPid: null, workplaceLiveness: { state: "unknown", observedAt: null, detail: null },
    nativeLiveness: { state: "unknown", observedAt: null, detail: null }, restartCount: 0, lastTerminal: null,
    activity: [], lastTurnControlSequence: 0, turnControl: null,
    ...overrides,
  };
}

function activityEvent(sequence: number) {
  return { sequence, at: new Date().toISOString(), kind: "tool", summary: `Step ${sequence}` } as unknown as DesktopSupervisorManifestEntry["activity"][number];
}

const typed = (text: string) => Array.from({ length: text.length }, (_, index) => text.slice(0, index + 1));

test("typing '@agent …' while that agent works does not redraw the message list per key", async () => {
  const target = { entryId: "supervised_wren", displayName: "Wren", mentionInsertText: "Wren" };
  const run = async (stable: boolean) => {
    const scope = effectScope();
    const draft = scope.run(() => messageDrafts.useDesktopMessageDraft(() => ROOM).text)!;
    draft.value = "";
    const mounted = mountCounting(() => {
      const composer = ref<{ steerOffer: { target: typeof target } | null } | null>(null);
      // RoomChatView's mapping (stable), and the mapping before this change (a new object per draft change).
      const steerOffer: ComputedRef<unknown> = stable
        ? computed((previous) => roomActivity.stableSteerOffer(previous as never, composer.value?.steerOffer?.target))
        : computed(() => {
          const offer = composer.value?.steerOffer;
          return offer ? { entryId: offer.target.entryId, displayName: offer.target.displayName } : null;
        });
      const composerProps = {
        ref: composer, attaching: false, attachmentDrafts: [], attachmentError: null, participants: [],
        pendingAttachmentDrafts: [], replyTo: null, roomIdentifier: ROOM, messageNamespace: ROOM,
        roomLoading: false, sendError: null, sending: false, correctableAgents: [target],
      };
      return () => [
        Vue.h(loaded.RoomComposer, composerProps),
        Vue.h(loaded.RoomMessageViewport, viewportProps({ steerOffer: steerOffer.value })),
      ];
    });
    try {
      await nextTick();
      mounted.reset();
      const keys = typed("@Wren please stop");
      for (const text of keys) {
        draft.value = text;
        await nextTick();
      }
      const steerButton = descendants(mounted.root).some((node) => node.props["data-testid"] === "room-activity-steer");
      return { keys: keys.length, viewport: mounted.updates("RoomMessageViewport"), rows: mounted.updates("DesktopChatMessage"), mountedRows: mountedRows(mounted.root), steerButton };
    } finally {
      mounted.app.unmount();
      draft.value = "";
      scope.stop();
    }
  };
  const before = await run(false);
  const after = await run(true);
  console.log(`steer offer: ${before.keys} keys; list redraws before=${before.viewport} after=${after.viewport}`);
  assert.ok(before.viewport >= before.keys - 7, "control: a new offer object each key redraws the list each key");
  // The offer appears once ("@Wren p") and stays the same object after that.
  assert.ok(after.viewport <= 1, `the list redraws at most once, when the offer first appears (got ${after.viewport})`);
  assert.equal(after.rows, 0, "no message row redraws");
  assert.equal(after.mountedRows, 40, "every message row is mounted");
  assert.ok(before.steerButton && after.steerButton, "the activity line offers Steer in both runs");
});

test("an activity event with no visible change does not redraw the list or its plain rows", async () => {
  // RoomChatView's chain: all entries → this room's entries → the timeline's copy.
  const entries = shallowRef<DesktopSupervisorManifestEntry[]>([supervisorEntry({ readyReachedAt: new Date().toISOString(), observedState: "running" } as never)]);
  const mounted = mountCounting(() => {
    const roomEntries = computed<DesktopSupervisorManifestEntry[]>((previous) => {
      const next = entries.value.filter((entry) => entry.roomId === ROOM);
      return previous?.length === next.length && next.every((entry, index) => entry === previous[index]) ? previous : next;
    });
    const timelineEntries = computed<DesktopSupervisorManifestEntry[]>((previous) =>
      supervisorEntries.supervisorEntriesIgnoringActivity(previous, roomEntries.value));
    return () => Vue.h(loaded.RoomMessageViewport, viewportProps({ supervisorEntries: timelineEntries.value }));
  });
  try {
    await nextTick();
    mounted.reset();
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      entries.value = supervisorEntries.foldSupervisorActivityPush(entries.value, ROOM, { entryId: "supervised_wren", event: activityEvent(sequence) } as never);
      await nextTick();
    }
    assert.equal(entries.value[0]!.activity.length, 20, "the events are folded in");
    console.log(`activity events: 20; list redraws=${mounted.updates("RoomMessageViewport")} row redraws=${mounted.updates("DesktopChatMessage")}`);
    assert.equal(mountedRows(mounted.root), 40, "every message row is mounted");
    assert.equal(mounted.updates("RoomMessageViewport"), 0);
    assert.equal(mounted.updates("DesktopChatMessage"), 0);
  } finally {
    mounted.app.unmount();
  }
});

test("a list redraw for a real change does not redraw the plain rows", async () => {
  const notice = shallowRef<unknown>(null);
  const mounted = mountCounting(() => () => Vue.h(loaded.RoomMessageViewport, viewportProps({ activityNotice: notice.value })));
  try {
    await nextTick();
    mounted.reset();
    notice.value = { id: "n1", kind: "joined", text: "Juniper joined" };
    await nextTick();
    assert.ok(mounted.updates("RoomMessageViewport") >= 1, "the list itself redraws");
    console.log(`real list redraw: plain row redraws=${mounted.updates("DesktopChatMessage")}`);
    assert.equal(mountedRows(mounted.root), 40, "every message row is mounted");
    assert.equal(mounted.updates("DesktopChatMessage"), 0, "unchanged messages keep their props and do not redraw");
  } finally {
    mounted.app.unmount();
  }
});

test("a start-up clock tick redraws only its own row", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.parse("2026-10-26T10:00:00.400Z") });
  const createdAt = new Date(Date.now() - 400).toISOString();
  const entry = supervisorEntry({
    createdAt,
    launchProgress: {
      attempt: 1, startedAt: createdAt, state: "running", current: "process", endedAt: null, firstOutputAt: null,
      failure: null, slotAhead: null, phases: [{ phase: "prepare", startedAt: createdAt, ms: 100 }, { phase: "process", startedAt: createdAt, ms: null }],
    },
  } as never);
  const mounted = mountCounting(() => () => Vue.h(loaded.RoomMessageViewport, viewportProps({ supervisorEntries: [entry] })));
  try {
    await nextTick();
    context.mock.timers.tick(1);
    await nextTick();
    assert.ok(descendants(mounted.root).some((node) => node.props["data-testid"] === "room-agent-startup-supervised_wren"), "the start-up row shows");
    mounted.reset();
    for (let second = 0; second < 5; second += 1) {
      context.mock.timers.tick(1_000);
      await nextTick();
    }
    console.log(`start-up ticks: 5 s; list redraws=${mounted.updates("RoomMessageViewport")} row redraws=${mounted.updates("RoomAgentStartupRow")} message row redraws=${mounted.updates("DesktopChatMessage")}`);
    assert.equal(mounted.updates("RoomMessageViewport"), 0, "the list does not redraw on the clock");
    assert.equal(mountedRows(mounted.root), 40, "every message row is mounted");
    assert.equal(mounted.updates("DesktopChatMessage"), 0);
    assert.ok(mounted.updates("RoomAgentStartupRow") > 0, "the start-up row itself keeps time");
  } finally {
    mounted.app.unmount();
  }
});
