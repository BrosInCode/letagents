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

async function renderPanel(overrides: Record<string, unknown> = {}): Promise<string> {
  return renderToString(createSSRApp(DesktopRoomActionPanel, {
    room: localGitRoom,
    storage: localStorage,
    roomUrl: `https://letagents.chat/in/${encodeURIComponent(localGitRoom.identifier)}`,
    copied: false,
    soundEnabled: true,
    notificationsEnabled: true,
    notificationPermission: "granted",
    liquidGlassEnabled: false,
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
  assert.match(html, /This local Git Room needs a provider-backed remote before it can use cloud storage/);
  assert.match(
    html,
    /<button type="button" data-testid="desktop-room-storage-cloud" data-active="false" disabled>/,
  );
  assert.doesNotMatch(html, /Publish to cloud/);
});

test("provider-backed rooms keep the Cloud control enabled", async () => {
  const html = await renderPanel({
    room: {
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
    },
    storage: {
      ...localStorage,
      roomIdentifier: "github.com/BrosInCode/letagents",
      overrideMode: "inherit",
      effectiveMode: "cloud",
      isLocalRoom: false,
      localRoom: null,
    },
  });

  assert.match(
    html,
    /<button type="button" data-testid="desktop-room-storage-cloud" data-active="false">/,
  );
  assert.doesNotMatch(html, /No Git provider is attached to this room/);
});
