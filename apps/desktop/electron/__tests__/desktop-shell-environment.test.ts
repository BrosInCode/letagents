import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  desktopRuntimeEnvironment,
  hydrateDesktopShellEnvironment,
  mergeDesktopPath,
  refreshDesktopShellEnvironment,
  resetDesktopShellEnvironmentForTests,
  startDesktopShellEnvironmentHydration,
} from "../main/desktop-shell-environment.js";
import { runGit, runGitStdout } from "../main/git-exec.js";

const desktopMainSource = readFileSync(
  fileURLToPath(new URL("../main.ts", import.meta.url)),
  "utf8",
);

test("desktop startup creates the window without awaiting login-shell discovery", () => {
  const backgroundStart = desktopMainSource.indexOf("const backgroundStartup = (async () => {");
  const packagedSmoke = desktopMainSource.indexOf("if (process.env.LETAGENTS_PACKAGED_SUPERVISOR_SMOKE", backgroundStart);
  const packagedSmokeReturn = desktopMainSource.indexOf("return;", packagedSmoke);
  const windowCreation = desktopMainSource.indexOf("createWindow();", backgroundStart);
  const detachedBackground = desktopMainSource.indexOf("void backgroundStartup;", windowCreation);
  assert.ok(backgroundStart >= 0);
  assert.ok(packagedSmoke > backgroundStart);
  assert.ok(packagedSmokeReturn > packagedSmoke);
  assert.ok(windowCreation > backgroundStart);
  assert.ok(windowCreation > packagedSmokeReturn);
  assert.ok(detachedBackground > windowCreation);
  assert.doesNotMatch(
    desktopMainSource.slice(packagedSmokeReturn, windowCreation),
    /await backgroundStartup/,
  );
});

test("desktop PATH hydration imports login-shell CLI locations without rewriting process inputs", async () => {
  resetDesktopShellEnvironmentForTests();
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/zsh",
  };
  const calls: Array<{ command: string; args: string[] }> = [];

  const result = await hydrateDesktopShellEnvironment({
    env,
    platform: "darwin",
    homeDirectory: "/Users/ada",
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return "profile output\n__LETAGENTS_PATH_START__\n/Users/ada/.npm/bin:/opt/homebrew/bin:/usr/bin\n__LETAGENTS_PATH_END__\n";
    },
  });

  assert.equal(calls[0]?.command, "/bin/zsh");
  assert.match(calls[0]?.args.join(" ") || "", /-ilc/);
  assert.equal(
    result.environment.PATH,
    "/Users/ada/.npm/bin:/opt/homebrew/bin:/usr/bin:/Users/ada/.local/bin:/Users/ada/.volta/bin:/Users/ada/.bun/bin:/usr/local/bin:/bin",
  );
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(desktopRuntimeEnvironment(env).PATH, result.environment.PATH);
});

test("desktop PATH hydration preserves the active NVM runtime ahead of stale global CLIs", async () => {
  resetDesktopShellEnvironmentForTests();
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/Users/ada/.nvm/versions/node/v22/bin:/usr/bin",
    NVM_BIN: "/Users/ada/.nvm/versions/node/v22/bin",
    SHELL: "/bin/zsh",
  };

  const result = await hydrateDesktopShellEnvironment({
    env,
    platform: "darwin",
    homeDirectory: "/Users/ada",
    runCommand: async () => (
      "__LETAGENTS_PATH_START__\n/usr/local/bin:/Users/ada/.nvm/versions/node/v22/bin:/usr/bin\n__LETAGENTS_PATH_END__\n"
    ),
  });

  assert.equal(
    result.environment.PATH,
    "/Users/ada/.nvm/versions/node/v22/bin:/usr/local/bin:/usr/bin:/Users/ada/.local/bin:/Users/ada/.volta/bin:/Users/ada/.bun/bin:/opt/homebrew/bin",
  );
});

test("desktop PATH hydration is non-fatal when shell discovery fails", async () => {
  resetDesktopShellEnvironmentForTests();
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

  const result = await hydrateDesktopShellEnvironment({
    env,
    platform: "linux",
    homeDirectory: "/home/ada",
    runCommand: async () => {
      throw new Error("shell unavailable");
    },
  });

  assert.equal(
    result.environment.PATH,
    "/home/ada/.local/bin:/home/ada/.volta/bin:/home/ada/.bun/bin:/usr/local/bin:/usr/bin:/bin",
  );
  assert.equal(env.PATH, "/usr/bin:/bin");
});

test("Windows PATH merging is case-insensitive and uses semicolons", () => {
  assert.equal(
    mergeDesktopPath(["C:\\Tools;C:\\Users\\Ada\\bin", "c:\\tools;C:\\Windows"], "win32"),
    "C:\\Tools;C:\\Users\\Ada\\bin;C:\\Windows",
  );
});

