import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp } from "vue";
import { createServer, type ViteDevServer } from "vite";

let vite: ViteDevServer;
let DesktopRoomActionPanel: object;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL("../..", import.meta.url)),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  DesktopRoomActionPanel = (await vite.ssrLoadModule(
    "/renderer/src/components/desktop/content/room-shell/DesktopRoomActionPanel.vue",
  )).default;
});

after(async () => {
  await vite?.close();
});

const localGitRoom = {
  identifier: "git-room:local:1234567890abcdef:branch:ZmVhdHVyZQ",
  code: "",
  name: "Autodownloader",
  displayName: "Autodownloader",
  role: "admin",
  gitRoom: {
    provider: "git",
    host: "local",
    repository: {
      id: "local:1234567890abcdef",
      fullName: "Autodownloader",
      owner: "local",
      name: "Autodownloader",
    },
    ref: {
      type: "branch",
      name: "feature",
      defaultBranch: "main",
      baseRef: "main",
      headRef: "feature",
      headRepository: null,
    },
    visibility: "local",
    accessMode: "local",
    isDefault: false,
    source: "local_git",
  },
};

const localStorage = {
  roomIdentifier: localGitRoom.identifier,
  defaultMode: "cloud",
  overrideMode: "cloud",
  effectiveMode: "local",
  isLocalRoom: true,
  localRoom: {
    roomIdentifier: localGitRoom.identifier,
    displayName: "Autodownloader",
    cloudRoomIdentifier: null,
    publishStatus: "local_only",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
    publishedAt: null,
    gitRoom: localGitRoom.gitRoom,
  },
  databasePath: "/tmp/local-chat.sqlite",
  localFilesPath: "/tmp/local-files",
};

/** The opening tag of the storage choice, so a test reads its state and not its attribute order. */
function storageChoice(html: string, mode: "inherit" | "cloud" | "local"): string {
  const tag = new RegExp(`<button[^>]*data-testid="desktop-room-storage-${mode}"[^>]*>`).exec(html)?.[0];
  assert.ok(tag, `the ${mode} storage choice is rendered`);
  return tag;
}

const githubRoom = {
  ...localGitRoom,
  identifier: "github.com/BrosInCode/letagents",
  gitRoom: {
    ...localGitRoom.gitRoom,
    provider: "github",
    host: "github.com",
    visibility: "public",
    accessMode: "public",
    source: "git_remote",
  },
};

const cloudStorage = {
  ...localStorage,
  roomIdentifier: githubRoom.identifier,
  overrideMode: "inherit",
  effectiveMode: "cloud",
  isLocalRoom: false,
  localRoom: null,
};

async function renderPanel(overrides: Record<string, unknown> = {}): Promise<string> {
  return renderToString(createSSRApp(DesktopRoomActionPanel, {
    room: localGitRoom,
    storage: localStorage,
    roomUrl: `https://letagents.chat/in/${encodeURIComponent(localGitRoom.identifier)}`,
    copied: false,
    soundEnabled: true,
    notificationsEnabled: true,
    notificationPermission: "granted",
    renameBusy: false,
    renameError: null,
    githubStatus: null,
    githubLoading: false,
    githubBusy: false,
    githubError: null,
    githubEventsAvailable: false,
    githubEventsVisible: false,
    storageBusy: false,
    ...overrides,
  }));
}

test("local Git Rooms disable Cloud and explain how to unlock it", async () => {
  const html = await renderPanel();

  assert.match(html, /No Git provider is attached to this room/);
  assert.match(html, /Add an origin remote, then reopen the repository to use Cloud/);
  assert.match(html, /Connect this project to a repository hosted online before sharing its room/);
  // Unavailable, yet reachable: the reason is read out to someone who lands on it.
  assert.match(storageChoice(html, "cloud"), /aria-disabled="true"/);
  assert.match(storageChoice(html, "cloud"), /aria-describedby="room-settings-storage-cloud-reason"/);
  assert.doesNotMatch(storageChoice(html, "cloud"), / disabled/);
  assert.match(html, /<span id="room-settings-storage-cloud-reason" class="sr-only">No Git provider is attached to this room/);
  assert.match(storageChoice(html, "cloud"), /aria-checked="false"/);
  assert.match(storageChoice(html, "local"), /aria-checked="true"/);
  assert.doesNotMatch(html, /Publish to cloud/);
});

test("provider-backed rooms keep the Cloud control enabled", async () => {
  const html = await renderPanel({ room: githubRoom, storage: cloudStorage });

  assert.match(storageChoice(html, "cloud"), /aria-disabled="false"/);
  assert.doesNotMatch(html, /No Git provider is attached to this room/);
});

