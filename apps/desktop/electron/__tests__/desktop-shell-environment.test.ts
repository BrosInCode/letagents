import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  desktopRuntimeEnvironment,
  hydrateDesktopShellEnvironment,
  mergeDesktopPath,
  refreshDesktopShellEnvironment,
  resetDesktopShellEnvironmentForTests,
} from "../main/desktop-shell-environment.js";

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
