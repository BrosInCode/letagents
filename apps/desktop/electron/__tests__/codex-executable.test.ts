import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  installedCodexExecutablePath,
  resolveCodexExecutable,
} from "../main/agents/codex-executable.js";

async function executable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

test("Codex resolution falls back to the official standalone install outside PATH", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "letagents-codex-home-"));
  const installed = join(homeDirectory, ".local", "bin", "codex");
  await executable(installed);

  assert.equal(resolveCodexExecutable({
    env: { PATH: "/usr/bin:/bin" },
    homeDirectory,
    platform: "darwin",
  }), installed);
});

test("Codex resolution preserves an existing PATH installation", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "letagents-codex-home-"));
  const pathDirectory = await mkdtemp(join(tmpdir(), "letagents-codex-path-"));
  const pathCodex = join(pathDirectory, "codex");
  await executable(pathCodex);
  await executable(join(homeDirectory, ".local", "bin", "codex"));

  assert.equal(resolveCodexExecutable({
    env: { PATH: pathDirectory },
    homeDirectory,
    platform: "darwin",
  }), pathCodex);
});

test("Codex resolution honors explicit executable and install directory overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "letagents-codex-override-"));
  const configured = join(root, "custom-codex");
  const installDirectory = join(root, "installed");

  assert.equal(resolveCodexExecutable({
    env: { LETAGENTS_CODEX_BIN: configured, PATH: "" },
    homeDirectory: root,
    platform: "darwin",
  }), configured);
  assert.equal(installedCodexExecutablePath({
    env: { CODEX_INSTALL_DIR: installDirectory },
    homeDirectory: root,
    platform: "darwin",
  }), join(installDirectory, "codex"));
});

test("Codex standalone path matches the official Windows installer default", () => {
  assert.equal(installedCodexExecutablePath({
    env: { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
    homeDirectory: "C:\\Users\\Ada",
    platform: "win32",
  }), join("C:\\Users\\Ada\\AppData\\Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe"));
});
