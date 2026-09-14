import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createRenderer,
  defineComponent,
  h,
  isReadonly,
  nextTick,
  ref,
  type App,
} from "vue";
import type {
  DesktopRoomMessage,
  DesktopRoomThreadInboxPage,
} from "../../electron/ipc-types";
import {
  normalizeExactGitHubUrl,
  normalizeGitHubObjectUrl,
  repoRepositoryFromRoomIdentifier,
  shouldPreviewComposerEvent,
  shouldRefreshEventsForMessage,
  useDesktopRoomGitHubEvents,
} from "../src/components/desktop/content/room-shell/useDesktopRoomGitHubEvents";
import { mergeThreadInboxPages } from "../src/composables/useNeedsYou";

const shellSource = read("../src/components/desktop/content/DesktopRoomShell.vue");
const githubEventsSource = read("../src/components/desktop/content/room-shell/useDesktopRoomGitHubEvents.ts");

test("the desktop room shell keeps GitHub events and no longer owns an inbox", () => {
  assert.ok(shellSource.split("\n").length < 3_000);
  assert.doesNotMatch(shellSource, /useDesktopRoomInbox|RoomInboxView|id: "inbox"/);
  assert.match(shellSource, /useDesktopRoomGitHubEvents\(/);
  assert.doesNotMatch(shellSource, /desktopIpc\.room\.getThreads/);
  assert.doesNotMatch(shellSource, /desktopIpc\.room\.getGitHubEvents/);
  assert.doesNotMatch(shellSource, /letagents-desktop:room-inbox-seen/);
  assert.match(githubEventsSource, /desktopIpc\.room\.getGitHubEvents/);
  assert.match(githubEventsSource, /parseGitHubEvent/);
});

test("extracted room shell domains do not import the shell component", () => {
  assert.doesNotMatch(githubEventsSource, /DesktopRoomShell/);
});

test("thread inbox paging preserves replacement and cursor semantics", () => {
  const current = {
    threads: [thread("root-1", "old"), thread("root-2", "keep")],
    hasMore: true,
    unreadThreadCount: 2,
  } as unknown as DesktopRoomThreadInboxPage;
  const next = {
    threads: [thread("root-1", "new"), thread("root-3", "append")],
    hasMore: false,
    unreadThreadCount: 1,
  } as unknown as DesktopRoomThreadInboxPage;

  const merged = mergeThreadInboxPages(current, next);

  assert.deepEqual(merged.threads.map((item) => [item.root.id, item.root.text]), [
    ["root-1", "new"],
    ["root-2", "keep"],
    ["root-3", "append"],
  ]);
  assert.equal(merged.hasMore, false);
  assert.equal(merged.unreadThreadCount, 1);
});

test("GitHub room and event routing keeps exact and object URL identities distinct", () => {
  assert.equal(repoRepositoryFromRoomIdentifier("github.com/BrosInCode/letagents"), "BrosInCode/letagents");
  assert.equal(repoRepositoryFromRoomIdentifier("local-room"), null);
  assert.equal(normalizeExactGitHubUrl(" HTTPS://GitHub.com/A/B/issues/1/ "), "https://github.com/a/b/issues/1");
  assert.equal(normalizeGitHubObjectUrl("https://github.com/a/b/issues/1?notification=2#x"), "https://github.com/a/b/issues/1");

  const githubMessage = { source: "GitHub", sender: "bot", timestamp: "2026-08-12T12:00:00.000Z" } as DesktopRoomMessage;
  assert.equal(shouldRefreshEventsForMessage(githubMessage), true);
  assert.equal(shouldPreviewComposerEvent(githubMessage, Date.parse("2026-08-12T12:00:29.999Z")), true);
  assert.equal(shouldPreviewComposerEvent(githubMessage, Date.parse("2026-08-12T12:00:30.000Z")), false);
});

test("mounted GitHub events owns readonly selection and resets it on room change", async () => {
  installWindow({ room: {} }, []);
  const room = ref({ identifier: "github.com/a/one" } as never);
  const activeTab = ref<"chat" | "events">("chat");
  let githubEvents!: ReturnType<typeof useDesktopRoomGitHubEvents>;
  const mounted = mountHarness(() => {
    githubEvents = useDesktopRoomGitHubEvents({
      room,
      messages: ref([]),
      initialPage: ref(null),
      activeTab,
      localGitRoom: ref(false),
      githubConnected: ref(true),
      connectedRepository: ref(null),
    });
  });

  githubEvents.openEventsForTask("task-1");
  githubEvents.openEventById("event-1");
  assert.equal(githubEvents.eventsTaskFilterId.value, null);
  assert.equal(githubEvents.eventsSelectedEventId.value, "event-1");
  assert.equal(activeTab.value, "events");
  assert.equal(isReadonly(githubEvents.eventsTaskFilterId), true);
  assert.equal(isReadonly(githubEvents.eventsSelectedEventId), true);

  room.value = { identifier: "github.com/a/two" } as never;
  await nextTick();
  assert.equal(githubEvents.eventsTaskFilterId.value, null);
  assert.equal(githubEvents.eventsSelectedEventId.value, null);
  mounted.unmount();
});

function thread(id: string, text: string) {
  return { root: { id, text }, summary: { unreadCount: 1 } };
}

interface HostNode { parent: HostNode | null; children: HostNode[] }

const renderer = createRenderer<HostNode, HostNode>({
  patchProp: () => undefined,
  insert(child, parent) { parent.children.push(child); child.parent = parent; },
  remove(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); },
  createElement: () => ({ parent: null, children: [] }),
  createText: () => ({ parent: null, children: [] }),
  createComment: () => ({ parent: null, children: [] }),
  setText: () => undefined,
  setElementText: () => undefined,
  parentNode: (node) => node.parent,
  nextSibling: () => null,
  insertStaticContent: (_content, parent) => {
    const node = { parent, children: [] };
    parent.children.push(node);
    return [node, node];
  },
});

function mountHarness(setup: () => void): App<HostNode> {
  const app = renderer.createApp(defineComponent({
    setup() { setup(); return () => h("div"); },
  }));
  app.mount({ parent: null, children: [] });
  return app;
}

function installWindow(api: Record<string, unknown>, clearedTimers: unknown[]): void {
  const storage = new Map<string, string>();
  Object.assign(globalThis, {
    window: {
      letagentsDesktop: api,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      setTimeout,
      clearTimeout: (timer: unknown) => {
        clearedTimers.push(timer);
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      },
    },
  });
}

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}