test("exactly one storage choice is selected, and following the app default wins", async () => {
  const selected = (html: string) => (["inherit", "cloud", "local"] as const)
    .filter((mode) => /aria-checked="true"/.test(storageChoice(html, mode)));

  assert.deepEqual(selected(await renderPanel({ room: githubRoom, storage: cloudStorage })), ["inherit"]);
  assert.deepEqual(selected(await renderPanel({ room: githubRoom, storage: { ...cloudStorage, overrideMode: "cloud" } })), ["cloud"]);
  assert.deepEqual(selected(await renderPanel({ room: githubRoom, storage: { ...cloudStorage, effectiveMode: "local" } })), ["inherit"]);
  assert.deepEqual(selected(await renderPanel()), ["local"]);
});

test("a storage change in flight keeps the row's text and size still", async () => {
  const idle = await renderPanel({ room: githubRoom, storage: { ...cloudStorage, overrideMode: "cloud" } });
  const busy = await renderPanel({ room: githubRoom, storage: { ...cloudStorage, overrideMode: "cloud" }, storageBusy: true });

  // The description describes the room, so it does not change until the room does.
  for (const html of [idle, busy]) assert.match(html, /<p class="room-settings-row-description">This room always uses cloud storage\.<\/p>/);
  assert.doesNotMatch(idle, /Changing room storage/);
  // People using a screen reader are still told that a change is under way.
  assert.match(busy, /<p class="sr-only" role="status">Changing room storage…<\/p>/);
  // The progress bar exists only while the change is under way, so its sweep starts from the edge.
  assert.doesNotMatch(idle, /room-settings-progress/);
  assert.match(busy, /class="room-settings-progress"/);
  // The choices stop answering without being disabled, so focus is not dropped mid-change.
  for (const mode of ["inherit", "cloud", "local"] as const) {
    assert.match(storageChoice(busy, mode), /aria-disabled="true"/);
    assert.doesNotMatch(storageChoice(busy, mode), / disabled/);
  }
  // A local room's publish button is not relabelled by a change that is not a publish.
  const localBusy = await renderPanel({ room: githubRoom, storage: { ...cloudStorage, overrideMode: "local", effectiveMode: "local" }, storageBusy: true });
  assert.match(localBusy, /Publish to cloud/);
  assert.doesNotMatch(localBusy, /Publishing…/);
});

test("room-wide settings are offered only where the server can hold them", async () => {
  const cloud = await renderPanel({ room: githubRoom, storage: cloudStorage });
  for (const testId of ["room-conversation-routing", "room-reply-order", "room-agent-guidelines", "room-github-event-filter"]) {
    assert.ok(cloud.includes(`data-testid="${testId}"`), `a cloud room offers ${testId}`);
  }
  assert.ok(cloud.includes('data-testid="desktop-room-settings-nav-conversation"'));
  // "Answer in turns" sits directly after conversation routing, in the same section.
  assert.ok(cloud.indexOf('data-testid="room-reply-order"') > cloud.indexOf('data-testid="room-conversation-routing"'));
  assert.ok(cloud.indexOf('data-testid="room-reply-order"') < cloud.indexOf('data-section="guidelines"'));
  assert.match(cloud, /Answer in turns/);

  const local = await renderPanel();
  for (const testId of ["room-conversation-routing", "room-reply-order", "room-agent-guidelines", "room-github-event-filter"]) {
    assert.ok(!local.includes(`data-testid="${testId}"`), `a local room does not offer ${testId}`);
  }
  assert.ok(!local.includes('data-testid="desktop-room-settings-nav-conversation"'));
  // The built-in contract is the same everywhere, so it is always offered.
  assert.ok(local.includes('data-testid="desktop-room-rules-card"'));
});

test("the personal chat switch says that it only changes your own view", async () => {
  const html = await renderPanel({ room: githubRoom, storage: cloudStorage, githubEventsAvailable: true, githubEventsVisible: true });
  assert.match(html, /Show GitHub events in my chat/);
  assert.match(html, /This only changes your view/);
});

test("GitHub connection displays review permission evidence separately without promising publication", async () => {
  for (const [permission, label] of [["write", "write permission recorded"], ["missing", "Pull requests (write) permission missing"],
    ["unknown", "permission unknown"], [undefined, "permission unknown"]] as const) {
    const html = await renderPanel({
      room: { ...localGitRoom, identifier: "github.com/example/project",
        gitRoom: { ...localGitRoom.gitRoom, provider: "github", host: "github.com", visibility: "private", accessMode: "private", source: "git_remote" } },
      githubStatus: { connected: true, configured: true, installUrlAvailable: true,
        repository: { fullName: "example/project" },
        ...(permission ? { reviewSubmission: { permission, recordedAt: "2026-09-22T12:00:00Z" } } : {}) },
    });
    assert.match(html, />Connected</);
    assert.ok(html.includes(`Reviews: ${label}`));
    assert.doesNotMatch(html, /Reviews: ready|Reviews: enabled|Review publication available/i);
    if (permission === "write") assert.match(html, /GitHub confirms authorization when a review is published/);
    else assert.match(html, /Ask the repository owner/);
  }
});
