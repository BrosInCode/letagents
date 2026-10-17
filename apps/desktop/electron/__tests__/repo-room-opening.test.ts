import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

const env = createElectronTestEnv({
  prefix: "letagents-room-opening-",
  paths: [],
  extraEnvFiles: { LETAGENTS_PROJECT_BINDINGS_PATH: "bindings.sqlite" },
});

test("opening a fetched repo room preserves its identity without calculating branch statistics", async (t) => {
  const repoPath = realpathSync(env.tempDir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  git("init", "-b", "main");
  git("remote", "add", "origin", "https://github.com/example/project.git");
  writeFileSync(join(repoPath, "tracked.txt"), "initial\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial");
  git("checkout", "-b", "feature/room");

  let fetchedSnapshot: unknown;
  let integrationPayload: Record<string, unknown> = {};
  let dialogResult: Promise<Electron.OpenDialogReturnValue> = Promise.resolve({ canceled: true, filePaths: [] });
  const pickerCalls: unknown[][] = [];
  const parentWindow = { isDestroyed: () => false };
  t.mock.module("electron", { defaultExport: { dialog: { showOpenDialog: (...args: unknown[]) => {
    pickerCalls.push(args);
    return dialogResult;
  } } } });
  t.mock.module("../main/auth.js", { namedExports: {
    apiFetch: async () => integrationPayload,
  } });
  t.mock.module("../main/window.js", { namedExports: { focusMainWindow() {}, getMainWindow: () => parentWindow } });
  t.mock.module("../main/rooms/snapshot.js", {
    namedExports: {
      fetchRoomSnapshot: async (roomIdentifier: string) => {
        fetchedSnapshot = { roomIdentifier, access: { status: "ready" }, room: { gitRoom: null } };
        return fetchedSnapshot;
      },
    },
  });
  const unused = () => { throw new Error("Unexpected room storage mutation"); };
  let allowLocalCreation = false;
  const createdRooms: Array<{ roomIdentifier: string; displayName: string }> = [];
  const localModes: Array<[string, string]> = [];
  t.mock.module("../main/rooms/local-store.js", {
    namedExports: {
      resolveLocalAwareRoomStorageMode: async () => ({ effectiveMode: "cloud" }),
      cloudRoomIdentifierForStorage: (_storage: unknown, identifier: string) => identifier,
      createLocalRoom: async (input: { roomIdentifier: string; displayName: string }) => {
        if (!allowLocalCreation) unused();
        createdRooms.push(input);
      },
      localRoomIdentifierForStorage: unused,
      setLocalAwareRoomStorageMode: async (identifier: string, mode: string) => {
        if (!allowLocalCreation) unused();
        localModes.push([identifier, mode]);
      },
      updateLocalRoomDisplayName: unused,
    },
  });
  const { connectProjectToRoom, createProjectRoom, pickNewProjectParent, pickRepoRoom, openRepoRoomFromPath, getDesktopGitHubIntegrationStatus } = await import("../main/rooms/repo.js");
  const tracePath = join(repoPath, ".git", "room-opening-trace.jsonl");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  try {
    process.env.GIT_TRACE2_EVENT = tracePath;
    const opened = await openRepoRoomFromPath(repoPath);
    assert.strictEqual(opened.snapshot, fetchedSnapshot);
    assert.equal(opened.error, null);
    assert.equal(opened.repoPath, repoPath);
    assert.equal(opened.repoStatus?.branch, "feature/room");
    assert.equal(opened.repoStatus?.roomIdentifier, opened.roomIdentifier);
    assert.ok(opened.projectBinding?.aliases.includes(`room:${opened.roomIdentifier?.toLowerCase()}`));
    assert.equal(opened.repoStatus?.branchDelta, null);
    assert.deepEqual(opened.repoStatus?.branchDeltas, []);

    const commands = readFileSync(tracePath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "start")
      .map((event) => event.argv as string[]);
    assert.equal(commands.some((argv) => argv.includes("diff")), false,
      "room opening must not wait for branch comparisons after fetching its snapshot");
    await t.test("integration status preserves review permissions and treats old servers as unknown", async () => {
      for (const permission of ["write", "missing", "unknown", undefined]) {
        integrationPayload = { connected: true, repository: { full_name: "example/project" },
          ...(permission ? { review_submission: { permission, recorded_at: "2026-09-22T12:00:00Z" } } : {}) };
        const status = await getDesktopGitHubIntegrationStatus("github.com/example/project");
        assert.equal(status.connected, true);
        assert.deepEqual(status.reviewSubmission, { permission: permission ?? "unknown",
          recordedAt: permission ? "2026-09-22T12:00:00Z" : null });
      }
    });
    await t.test("a new project room refuses the home folder, also through a home-level repository", async () => {
      const nested = join(repoPath, "code", "notes");
      mkdirSync(nested, { recursive: true });
      const previousHome = process.env.HOME;
      try {
        // A home folder that is itself a Git repository (dotfiles).
        process.env.HOME = repoPath;
        const notAProject = "Choose a project folder, not your home folder or the top of the disk.";
        assert.equal((await openRepoRoomFromPath(repoPath, { newProjectRoom: true })).error, notAProject);
        // ~/code/notes is inside it, so the room would be the home folder.
        assert.equal((await openRepoRoomFromPath("~/code/notes", { newProjectRoom: true })).error, notAProject);
        // Real paths: a link to home, or on macOS a differently cased
        // spelling, is still home even where no repository root says so.
        const plainHome = join(repoPath, "..", `${basename(repoPath)}-plain-home`);
        const homeLink = `${plainHome}-link`;
        mkdirSync(plainHome);
        symlinkSync(plainHome, homeLink);
        try {
          process.env.HOME = plainHome;
          assert.equal((await openRepoRoomFromPath(homeLink, { newProjectRoom: true })).error, notAProject);
          if (process.platform === "darwin") {
            assert.equal((await openRepoRoomFromPath(plainHome.toUpperCase(), { newProjectRoom: true })).error, notAProject);
          }
        } finally {
          rmSync(homeLink, { force: true });
          rmSync(plainHome, { recursive: true, force: true });
          process.env.HOME = repoPath;
        }

        // A room already bound to the home folder keeps reopening exactly as before.
        const reopened = await openRepoRoomFromPath(repoPath);
        assert.equal(reopened.error, null);
        assert.equal(reopened.repoPath, repoPath);
        assert.equal((await openRepoRoomFromPath("~/code/notes")).repoPath, repoPath);
      } finally {
        rmSync(join(repoPath, "code"), { recursive: true, force: true });
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
    await t.test("a typed path is checked before any room is created or folder bound", async () => {
      const filePath = join(repoPath, "tracked.txt");
      const locked = join(repoPath, "..", `${basename(repoPath)}-locked`);
      mkdirSync(locked);
      chmodSync(locked, 0o000);
      const previousHome = process.env.HOME;
      fetchedSnapshot = undefined;
      try {
        process.env.HOME = join(repoPath, "..");
        const notAProject = "Choose a project folder, not your home folder or the top of the disk.";
        for (const [path, error] of [
          [join(repoPath, "missing-folder"), "No folder exists at that path."],
          ["relative/project", "Enter the full path to the folder, starting with / or ~/."],
          [filePath, "That path is a file. Enter the folder that contains it."],
          ["   ", "Choose a project folder."],
          ["/", notAProject],
          ["~", notAProject],
          ["~/", notAProject],
          [join(locked, "project"), "LetAgents doesn’t have permission to open that folder."],
        ] as const) {
          const rejected = await openRepoRoomFromPath(path, { newProjectRoom: true });
          assert.equal(rejected.error, error, path);
          assert.equal(rejected.snapshot, null);
          assert.equal(rejected.projectBinding, null);
        }
      } finally {
        chmodSync(locked, 0o700);
        rmSync(locked, { recursive: true, force: true });
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
      // The local-store mock throws on any room creation, so reaching here
      // also proves no local room was made for the missing folder.
      assert.equal(fetchedSnapshot, undefined);

      try {
        process.env.HOME = join(repoPath, "..");
        const opened = await openRepoRoomFromPath(`~/${basename(repoPath)}`, { newProjectRoom: true });
        assert.equal(opened.error, null);
        assert.equal(opened.repoPath, repoPath);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    });
    await t.test("native folder cancellation is parented and releases the picker for retry", async () => {
      const canceled = await pickRepoRoom();
      assert.equal(canceled.canceled, true);
      assert.equal(canceled.snapshot, null);
      assert.strictEqual(pickerCalls[0][0], parentWindow);
      assert.deepEqual((pickerCalls[0][1] as Electron.OpenDialogOptions).properties, ["openDirectory"]);
      assert.equal(await pickNewProjectParent(), null);

      let resolvePicker!: (result: Electron.OpenDialogReturnValue) => void;
      dialogResult = new Promise((resolve) => { resolvePicker = resolve; });
      const pending = pickNewProjectParent();
      await assert.rejects(pickRepoRoom(), /Finish or cancel the open folder picker/);
      resolvePicker({ canceled: true, filePaths: [] });
      assert.equal(await pending, null);
      dialogResult = Promise.resolve({ canceled: false, filePaths: [repoPath] });
      assert.equal(await pickNewProjectParent(), repoPath);
    });
    await t.test("reconnecting a published local project keeps its original room and never publishes chat", async () => {
      const { resolveRoomIdentifierFromPath } = await import("../repo-status.js");
      const { bindProjectRoot } = await import("../main/project-bindings-store.js");
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "letagents-connect-published-")));
      const localPath = join(parent, "Scene Finder");
      const unrelatedPath = join(parent, "Other project");
      for (const path of [localPath, unrelatedPath]) {
        mkdirSync(path);
      }
      try {
        const plain = await resolveRoomIdentifierFromPath(localPath);
        const plainContext = { roomIdentifier: plain.roomIdentifier, gitRoom: null };
        const plainBinding = await bindProjectRoot({ context: plainContext, rootPath: localPath, source: "local_folder" });
        for (const path of [localPath, unrelatedPath]) {
          execFileSync("git", ["init", "-b", "main"], { cwd: path, stdio: "ignore" });
        }
        dialogResult = Promise.resolve({ canceled: false, filePaths: [localPath] });
        const callsBeforeConnect = pickerCalls.length;
        assert.equal((await connectProjectToRoom(plainContext)).binding?.identityKey, plainBinding.identityKey);
        assert.strictEqual(pickerCalls[callsBeforeConnect]?.[0], parentWindow,
          "the connect-project picker is a sheet on the main window");
        const local = await resolveRoomIdentifierFromPath(localPath);
        const context = { roomIdentifier: local.roomIdentifier, gitRoom: local.gitRoom };
        const original = await bindProjectRoot({ context, rootPath: localPath, source: "local_git" });
        for (const path of [localPath, unrelatedPath]) {
          execFileSync("git", ["remote", "add", "origin", "https://github.com/example/scene-finder.git"], { cwd: path });
        }
        const oldSnapshot = fetchedSnapshot;
        const roomCount = createdRooms.length;
        const modeCount = localModes.length;
        dialogResult = Promise.resolve({ canceled: false, filePaths: [unrelatedPath] });
        assert.match((await connectProjectToRoom(context)).error || "", /different project/,
          "the same remote in a different folder does not prove the original local project");
        dialogResult = Promise.resolve({ canceled: false, filePaths: [localPath] });
        const connected = await connectProjectToRoom(context);
        assert.equal(connected.error, null);
        assert.equal(connected.binding?.id, original.id);
        assert.equal(connected.binding?.identityKey, original.identityKey);
        assert.equal(connected.binding?.rootPath, localPath);
        assert.equal((await connectProjectToRoom(context)).binding?.id, original.id);
        const plainReconnected = await connectProjectToRoom(plainContext);
        assert.equal(plainReconnected.binding?.id, plainBinding.id);
        assert.equal(plainReconnected.binding?.identityKey, plainBinding.identityKey);
        assert.equal(createdRooms.length, roomCount);
        assert.equal(localModes.length, modeCount);
        assert.strictEqual(fetchedSnapshot, oldSnapshot, "connection must not create or navigate to a hosted room");
      } finally {
        dialogResult = Promise.resolve({ canceled: true, filePaths: [] });
        rmSync(parent, { recursive: true, force: true });
      }
    });
    await t.test("new projects create an empty named local folder without overwriting existing data", async () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "letagents-new-project-")));
      allowLocalCreation = true;
      try {
        const created = await createProjectRoom(parent, "  My project  ");
        const path = join(parent, "My project");
        assert.equal(created.error, null);
        assert.equal(created.source, "local_folder");
        assert.equal(created.repoPath, path);
        assert.equal(created.repoStatus?.isGitRepo, false);
        assert.equal(created.projectBinding?.rootPath, path);
        assert.deepEqual(readdirSync(path), [], "No Git repo or generated files are created");
        assert.equal(createdRooms.at(-1)?.displayName, "My project");
        assert.deepEqual(localModes.at(-1), [created.roomIdentifier, "local"]);
        const roomCount = createdRooms.length;

        writeFileSync(join(path, "keep.txt"), "keep my work");
        assert.match((await createProjectRoom(parent, "My project")).error || "", /already exists/);
        assert.equal(readFileSync(join(path, "keep.txt"), "utf8"), "keep my work");
        writeFileSync(join(parent, "existing-file"), "original");
        assert.match((await createProjectRoom(parent, "existing-file")).error || "", /already exists/);
        symlinkSync(path, join(parent, "existing-link"));
        assert.match((await createProjectRoom(parent, "existing-link")).error || "", /already exists/);
        for (const name of ["", ".", "..", "../escape", "nested/project", "nested\\project", "bad\u0000name"]) {
          assert.match((await createProjectRoom(parent, name)).error || "", /folder name/);
        }
        assert.match((await createProjectRoom(join(parent, "missing"), "Nope")).error || "", /No folder exists/);
        assert.match((await createProjectRoom(repoPath, "Nested project")).error || "", /outside an existing Git repository/);
        assert.equal(existsSync(join(repoPath, "Nested project")), false);
        assert.equal(createdRooms.length, roomCount, "Rejected inputs never create or reuse a room");
      } finally {
        allowLocalCreation = false;
        rmSync(parent, { recursive: true, force: true });
      }
    });
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
  }
});

test("only the picker and the typed-path creation flow ask for a new project room", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(source("../main/rooms/repo.ts"), /return openRepoRoomFromPath\(result\.filePaths\[0\], \{ newProjectRoom: true \}\);/);
  assert.match(source("../main/ipc-handlers/repos.ts"), /openRepoRoomFromPath\(folderPath \|\| "", \{ newProjectRoom: options\?\.newProjectRoom === true \}\)/);
  assert.match(source("../preload.ts"), /openRoom: \(rootPath, options\) => ipcRenderer\.invoke\("desktop:repos:open-room", rootPath, options \?\? null\)/);
});