test("Windows PATH merging preserves quoted entries containing semicolons", () => {
  assert.equal(
    mergeDesktopPath(['"C:\\Program Files\\Foo;Legacy";C:\\Windows', '"c:\\program files\\foo;legacy";C:\\Tools'], "win32"),
    '"C:\\Program Files\\Foo;Legacy";C:\\Windows;C:\\Tools',
  );
});

test("desktop environment refreshes are single-flight", async () => {
  resetDesktopShellEnvironmentForTests();
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const options = {
    env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
    platform: "darwin" as const,
    homeDirectory: "/Users/ada",
    runCommand: async () => {
      calls += 1;
      await blocked;
      return "__LETAGENTS_PATH_START__\n/Users/ada/bin:/usr/bin\n__LETAGENTS_PATH_END__\n";
    },
  };
  const first = refreshDesktopShellEnvironment(options);
  const second = refreshDesktopShellEnvironment(options);
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("desktop environment refresh reports only a real PATH transition", async () => {
  resetDesktopShellEnvironmentForTests();
  let discoveredPath = "/Users/ada/first:/usr/bin";
  const options = {
    env: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
    platform: "darwin" as const,
    homeDirectory: "/Users/ada",
    runCommand: async () =>
      `__LETAGENTS_PATH_START__\n${discoveredPath}\n__LETAGENTS_PATH_END__\n`,
  };

  assert.equal((await refreshDesktopShellEnvironment(options)).changed, false);
  assert.equal((await refreshDesktopShellEnvironment(options)).changed, false);
  discoveredPath = "/Users/ada/second:/usr/bin";
  const refreshed = await refreshDesktopShellEnvironment(options);
  assert.equal(refreshed.changed, true);
  assert.match(refreshed.environment.PATH || "", /^\/Users\/ada\/second:/);
});

test("desktop Git waits for shell discovery and uses its working Git instead of the GUI shim", { skip: process.platform === "win32" }, async () => {
  resetDesktopShellEnvironmentForTests();
  const temporary = mkdtempSync(join(tmpdir(), "letagents-git-path-"));
  const guiBin = join(temporary, "gui");
  const shellBin = join(temporary, "shell");
  mkdirSync(guiBin);
  mkdirSync(shellBin);
  writeFileSync(join(guiBin, "git"), "#!/bin/sh\necho 'You have not agreed to the Xcode license agreements.' >&2\nexit 69\n", { mode: 0o755 });
  writeFileSync(join(shellBin, "git"), '#!/bin/sh\nprintf "working-git:%s:%s\\n" "$LC_ALL" "$LETAGENTS_GIT_TEST_VALUE"\n', { mode: 0o755 });
  const previousPath = process.env.PATH;
  const previousValue = process.env.LETAGENTS_GIT_TEST_VALUE;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let discoveryCalls = 0;
  try {
    process.env.PATH = guiBin;
    process.env.LETAGENTS_GIT_TEST_VALUE = "retained";
    const hydration = startDesktopShellEnvironmentHydration({
      env: { PATH: guiBin }, platform: "darwin", homeDirectory: temporary,
      runCommand: async () => {
        discoveryCalls += 1;
        await blocked;
        return `__LETAGENTS_PATH_START__\n${shellBin}\n__LETAGENTS_PATH_END__\n`;
      },
    });
    const first = runGitStdout(temporary, ["--version"]);
    const second = runGitStdout(temporary, ["--version"]);
    const controller = new AbortController();
    const canceled = runGit(temporary, ["--version"], { signal: controller.signal });
    controller.abort(new Error("Git request canceled"));
    release();
    await hydration;
    assert.deepEqual(await Promise.all([first, second]), ["working-git:C:retained\n", "working-git:C:retained\n"]);
    assert.equal(discoveryCalls, 1);
    assert.equal(process.env.PATH, guiBin, "Git must not rewrite the app's inherited environment");
    assert.match((await canceled).stderr, /Git request canceled/);
    const missingCwd = await runGit(join(temporary, "missing"), ["--version"]);
    assert.notEqual(missingCwd.code, 0);
    assert.match(missingCwd.stderr, /ENOENT/, "spawn errors with empty stderr retain their diagnostic");
  } finally {
    release();
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousValue === undefined) delete process.env.LETAGENTS_GIT_TEST_VALUE;
    else process.env.LETAGENTS_GIT_TEST_VALUE = previousValue;
    resetDesktopShellEnvironmentForTests();
    rmSync(temporary, { recursive: true, force: true });
  }
});
