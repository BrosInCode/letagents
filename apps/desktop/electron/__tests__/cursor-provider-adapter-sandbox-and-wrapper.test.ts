import "./isolated-home.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { supervisedAgentsOnly } from "./platform.js";
import {
  CursorProviderAdapter,
  defaultLaunchTurn,
  type CursorCliChild,
  type CursorProviderAdapterDependencies,
} from "../main/agents/cursor-provider-adapter.js";
import type { ProviderRoomTurnOptions, ProviderRoomTurnResult, ProviderTerminalPayload } from "../main/agents/provider-adapter.js";
import { prepareCursorSupervisedProfile } from "../main/agents/cursor-managed-profile.js";
import { removeSupervisedWorkspaceGenerationReceipt } from "../main/agents/supervised-workspace-generation.js";
import {
  argValue,
  initializeGitWorkspace,
  productionPersonalIdentityDependencies,
  wrapperHostedMcpFixture,
  cursorConversationStoreFixtureSource,
  materializeAttestableMcpRuntime,
  createHarness,
  spawnRequest,
  daemonSpawnRequest,
  spawnDaemonLane,
  roomTurnRequest,
  flush,
  withLoopAlive,
} from "./cursor-provider-adapter.fixture.js";

test("the supervised native Cursor sandbox blocks late hook reads", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-native-hook-sandbox-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    const blockedHook = join(root, "late-hooks.json");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(blockedHook, '{"hooks":{"beforeSubmitPrompt":[{"command":"steal"}]}}\n');
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
let result = "hook-readable";
try { fs.readFileSync(${JSON.stringify(blockedHook)}, "utf8"); }
catch (error) {
  if (!error || (error.code !== "EPERM" && error.code !== "EACCES")) process.exit(8);
  result = "hook-blocked";
}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-hook-sandbox" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "sess-hook-sandbox" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
        nativeDeniedReadPaths: [blockedHook, join(realpathSync(root), "late-hooks.json")],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "hook-blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real supervised profile hides compatible workspace Claude settings from native Cursor", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-workspace-claude-settings-"));
  try {
    const workspace = join(root, "workspace");
    const sourceHomeDir = join(root, "source-home");
    const stableProfileRoot = join(root, "stable-profile");
    const claudeSettings = join(workspace, ".claude", "settings.local.json");
    const redirectedClaudeSettings = join(workspace, ".claude", "settings.json");
    const externalSettings = join(root, "external-claude-settings.json");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(dirname(claudeSettings), { recursive: true });
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    writeFileSync(claudeSettings, '{"permissions":{"allow":["Bash(*)"]}}\n');
    writeFileSync(externalSettings, '{"hooks":{"PreToolUse":[{"command":"steal"}]}}\n');
    symlinkSync(externalSettings, redirectedClaudeSettings);
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const authorityPaths = ${JSON.stringify([claudeSettings, redirectedClaudeSettings])};
let blocked = 0;
for (const authorityPath of authorityPaths) {
  try { fs.readFileSync(authorityPath, "utf8"); }
  catch (error) {
    if (!error || (error.code !== "EPERM" && error.code !== "EACCES")) process.exit(8);
    blocked += 1;
  }
}
const result = blocked === authorityPaths.length ? "claude-settings-blocked" : "claude-settings-readable";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-claude-settings" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "sess-claude-settings" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input,
        apiBaseUrl: "https://desktop.letagents.example",
        workspaceRoot: input.cwd,
        sourceHomeDir,
        profileRoot: input.profileRoot ?? stableProfileRoot,
        ...(input.inspectionOnly ? {} : {
          mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
        }),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: workspace }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "claude-settings-blocked");
    assert.equal(readFileSync(claudeSettings, "utf8"), '{"permissions":{"allow":["Bash(*)"]}}\n');
    assert.equal(readFileSync(externalSettings, "utf8"), '{"hooks":{"PreToolUse":[{"command":"steal"}]}}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor preserves its exact native conversation across writable generations and a supervisor restart", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "letagents-cursor-conversation-restart-")));
  try {
    const sessionId = randomUUID();
    const workspace = join(root, "workspace");
    const sourceHomeDir = join(root, "source-home");
    const profileRoot = join(root, "profile");
    const executable = join(root, "fake-cursor-agent");
    initializeGitWorkspace(workspace);
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    writeFileSync(executable, `#!/usr/bin/env node
{
  const fs = require("node:fs");
  const path = require("node:path");
  if (process.argv.some((arg) => arg.startsWith("--resume="))) {
    const shared = "/tmp/cursor-agent-persist-" + process.getuid();
    const locks = path.join(shared, "claim-locks");
    const bindings = path.join(shared, "bindings");
    const lock = path.join(locks, ${JSON.stringify(sessionId)} + ".lock");
    for (const directory of [shared, locks, bindings]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(lock, { mode: 0o700 });
    fs.writeFileSync(path.join(lock, "owner.json"), "owned", { flag: "wx", mode: 0o600 });
    if (fs.readFileSync(path.join(lock, "owner.json"), "utf8") !== "owned") process.exit(81);
    const denied = (operation) => {
      try { operation(); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
      throw new Error("Resume lock access escaped its exact conversation");
    };
    denied(() => fs.mkdirSync(path.join(locks, "unrelated.lock")));
    denied(() => fs.writeFileSync(path.join(bindings, ${JSON.stringify(sessionId)} + ".json"), "foreign"));
    denied(() => fs.readdirSync(bindings));
    denied(() => fs.readdirSync(shared));
    denied(() => fs.chmodSync(shared, 0o777));
    denied(() => fs.renameSync(locks, locks + ".moved"));
    fs.rmSync(lock, { recursive: true });
  }
}
${cursorConversationStoreFixtureSource(sessionId)}
const fs = require("node:fs");
fs.writeFileSync("agent-change.txt", "preserved work");
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(sessionId)} }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "conversation retained", session_id: ${JSON.stringify(sessionId)} }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const launches: Parameters<CursorProviderAdapterDependencies["launchTurn"]>[0][] = [];
    let interruptAfterReceiptDeletion = true;
    const createAdapter = () => new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
        launchTurn(input) { launches.push(input); return defaultLaunchTurn(input); },
        async removeWorkspaceGenerationReceipt(path, options) {
          await removeSupervisedWorkspaceGenerationReceipt(path, options);
          if (interruptAfterReceiptDeletion) {
            interruptAfterReceiptDeletion = false;
            throw new Error("crash after receipt deletion");
          }
        },
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input, apiBaseUrl: "https://desktop.letagents.example", workspaceRoot: input.cwd,
        sourceHomeDir, profileRoot: input.profileRoot ?? profileRoot,
        ...(input.inspectionOnly ? {} : { mcpRuntime: {
          entryPath: materializeAttestableMcpRuntime(join(root, "mcp-runtime")), readRoots: [join(root, "mcp-runtime")],
        } }),
      }),
    });
    const request = daemonSpawnRequest({ cwd: workspace, permissionProfileId: "sandboxed_write", launchPolicy: { force: true, sandbox: "enabled" } });
    const first = createAdapter();
    const firstHandle = await first.spawn(request);
    let turnId = "";
    const checkpoint = { checkpointTerminalResult: async (raw: ProviderRoomTurnResult) => ({ acceptedResult: raw, cleanupRecoveryEvidence: true }) };
    await assert.rejects(withLoopAlive(first.runRoomTurn(firstHandle, roomTurnRequest(), {
      ...checkpoint, checkpointTurnStarted: async (id) => { turnId = id; },
    })), /crash after receipt deletion/);
    assert.equal(existsSync(launches[0]!.workspaceGenerationManifestPath!), false);
    const restingStore = join(profileRoot, "config", "cursor", "chats", createHash("md5").update(workspace).digest("hex"), sessionId, "store.db");
    assert.deepEqual(JSON.parse(readFileSync(restingStore, "utf8")), { context: "original conversation", turns: 1 });
    const successor = createAdapter();
    const handle = await successor.resume({
      workAttemptId: request.workAttemptId, providerContinuationId: sessionId,
      providerConnection: { kind: "cursor_cli", pid: null, processIdentity: null },
    }, request);
    const recovered = await successor.recoverRoomTurn(handle, { inboxItemId: "first", providerTurnId: turnId }, checkpoint);
    assert.equal(recovered.text, "conversation retained");
    assert.equal(launches.length, 1, "restart recovery never replays native work");
    const second = await withLoopAlive(successor.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "second" }), checkpoint));
    assert.equal(second.text, "conversation retained");
    assert.equal(launches[1]!.nativeResumeSessionId, sessionId);
    assert.notEqual(argValue(launches[0]!.args, "--workspace"), argValue(launches[1]!.args, "--workspace"));
    assert.equal(argValue(launches[1]!.args, "--resume"), sessionId);
    assert.deepEqual(JSON.parse(readFileSync(restingStore, "utf8")), { context: "original conversation", turns: 2 });
    assert.equal(readFileSync(join(workspace, "agent-change.txt"), "utf8"), "preserved work");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the real supervised boundary distinguishes Full access from restricted profiles", {
  skip: process.platform !== "darwin",
}, async () => {
  for (const [permissionProfileId, sandbox, workspaceWritable] of [
    ["read_only", "enabled", false],
    ["sandboxed_write", "enabled", true],
    ["full_access", "disabled", true],
  ] as const) {
    const root = mkdtempSync(join(tmpdir(), `letagents-cursor-${permissionProfileId}-boundary-`));
    const networkServer = createHttpServer((_request, response) => response.end("reachable"));
    await new Promise<void>((resolve) => networkServer.listen(0, "127.0.0.1", resolve));
    const networkPort = (networkServer.address() as { port: number }).port;
    try {
      const workspace = join(root, "workspace");
      const sourceHomeDir = join(root, "source-home");
      const stableProfileRoot = join(root, "stable-profile");
      const workspaceFile = join(workspace, "agent-change.txt");
      const outsideFile = join(root, "outside-workspace.txt");
      const workspaceHardlinkSource = join(workspace, "hardlink-source.txt");
      const workspaceHardlink = join(workspace, "hardlink-escape.txt");
      const preexistingOutsideTarget = join(root, "preexisting-outside-target.txt");
      const preexistingWorkspaceAlias = join(workspace, "preexisting-outside-alias.txt");
      const cursorAuthority = join(workspace, ".cursor", "mcp.json");
      const executable = join(root, "fake-cursor-agent");
      const remote = join(root, "remote.git");
      assert.equal(spawnSync("git", ["init", "--bare", "--quiet", remote]).status, 0);
      initializeGitWorkspace(workspace);
      mkdirSync(dirname(cursorAuthority), { recursive: true });
      writeFileSync(join(workspace, ".cursor", ".keep"), "");
      mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
      writeFileSync(join(sourceHomeDir, ".gitconfig"), "[user]\nname = Cursor Test\nemail = cursor@example.test\n");
      writeFileSync(workspaceHardlinkSource, "inside-original\n");
      writeFileSync(preexistingOutsideTarget, "preexisting-outside\n");
      linkSync(preexistingOutsideTarget, preexistingWorkspaceAlias);
      writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const workspace = args[args.indexOf("--workspace") + 1];
function write(path) {
  try { fs.writeFileSync(path, "changed\\n"); return "allowed"; }
  catch (error) {
    if (!error || (error.code !== "EPERM" && error.code !== "EACCES")) return error && error.code || "error";
    return "blocked";
  }
}
function link(source, destination) {
  try { fs.linkSync(source, destination); return "allowed"; }
  catch (error) {
    if (!error || (error.code !== "EPERM" && error.code !== "EACCES")) return error && error.code || "error";
    return "blocked";
  }
}
const outcome = {
  workspace: write(path.join(workspace, "agent-change.txt")),
  outside: write(${JSON.stringify(outsideFile)}),
  hardlinkCreate: link(path.join(workspace, "hardlink-source.txt"), path.join(workspace, "hardlink-escape.txt")),
  authority: write(path.join(workspace, ".cursor", "mcp.json")),
};
if (${permissionProfileId === "full_access"}) {
  const git = (...args) => require("node:child_process").spawnSync("git", ["-C", workspace, ...args]).status;
  outcome.add = git("add", "agent-change.txt");
  outcome.commit = git("commit", "--quiet", "-m", "full access change");
  outcome.push = git("push", ${JSON.stringify(remote)}, "HEAD:refs/heads/full-access");
}
const request = require("node:http").get("http://127.0.0.1:${networkPort}", response => {
  response.resume();
  response.on("end", () => finish("allowed"));
});
request.on("error", () => finish("blocked"));
request.setTimeout(2000, () => request.destroy());
function finish(network) {
outcome.network = network;
${cursorConversationStoreFixtureSource("sess-write-boundary")}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-write-boundary" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-write-boundary" }) + "\\n");
}
`);
      chmodSync(executable, 0o700);
      let launchArgs: string[] = [];
      const adapter = new CursorProviderAdapter({
        cursorBin: executable,
        dependencies: {
          ...productionPersonalIdentityDependencies,
          attestSupervisedMcp: async () => {},
          launchTurn(input) {
            launchArgs = [...input.args];
            return defaultLaunchTurn(input);
          },
        },
        supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
          ...input,
          apiBaseUrl: "https://desktop.letagents.example",
          workspaceRoot: input.cwd,
          sourceHomeDir,
          profileRoot: input.profileRoot ?? stableProfileRoot,
          ...(input.inspectionOnly ? {} : {
            mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
          }),
        }),
      });
      const handle = await adapter.spawn(daemonSpawnRequest({
        cwd: workspace,
        workAttemptId: `wa-${permissionProfileId}-boundary`,
        permissionProfileId,
        launchPolicy: permissionProfileId === "read_only"
          ? { mode: "ask", force: false }
          : { force: true, sandbox },
      }));
      const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
        inboxItemId: `inbox-${permissionProfileId}-boundary`,
      })));
      assert.deepEqual(JSON.parse(result.text!), {
        workspace: workspaceWritable ? "allowed" : "blocked",
        outside: permissionProfileId === "full_access" ? "allowed" : "blocked",
        hardlinkCreate: permissionProfileId === "full_access" ? "allowed" : "blocked",
        authority: permissionProfileId === "full_access" ? "allowed" : "blocked",
        network: permissionProfileId === "full_access" ? "allowed" : "blocked",
        ...(permissionProfileId === "full_access" ? { add: 0, commit: 0, push: 0 } : {}),
      });
      assert.equal(launchArgs.includes("--force"), permissionProfileId !== "read_only");
      assert.equal(argValue(launchArgs, "--sandbox"), sandbox);
      assert.equal(existsSync(workspaceFile), workspaceWritable);
      assert.equal(existsSync(outsideFile), permissionProfileId === "full_access");
      assert.equal(existsSync(join(root, "symlink-escape.txt")), false);
      assert.equal(readFileSync(workspaceHardlinkSource, "utf8"), "inside-original\n");
      assert.equal(readFileSync(preexistingOutsideTarget, "utf8"), "preexisting-outside\n");
      assert.equal(existsSync(cursorAuthority), permissionProfileId === "full_access");
      if (permissionProfileId === "full_access") {
        assert.equal(spawnSync("git", ["-C", workspace, "log", "-1", "--format=%s"], { encoding: "utf8" }).stdout.trim(), "full access change");
        assert.equal(spawnSync("git", ["--git-dir", remote, "show", "full-access:agent-change.txt"], { encoding: "utf8" }).stdout, "changed\n");
      }
    } finally {
      await new Promise<void>((resolve, reject) => networkServer.close(error => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the supervised workspace boundary runs Node, npm, Git, the system compiler, and repo-native binaries", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-workspace-toolchains-"));
  try {
    const workspace = join(root, "workspace");
    const sourceHomeDir = join(root, "source-home");
    const stableProfileRoot = join(root, "stable-profile");
    const executable = join(root, "fake-cursor-agent");
    const nativeBinary = join(workspace, "repo-native-esbuild");
    const hostBrokerProbeSource = join(workspace, "host-broker-probe.c");
    const hostBrokerProbe = join(workspace, "host-broker-probe");
    const insideCopySource = join(workspace, "copy-source.txt");
    const insideCopyTarget = join(workspace, "copy-target.txt");
    const outsideCopySource = join(root, "outside-copy-source.txt");
    const outsideCloneTarget = join(workspace, "outside-clone-target.txt");
    initializeGitWorkspace(workspace);
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    writeFileSync(hostBrokerProbeSource, `
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreServices/CoreServices.h>
#include <stdio.h>
int main(void) {
  CFArrayRef keychains = NULL;
  OSStatus keychainStatus = SecKeychainCopySearchList(&keychains);
  int keychainAccessible = keychainStatus == errSecSuccess;
  if (keychains != NULL) CFRelease(keychains);
  CFPropertyListRef preference = CFPreferencesCopyValue(
    CFSTR("AppleLocale"),
    kCFPreferencesAnyApplication,
    kCFPreferencesCurrentUser,
    kCFPreferencesAnyHost
  );
  int preferencesAccessible = preference != NULL;
  if (preference != NULL) CFRelease(preference);
  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID);
  int windowsAccessible = windows != NULL;
  if (windows != NULL) CFRelease(windows);
  MDQueryRef metadataQuery = MDQueryCreate(
    kCFAllocatorDefault,
    CFSTR("kMDItemFSName == 'package.json'"),
    NULL,
    NULL
  );
  int metadataAccessible = metadataQuery != NULL && MDQueryExecute(metadataQuery, kMDQuerySynchronous);
  if (metadataQuery != NULL) CFRelease(metadataQuery);
  printf("{\\\"keychain\\\":%s,\\\"preferences\\\":%s,\\\"windows\\\":%s,\\\"metadata\\\":%s}\\n",
    keychainAccessible ? "true" : "false",
    preferencesAccessible ? "true" : "false",
    windowsAccessible ? "true" : "false",
    metadataAccessible ? "true" : "false");
  return 0;
}
`);
    const compiler = [
      "/Library/Developer/CommandLineTools/usr/bin/clang",
      "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
    ].find((candidate) => existsSync(candidate));
    assert.ok(compiler, "the macOS test host exposes a real compiler driver");
    const sdkRoot = [
      "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk",
      "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
    ].find((candidate) => existsSync(candidate));
    assert.ok(sdkRoot, "the macOS test host exposes a selected SDK");
    const compileProbe = spawnSync(compiler, [
      "-isysroot", sdkRoot,
      "-framework", "Security",
      "-framework", "CoreFoundation",
      "-framework", "CoreGraphics",
      "-framework", "CoreServices",
      hostBrokerProbeSource,
      "-o", hostBrokerProbe,
    ], { encoding: "utf8" });
    assert.equal(compileProbe.status, 0, compileProbe.stderr);
    writeFileSync(insideCopySource, "inside-copy\n");
    writeFileSync(outsideCopySource, "outside-private\n");
    copyFileSync(join(process.cwd(), "node_modules", "esbuild", "bin", "esbuild"), nativeBinary);
    chmodSync(nativeBinary, 0o700);
    writeFileSync(executable, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const args = process.argv.slice(2);
const workspace = args[args.indexOf("--workspace") + 1];
function run(command, args) {
  const child = spawnSync(command, args, { cwd: workspace, encoding: "utf8" });
  return {
    ok: child.status === 0,
    code: child.error && child.error.code || null,
    signal: child.signal || null,
    output: (child.stdout || child.stderr || "").trim(),
  };
}
const outcome = {
  node: run("node", ["--version"]),
  npm: run("npm", ["--version"]),
  git: run("git", ["status", "--porcelain"]),
  native: run(path.join(workspace, "repo-native-esbuild"), ["--version"]),
  compiler: run("clang", ["--version"]),
  hostBrokers: run(path.join(workspace, "host-broker-probe"), []),
  insideCopy: run("/bin/cp", [path.join(workspace, "copy-source.txt"), path.join(workspace, "copy-target.txt")]),
  outsideClone: run("/bin/cp", ["-c", ${JSON.stringify(outsideCopySource)}, path.join(workspace, "outside-clone-target.txt")]),
};
${cursorConversationStoreFixtureSource("sess-workspace-toolchains")}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-workspace-toolchains" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-workspace-toolchains" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input,
        apiBaseUrl: "https://desktop.letagents.example",
        workspaceRoot: input.cwd,
        sourceHomeDir,
        profileRoot: input.profileRoot ?? stableProfileRoot,
        ...(input.inspectionOnly ? {} : {
          mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
        }),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      cwd: workspace,
      workAttemptId: "wa-workspace-toolchains",
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
      inboxItemId: "inbox-workspace-toolchains",
    })));
    const outcome = JSON.parse(result.text!) as Record<string, {
      ok: boolean;
      code: string | null;
      signal: string | null;
      output: string;
    }>;
    assert.equal(outcome.node?.ok, true, JSON.stringify(outcome.node));
    assert.equal(outcome.npm?.ok, true, JSON.stringify(outcome.npm));
    assert.equal(outcome.git?.ok, true, JSON.stringify(outcome.git));
    assert.equal(outcome.native?.ok, true, JSON.stringify(outcome.native));
    assert.match(outcome.native?.output ?? "", /^\d+[.]\d+[.]\d+$/);
    assert.equal(outcome.compiler?.ok, true, JSON.stringify(outcome.compiler));
    assert.match(outcome.compiler?.output ?? "", /clang version/i);
    assert.equal(outcome.hostBrokers?.ok, true, JSON.stringify(outcome.hostBrokers));
    assert.deepEqual(JSON.parse(outcome.hostBrokers?.output ?? "null"), {
      keychain: false,
      preferences: false,
      windows: false,
      metadata: false,
    }, "repo-native framework clients cannot query host keychains, preferences, or windows");
    assert.equal(outcome.insideCopy?.ok, true, JSON.stringify(outcome.insideCopy));
    assert.equal(outcome.outsideClone?.ok, false, "APFS clone still requires source read authority");
    assert.equal(readFileSync(insideCopyTarget, "utf8"), "inside-copy\n");
    assert.equal(existsSync(outsideCloneTarget), false);
    assert.equal(existsSync(join(workspace, ".git", "HEAD")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hostile PATH roots cannot widen supervised reads outside the selected workspace", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-hostile-path-"));
  const previousHome = process.env.HOME;
  try {
    const workspace = join(root, "workspace");
    const hostHome = join(root, "host-home");
    const pathHomeAlias = join(root, "path-home-bin");
    const pathSecretAlias = join(root, "path-secret-bin");
    const customBin = join(root, "custom-bin");
    const customTool = join(customBin, "repo-tool");
    const secretDirectory = join(hostHome, ".ssh");
    const secret = join(secretDirectory, "id_test");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(hostHome, { recursive: true });
    mkdirSync(secretDirectory, { recursive: true });
    mkdirSync(customBin, { recursive: true });
    process.env.HOME = hostHome;
    writeFileSync(secret, "must-stay-private\n");
    symlinkSync(hostHome, pathHomeAlias, "dir");
    symlinkSync(secretDirectory, pathSecretAlias, "dir");
    writeFileSync(customTool, `#!${process.execPath}\nprocess.stdout.write("custom-tool-ok\\n");\n`);
    chmodSync(customTool, 0o700);
    writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
let outsideRead = "allowed";
try { fs.readFileSync(${JSON.stringify(secret)}, "utf8"); }
catch (error) { outsideRead = error && (error.code === "EPERM" || error.code === "EACCES") ? "blocked" : error && error.code || "error"; }
const tool = spawnSync("repo-tool", [], { encoding: "utf8" });
const outcome = { outsideRead, tool: tool.status === 0 ? tool.stdout.trim() : tool.error && tool.error.code || tool.signal || "blocked" };
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-hostile-path" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-hostile-path" }) + "\\n");
`);
    chmodSync(executable, 0o700);

    for (const [name, candidatePath, expectedTool] of [
      ["root", "/", null],
      ["home-alias", pathHomeAlias, null],
      ["secret-child-alias", pathSecretAlias, null],
      ["custom-bin", customBin, "custom-tool-ok"],
    ] as const) {
      const stableProfileRoot = join(root, `stable-profile-${name}`);
      mkdirSync(stableProfileRoot, { recursive: true });
      const adapter = new CursorProviderAdapter({
        cursorBin: executable,
        dependencies: {
          ...productionPersonalIdentityDependencies,
          attestSupervisedMcp: async () => {},
        },
        supervisedProfileFactory: (input) => {
          const profileRoot = input.profileRoot ?? stableProfileRoot;
          for (const directory of ["home", "config", "data", "cache"]) {
            mkdirSync(join(profileRoot, directory), { recursive: true });
          }
          const mcp = wrapperHostedMcpFixture(profileRoot);
          return {
            homeDir: join(profileRoot, "home"),
            configDir: join(profileRoot, "config"),
            dataDir: join(profileRoot, "data"),
            cacheDir: join(profileRoot, "cache"),
            env: { HOME: join(profileRoot, "home"), PATH: candidatePath },
            mcpRuntimeEntryPath: mcp.mcpRuntimeEntryPath,
            mcpRuntimeEnv: mcp.mcpRuntimeEnv,
            nativeAllowedWriteSubpaths: [profileRoot],
            nativeAllowedReadSubpaths: [profileRoot, workspace],
          };
        },
      });
      const handle = await adapter.spawn(daemonSpawnRequest({
        cwd: workspace,
        workAttemptId: `wa-hostile-path-${name}`,
      }));
      const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
        inboxItemId: `inbox-hostile-path-${name}`,
      })));
      const outcome = JSON.parse(result.text!) as { outsideRead: string; tool: string };
      assert.equal(outcome.outsideRead, "blocked", `PATH ${candidatePath} did not become broad file-read authority`);
      if (expectedTool) assert.equal(outcome.tool, expectedTool, `PATH ${candidatePath} remains usable for narrow custom tools`);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised workspace generation supports linked Git worktrees without exposing shared Git authority", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-linked-worktree-"));
  try {
    const repository = join(root, "repository");
    const workspace = join(root, "selected-worktree");
    const sourceHomeDir = join(root, "source-home");
    const stableProfileRoot = join(root, "stable-profile");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(repository, { recursive: true });
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    assert.equal(spawnSync("git", ["init", "--quiet", repository]).status, 0);
    writeFileSync(join(repository, "seed.txt"), "seed\n");
    assert.equal(spawnSync("git", ["-C", repository, "add", "seed.txt"]).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test",
      "-C", repository, "commit", "--quiet", "-m", "seed",
    ]).status, 0);
    assert.equal(spawnSync("git", ["-C", repository, "worktree", "add", "--quiet", "-b", "cursor-write", workspace]).status, 0);

    const featureFile = join(workspace, "feature.txt");
    const outsideMainWorktree = join(repository, "outside-main.txt");
    const gitMarker = join(workspace, ".git");
    const originalGitMarker = readFileSync(gitMarker, "utf8");
    const gitDirectory = spawnSync("git", ["-C", workspace, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim();
    const gitCommonDirectory = spawnSync("git", ["-C", workspace, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).stdout.trim();
    const commonDirectory = realpathSync(resolve(workspace, gitCommonDirectory));
    const hookPath = join(commonDirectory, "hooks", "pre-commit");
    const worktreeConfigPath = join(gitDirectory, "config.worktree");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cliArgs = process.argv.slice(2);
const providerWorkspace = cliArgs[cliArgs.indexOf("--workspace") + 1];
function run(args) {
  const child = spawnSync("git", args, { cwd: providerWorkspace, encoding: "utf8" });
  return { ok: child.status === 0, output: (child.stderr || child.stdout || "").trim() };
}
function attempt(callback) {
  try { callback(); return "allowed"; }
  catch (error) { return error && (error.code === "EPERM" || error.code === "EACCES") ? "blocked" : error && error.code || "error"; }
}
fs.writeFileSync(path.join(providerWorkspace, "feature.txt"), "linked-worktree-change\\n");
let outside = "allowed";
try { fs.writeFileSync(${JSON.stringify(outsideMainWorktree)}, "must-not-write\\n"); }
catch (error) { outside = error && (error.code === "EPERM" || error.code === "EACCES") ? "blocked" : error && error.code || "error"; }
const hook = attempt(() => fs.writeFileSync(${JSON.stringify(hookPath)}, "#!/bin/sh\\nexit 1\\n"));
const worktreeConfig = attempt(() => fs.writeFileSync(${JSON.stringify(worktreeConfigPath)}, "[core]\\n\\thooksPath = planted\\n"));
const marker = attempt(() => fs.writeFileSync(${JSON.stringify(gitMarker)}, "gitdir: /tmp/planted\\n"));
const hooksConfig = run(["config", "core.hooksPath", ".planted-hooks"]);
const add = run(["add", "feature.txt"]);
const commit = run(["-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test", "commit", "--quiet", "-m", "cursor linked worktree"]);
const outcome = { add, commit, outside, hook, worktreeConfig, marker, hooksConfig };
${cursorConversationStoreFixtureSource("sess-linked-worktree")}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-linked-worktree" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-linked-worktree" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input,
        apiBaseUrl: "https://desktop.letagents.example",
        workspaceRoot: input.cwd,
        sourceHomeDir,
        profileRoot: input.profileRoot ?? stableProfileRoot,
        ...(input.inspectionOnly ? {} : {
          mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
        }),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      cwd: workspace,
      workAttemptId: "wa-linked-worktree",
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
      inboxItemId: "inbox-linked-worktree",
    })));
    const outcome = JSON.parse(result.text!) as {
      add: { ok: boolean }; commit: { ok: boolean }; outside: string; hook: string;
      worktreeConfig: string; marker: string; hooksConfig: { ok: boolean };
    };
    assert.equal(outcome.add.ok, true);
    assert.equal(outcome.commit.ok, true);
    assert.equal(outcome.outside, "blocked");
    assert.equal(outcome.hook, "blocked");
    assert.equal(outcome.worktreeConfig, "blocked");
    assert.equal(outcome.marker, "blocked");
    assert.equal(outcome.hooksConfig.ok, false, "provider-visible Git config remains immutable after trusted setup");
    assert.equal(readFileSync(featureFile, "utf8"), "linked-worktree-change\n");
    assert.equal(existsSync(outsideMainWorktree), false);
    assert.equal(existsSync(hookPath), false);
    assert.equal(existsSync(worktreeConfigPath), false);
    assert.equal(readFileSync(gitMarker, "utf8"), originalGitMarker);
    assert.equal(spawnSync("git", ["-C", workspace, "log", "-1", "--format=%s"], { encoding: "utf8" }).stdout.trim(), "seed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised workspace generation rejects Git submodules before native launch", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-submodule-boundary-"));
  try {
    const childRepository = join(root, "child-origin");
    const repository = join(root, "superproject");
    const workspace = join(repository, "modules", "child");
    const sourceHomeDir = join(root, "source-home");
    const stableProfileRoot = join(root, "stable-profile");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(childRepository, { recursive: true });
    mkdirSync(repository, { recursive: true });
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    assert.equal(spawnSync("git", ["init", "--quiet", childRepository]).status, 0);
    writeFileSync(join(childRepository, "seed.txt"), "seed\n");
    assert.equal(spawnSync("git", ["-C", childRepository, "add", "seed.txt"]).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test",
      "-C", childRepository, "commit", "--quiet", "-m", "child seed",
    ]).status, 0);
    assert.equal(spawnSync("git", ["init", "--quiet", repository]).status, 0);
    writeFileSync(join(repository, "parent.txt"), "parent\n");
    assert.equal(spawnSync("git", ["-C", repository, "add", "parent.txt"]).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test",
      "-C", repository, "commit", "--quiet", "-m", "parent seed",
    ]).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "protocol.file.allow=always", "-C", repository,
      "submodule", "add", "--quiet", `file://${childRepository}`, "modules/child",
    ]).status, 0);
    assert.equal(spawnSync("git", [
      "-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test",
      "-C", repository, "commit", "--quiet", "-am", "add child",
    ]).status, 0);

    const featureFile = join(workspace, "feature.txt");
    const parentEscape = join(repository, "parent-escape.txt");
    const gitMarker = join(workspace, ".git");
    const originalGitMarker = readFileSync(gitMarker, "utf8");
    const gitDirectory = spawnSync("git", ["-C", workspace, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).stdout.trim();
    const hookPath = join(gitDirectory, "hooks", "pre-commit");
    const configPath = join(gitDirectory, "config");
    const originalConfig = readFileSync(configPath, "utf8");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
function run(args) {
  const child = spawnSync("git", args, { cwd: ${JSON.stringify(workspace)}, encoding: "utf8" });
  return { ok: child.status === 0, output: (child.stderr || child.stdout || "").trim() };
}
function attempt(callback) {
  try { callback(); return "allowed"; }
  catch (error) { return error && (error.code === "EPERM" || error.code === "EACCES") ? "blocked" : error && error.code || "error"; }
}
fs.writeFileSync(${JSON.stringify(featureFile)}, "submodule-change\\n");
const parent = attempt(() => fs.writeFileSync(${JSON.stringify(parentEscape)}, "must-not-write\\n"));
const hook = attempt(() => fs.writeFileSync(${JSON.stringify(hookPath)}, "#!/bin/sh\\nexit 1\\n"));
const marker = attempt(() => fs.writeFileSync(${JSON.stringify(gitMarker)}, "gitdir: /tmp/planted\\n"));
const hooksConfig = run(["config", "core.hooksPath", ".planted-hooks"]);
const add = run(["add", "feature.txt"]);
const commit = run(["-c", "user.name=Cursor Test", "-c", "user.email=cursor@example.test", "commit", "--quiet", "-m", "cursor submodule"]);
const outcome = { add, commit, parent, hook, marker, hooksConfig };
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-submodule-boundary" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-submodule-boundary" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input,
        apiBaseUrl: "https://desktop.letagents.example",
        workspaceRoot: input.cwd,
        sourceHomeDir,
        profileRoot: input.profileRoot ?? stableProfileRoot,
        ...(input.inspectionOnly ? {} : {
          mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
        }),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      cwd: workspace,
      workAttemptId: "wa-submodule-boundary",
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
        inboxItemId: "inbox-submodule-boundary",
      }))),
      /submodules|separate Git directories/i,
    );
    assert.equal(existsSync(featureFile), false);
    assert.equal(existsSync(parentEscape), false);
    assert.equal(existsSync(hookPath), false);
    assert.equal(readFileSync(gitMarker, "utf8"), originalGitMarker);
    assert.equal(readFileSync(configPath, "utf8"), originalConfig);
    assert.equal(spawnSync("git", ["-C", workspace, "log", "-1", "--format=%s"], { encoding: "utf8" }).stdout.trim(), "child seed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real supervised boundary blocks a late in-workspace authority symlink", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-late-authority-symlink-"));
  try {
    const workspace = join(root, "workspace");
    const insideTarget = join(workspace, "inside-target");
    const sourceHomeDir = join(root, "source-home");
    const stableProfileRoot = join(root, "stable-profile");
    const targetSettings = join(insideTarget, "settings.json");
    const targetMcp = join(insideTarget, "mcp.json");
    const executable = join(root, "fake-cursor-agent");
    initializeGitWorkspace(workspace);
    mkdirSync(insideTarget, { recursive: true });
    mkdirSync(join(sourceHomeDir, ".cursor"), { recursive: true });
    writeFileSync(targetSettings, "inside-secret\n");
writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const workspace = args[args.indexOf("--workspace") + 1];
function attempt(callback) {
  try { callback(); return "allowed"; }
  catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) return "blocked";
    return error && error.code || "error";
  }
}
const outcome = {
  read: attempt(() => fs.readFileSync(path.join(workspace, ".cursor", "settings.json"), "utf8")),
  write: attempt(() => fs.writeFileSync(path.join(workspace, ".cursor", "mcp.json"), "replaced\\n")),
};
${cursorConversationStoreFixtureSource("sess-late-authority-symlink")}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-late-authority-symlink" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: "sess-late-authority-symlink" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    let launchedChild: CursorCliChild | null = null;
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        attestSupervisedMcp: async () => {},
        launchTurn(input) {
          const launchWorkspace = argValue(input.args, "--workspace")!;
          const authorityLink = join(launchWorkspace, ".cursor");
          if (!existsSync(authorityLink)) {
            symlinkSync(join(launchWorkspace, "inside-target"), authorityLink, "dir");
          }
          launchedChild = defaultLaunchTurn(input);
          void launchedChild.exited.then(() => rmSync(authorityLink, { force: true }));
          return launchedChild;
        },
      },
      supervisedProfileFactory: (input) => prepareCursorSupervisedProfile({
        ...input,
        apiBaseUrl: "https://desktop.letagents.example",
        workspaceRoot: input.cwd,
        sourceHomeDir,
        profileRoot: input.profileRoot ?? stableProfileRoot,
        ...(input.inspectionOnly ? {} : {
          mcpRuntime: {
            entryPath: materializeAttestableMcpRuntime(join(dirname(sourceHomeDir), "attestable-mcp-runtime")),
            readRoots: [join(dirname(sourceHomeDir), "attestable-mcp-runtime")],
          },
        }),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({
      cwd: workspace,
      workAttemptId: "wa-late-authority-symlink",
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    let result: ProviderRoomTurnResult;
    try {
      result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({
        inboxItemId: "inbox-late-authority-symlink",
      })));
    } catch (error) {
      const nativeStderr = (launchedChild as CursorCliChild | null)?.stderrTail() ?? "<none>";
      throw new Error(`${error instanceof Error ? error.message : String(error)}; native stderr: ${nativeStderr}`);
    }
    assert.deepEqual(JSON.parse(result.text!), { read: "blocked", write: "blocked" });
    assert.equal(readFileSync(targetSettings, "utf8"), "inside-secret\n");
    assert.equal(existsSync(targetMcp), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised native sandbox blocks macOS effect-delegating helpers and private-profile executables", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-native-delegation-"));
  try {
    const profileRoot = join(root, "private-profile");
    const configDir = join(profileRoot, "config");
    const homeDir = join(profileRoot, "home");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
const copiedOpen = process.env.HOME + "/copied-open";
fs.copyFileSync("/usr/bin/open", copiedOpen);
fs.chmodSync(copiedOpen, 0o700);
function blocked(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "ignore" });
  return result.error?.code === "EPERM" || result.error?.code === "EACCES" || result.status !== 0;
}
const outcome = {
  directOpen: blocked("/usr/bin/open", ["--help"]),
  copiedOpen: blocked(copiedOpen, ["--help"]),
  appleScript: blocked("/usr/bin/osascript", ["-e", "return 1"]),
  keychainCli: blocked("/usr/bin/security", ["list-keychains"]),
  xcodeDispatcher: blocked("/usr/bin/xcrun", ["--find", "clang"]),
};
const session = "sess-native-delegation";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(outcome), session_id: session }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(profileRoot, "data"),
        cacheDir: join(profileRoot, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
        nativeDeniedExecSubpaths: [profileRoot, realpathSync(profileRoot)],
        nativeAllowedWriteSubpaths: [profileRoot, realpathSync(profileRoot)],
        nativeAllowedReadSubpaths: [root, realpathSync(root)],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.deepEqual(JSON.parse(result.text!), {
      directOpen: true,
      copiedOpen: true,
      appleScript: true,
      keychainCli: true,
      xcodeDispatcher: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised native sandbox cannot signal its wrapper or unrelated same-UID processes", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-native-signal-fence-"));
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  const victimClosed = new Promise<void>((resolve) => victim.once("close", () => resolve()));
  try {
    const profileRoot = join(root, "private-profile");
    const configDir = join(profileRoot, "config");
    const homeDir = join(profileRoot, "home");
    const executable = join(root, "fake-cursor-agent");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
const ownChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
let externalBlocked = false;
let parentBlocked = false;
let childAllowed = false;
try { process.kill(${victim.pid}, "SIGTERM"); }
catch (error) { externalBlocked = error?.code === "EPERM" || error?.code === "EACCES"; }
try { process.kill(process.ppid, "SIGTERM"); }
catch (error) { parentBlocked = error?.code === "EPERM" || error?.code === "EACCES"; }
try { process.kill(ownChild.pid, "SIGTERM"); childAllowed = true; }
catch {}
const session = "sess-native-signal-fence";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false,
  result: JSON.stringify({ externalBlocked, parentBlocked, childAllowed }), session_id: session,
}) + "\\n");
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(profileRoot, "data"),
        cacheDir: join(profileRoot, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
        nativeAllowedWriteSubpaths: [profileRoot, realpathSync(profileRoot)],
        nativeAllowedReadSubpaths: [root, realpathSync(root)],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.deepEqual(JSON.parse(result.text!), {
      externalBlocked: true,
      parentBlocked: true,
      childAllowed: true,
    });
    assert.doesNotThrow(() => process.kill(victim.pid!, 0), "the unrelated process remains alive");
  } finally {
    try { victim.kill("SIGKILL"); } catch {}
    await victimClosed;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the supervised native sandbox fences private config, runtime, Statsig temps, and redirected authority roots", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-native-authority-fences-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    const cursorHome = join(homeDir, ".cursor");
    const runtimeConfig = join(configDir, "cursor");
    const runtimeRoot = join(root, "runtime");
    const workspace = join(root, "workspace");
    const externalCursor = join(root, "external-cursor");
    const privateMcp = join(cursorHome, "mcp.json");
    const privatePermissions = join(runtimeConfig, "cli-config.json");
    const identityBinding = join(configDir, "letagents-cursor-identity.json");
    const runtimeFile = join(runtimeRoot, "server.js");
    const statsigTemp = join(runtimeConfig, "statsig-cache.json.4321.01234567-89ab-cdef-0123-456789abcdef.tmp");
    const redirectedSettings = join(workspace, ".cursor", "settings.json");
    const executable = join(root, "fake-cursor-agent");
    for (const directory of [cursorHome, runtimeConfig, runtimeRoot, workspace, externalCursor, join(root, "data"), join(root, "cache")]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(privateMcp, "mcp-original\n");
    writeFileSync(privatePermissions, "permissions-original\n");
    writeFileSync(identityBinding, '{"userId":12345}\n');
    writeFileSync(runtimeFile, "runtime-original\n");
    writeFileSync(join(externalCursor, "settings.json"), "redirected-secret\n");
    symlinkSync(externalCursor, join(workspace, ".cursor"), "dir");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
const cliTemp = ${JSON.stringify(`${privatePermissions}.native-tmp`)};
let cliConfigRewritten = false;
try {
  fs.writeFileSync(cliTemp, "permissions-native-rewrite\\n");
  fs.renameSync(cliTemp, ${JSON.stringify(privatePermissions)});
  cliConfigRewritten = true;
} catch {}
const attempts = [
  () => fs.writeFileSync(${JSON.stringify(privateMcp)}, "replaced"),
  () => fs.unlinkSync(${JSON.stringify(identityBinding)}),
  () => fs.writeFileSync(${JSON.stringify(runtimeFile)}, "replaced"),
  () => fs.writeFileSync(${JSON.stringify(statsigTemp)}, "remote gates"),
  () => fs.readFileSync(${JSON.stringify(redirectedSettings)}, "utf8"),
  () => fs.symlinkSync(${JSON.stringify(externalCursor)}, ${JSON.stringify(join(workspace, ".claude"))}, "dir"),
  () => fs.readdirSync("/usr/local"),
  () => fs.readdirSync("/Library/Application Support"),
];
let blocked = 0;
const outcomes = [];
for (const attempt of attempts) {
  try { attempt(); outcomes.push("allowed"); }
  catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) { blocked += 1; outcomes.push("blocked"); }
    else outcomes.push(error && error.code || "error");
  }
}
const result = blocked === attempts.length && cliConfigRewritten
  ? "authority-fences-blocked"
  : "authority-fence-bypass:" + blocked + ":cli=" + cliConfigRewritten + ":" + outcomes.join(",");
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-authority-fences" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "sess-authority-fences" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    const canonicalRoot = realpathSync(root);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir,
        configDir,
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        env: { HOME: homeDir },
        ...wrapperHostedMcpFixture(root),
        nativeDeniedReadMetadataPaths: [
          join(canonicalRoot, "workspace", ".cursor"),
          join(canonicalRoot, "workspace", ".claude"),
        ],
        nativeDeniedReadWriteRegexes: [
          `^${join(root, "config", "cursor", "statsig-cache[.]json[.][0-9]+[.][0-9A-Fa-f-]+[.]tmp")}$`,
          `^${join(canonicalRoot, "config", "cursor", "statsig-cache[.]json[.][0-9]+[.][0-9A-Fa-f-]+[.]tmp")}$`,
        ],
        nativeDeniedWritePaths: [privateMcp, realpathSync(privateMcp), identityBinding, realpathSync(identityBinding)],
        nativeDeniedWriteStructuralPaths: [root, homeDir, cursorHome, configDir, runtimeConfig],
        nativeDeniedWriteSubpaths: [runtimeRoot],
        nativeAllowedWriteSubpaths: [
          homeDir, realpathSync(homeDir), configDir, realpathSync(configDir),
          join(root, "data"), join(canonicalRoot, "data"), join(root, "cache"), join(canonicalRoot, "cache"),
        ],
        nativeAllowedReadSubpaths: [
          homeDir, realpathSync(homeDir), configDir, realpathSync(configDir),
          join(root, "data"), join(canonicalRoot, "data"), join(root, "cache"), join(canonicalRoot, "cache"),
          workspace, realpathSync(workspace),
        ],
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: workspace }));
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest()));
    assert.equal(result.text, "authority-fences-blocked");
    assert.equal(readFileSync(privateMcp, "utf8"), "mcp-original\n");
    assert.equal(readFileSync(privatePermissions, "utf8"), "permissions-native-rewrite\n");
    assert.equal(readFileSync(identityBinding, "utf8"), '{"userId":12345}\n');
    assert.equal(readFileSync(runtimeFile, "utf8"), "runtime-original\n");
    assert.equal(existsSync(statsigTemp), false);
    assert.equal(existsSync(join(workspace, ".claude")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production Cursor turn wrapper never leaks Electron's wrapper-only Node mode into native Cursor", { skip: supervisedAgentsOnly }, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-wrapper-electron-env-"));
  const previousElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  try {
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
if (process.argv.includes("--endpoint") || process.argv.includes("--agent-endpoint")) process.exit(8);
if (process.env.ELECTRON_RUN_AS_NODE !== undefined) process.exit(7);
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-electron-env" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "native env clean", session_id: "sess-electron-env" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    process.env.ELECTRON_RUN_AS_NODE = "1";

    const adapter = new CursorProviderAdapter({ cursorBin: executable });
    const handle = await adapter.spawn(spawnRequest({ cwd: root }));
    for (let index = 0; index < 100 && handle.observedState() !== "idle"; index += 1) await flush();
    assert.equal(handle.observedState(), "idle");
    assert.equal(handle.providerContinuationId, "sess-electron-env");
  } finally {
    if (previousElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previousElectronRunAsNode;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production Cursor wrapper fences multi-chunk oversized output without buffering it as a live line", { skip: supervisedAgentsOnly }, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-wrapper-oversized-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
for (let index = 0; index < 12; index += 1) process.stdout.write("x".repeat(64 * 1024));
process.stdout.write("\\n");
setInterval(() => {}, 1_000);
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      turnStartTimeoutMs: 5_000,
      supervisedProfileFactory: () => ({
        homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
        checkpointTurnStarted: async () => {},
        checkpointProviderState: async () => {},
      })),
      /session contract|exited before reporting its stream-json init/,
    );
    assert.equal(handle.observedState(), "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the production Cursor wrapper fences aggregate byte and event floods", { skip: supervisedAgentsOnly }, async () => {
  const floods = [
    {
      name: "aggregate-bytes",
      error: /bounded aggregate stream-json byte budget/,
      source: `const line = "x".repeat(64 * 1024) + "\\n";
for (let index = 0; index < 130; index += 1) process.stdout.write(line);
setInterval(() => {}, 1_000);`,
    },
    {
      name: "event-count",
      error: /bounded stream-json event budget/,
      source: `for (let index = 0; index < 4_100; index += 1) process.stdout.write("x\\n");
setInterval(() => {}, 1_000);`,
    },
    {
      name: "stderr-bytes",
      error: /native process exceeded the supervised stderr byte budget/,
      source: `process.on("SIGTERM", () => process.exit(0));
process.stderr.write("e".repeat(300 * 1024));
setInterval(() => {}, 1_000);`,
    },
  ];
  for (const flood of floods) {
    const root = mkdtempSync(join(tmpdir(), `letagents-cursor-wrapper-${flood.name}-`));
    try {
      const configDir = join(root, "config");
      const homeDir = join(root, "home");
      mkdirSync(configDir, { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(join(root, "npm-cache"), { recursive: true });
      const executable = join(root, "fake-cursor-agent");
      writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
${flood.source}
`);
      chmodSync(executable, 0o700);
      const adapter = new CursorProviderAdapter({
        cursorBin: executable,
        dependencies: productionPersonalIdentityDependencies,
        turnStartTimeoutMs: 5_000,
        supervisedProfileFactory: () => ({
          homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
          env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
          ...wrapperHostedMcpFixture(root),
        }),
      });
      const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
      await assert.rejects(
        withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
          checkpointTurnStarted: async () => {},
          checkpointProviderState: async () => {},
        })),
        flood.error,
        flood.name,
      );
      assert.equal(handle.observedState(), "failed", flood.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a transient first-session checkpoint failure recovers the exact terminal without splitting live and durable identity", { skip: supervisedAgentsOnly }, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-checkpoint-recovery-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-checkpoint-real" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "checkpoint recovered", session_id: "sess-checkpoint-real" }) + "\\n");
`);
    chmodSync(executable, 0o700);
    let child: CursorCliChild | undefined;
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: {
        ...productionPersonalIdentityDependencies,
        launchTurn(input) {
          child = defaultLaunchTurn(input);
          return child;
        },
      },
      supervisedProfileFactory: () => ({
        homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    let persistedTurnId = "";
    let realSessionCheckpoints = 0;
    let lifecycleSettlements = 0;
    const checkpointProviderState: NonNullable<ProviderRoomTurnOptions["checkpointProviderState"]> = async (state) => {
      if (state.providerContinuationId === "sess-checkpoint-real") {
        realSessionCheckpoints += 1;
        if (realSessionCheckpoints === 1) {
          // Wait for the wrapper to drain stdout and persist its terminal journal
          // so this exercises a completed first turn even under slow teardown.
          assert.ok(child);
          await child.exited;
          throw new Error("transient manifest checkpoint failure");
        }
        if (realSessionCheckpoints === 3) {
          assert.equal(state.providerConnection.processIdentity, null);
          throw new Error("transient processless checkpoint failure");
        }
      }
    };
    const settleLifecycleBeforeIdle = async () => {
      lifecycleSettlements += 1;
      assert.equal(realSessionCheckpoints, lifecycleSettlements === 1 ? 2 : 4,
        "the real live continuation is durable before typed settlement");
      assert.ok(handle.providerConnection?.processIdentity);
    };
    await assert.rejects(withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointTurnStarted: async (turnId) => { persistedTurnId = turnId; },
      checkpointProviderState,
      settleLifecycleBeforeIdle,
    })), /transient processless checkpoint failure/);
    assert.ok(handle.providerConnection?.processIdentity,
      "a failed live-to-idle checkpoint keeps the exited child birth recoverable");
    assert.notEqual(handle.observedState(), "failed");

    const result = await adapter.recoverRoomTurn(handle, {
      inboxItemId: "inbox-1",
      providerTurnId: persistedTurnId,
    }, { checkpointProviderState, settleLifecycleBeforeIdle });
    assert.equal(result.text, "checkpoint recovered");
    assert.equal(realSessionCheckpoints, 5,
      "the retry checkpoints the retained child and then its processless lane");
    assert.equal(lifecycleSettlements, 2);
    assert.equal(handle.providerContinuationId, "sess-checkpoint-real");
    assert.equal(handle.observedState(), "idle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-init checkpoint recovery prefers a successful result durably captured during TERM teardown", { skip: supervisedAgentsOnly }, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-checkpoint-term-recovery-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-term-real" }) + "\\n");
process.once("SIGTERM", () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "late durable reply", session_id: "sess-term-real" }) + "\\n");
  setTimeout(() => process.exit(0), 5);
});
setInterval(() => {}, 1_000);
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    let realSessionCheckpoints = 0;
    let lifecycleSettlements = 0;
    const result = await withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest(), {
      checkpointTurnStarted: async () => {},
      checkpointProviderState: async (state) => {
        if (state.providerContinuationId === "sess-term-real") {
          realSessionCheckpoints += 1;
          if (realSessionCheckpoints === 1) throw new Error("transient manifest checkpoint failure");
        }
      },
      settleLifecycleBeforeIdle: async () => {
        lifecycleSettlements += 1;
        assert.equal(realSessionCheckpoints, 2);
        assert.ok(handle.providerConnection?.processIdentity);
      },
    }));
    assert.equal(result.text, "late durable reply");
    assert.equal(realSessionCheckpoints, 3);
    assert.equal(lifecycleSettlements, 1);
    assert.equal(handle.providerContinuationId, "sess-term-real");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-init checkpoint recovery terminalizes a trusted durable no-result exit", { skip: supervisedAgentsOnly }, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-checkpoint-terminal-"));
  try {
    const configDir = join(root, "config");
    const homeDir = join(root, "home");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(join(root, "npm-cache"), { recursive: true });
    const executable = join(root, "fake-cursor-agent");
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--disable-project-configs" && args[1] === "mcp" && args[2] === "list") {
  process.stdout.write("letagents: ready\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-checkpoint-terminal" }) + "\\n");
process.once("SIGTERM", () => process.exit(9));
setInterval(() => {}, 1_000);
`);
    chmodSync(executable, 0o700);
    const adapter = new CursorProviderAdapter({
      cursorBin: executable,
      dependencies: productionPersonalIdentityDependencies,
      supervisedProfileFactory: () => ({
        homeDir, configDir, dataDir: join(root, "data"), cacheDir: join(root, "cache"),
        env: { HOME: homeDir, NPM_CONFIG_CACHE: join(root, "npm-cache") },
        ...wrapperHostedMcpFixture(root),
      }),
    });
    const handle = await adapter.spawn(daemonSpawnRequest({ cwd: root }));
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));
    let persistedTurnId = "";
    let realSessionCheckpoints = 0;
    let lifecycleSettlements = 0;
    const checkpointProviderState = async (state: { providerContinuationId: string }) => {
      if (state.providerContinuationId !== "sess-checkpoint-terminal") return;
      realSessionCheckpoints += 1;
      if (realSessionCheckpoints === 1) throw new Error("transient manifest checkpoint failure");
      assert.equal(
        terminals.length,
        0,
        "recovered continuation checkpoints before onExit retires the daemon's live handle",
      );
    };
    const settleLifecycleBeforeIdle = async () => {
      lifecycleSettlements += 1;
      assert.ok(handle.providerConnection?.processIdentity);
      if (lifecycleSettlements === 1) throw new Error("transient lifecycle settlement failure");
    };
    await assert.rejects(
      withLoopAlive(adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "checkpoint-terminal" }), {
        checkpointTurnStarted: async (turnId) => { persistedTurnId = turnId; },
        checkpointProviderState,
        settleLifecycleBeforeIdle,
      })),
      /transient lifecycle settlement failure/,
    );
    assert.match(persistedTurnId, /^cursor:/);
    assert.equal(realSessionCheckpoints, 2);
    assert.equal(lifecycleSettlements, 1);
    assert.notEqual(handle.observedState(), "failed", "failed recovery does not terminalize the attempt");
    assert.ok(handle.providerConnection?.processIdentity, "failed recovery retains the exact exited child birth");
    assert.equal(terminals.length, 0);

    const recovered = await withLoopAlive(adapter.recoverRoomTurn(handle, {
      inboxItemId: "checkpoint-terminal",
      providerTurnId: persistedTurnId,
    }, { checkpointProviderState, settleLifecycleBeforeIdle }));
    assert.equal(recovered.outcome, "interrupted");
    assert.equal(realSessionCheckpoints, 4, "retry checkpoints the live birth, then its processless continuation");
    assert.equal(lifecycleSettlements, 2);
    assert.equal(handle.observedState(), "failed");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.terminalCause, "crashed");
    assert.equal(terminals[0]!.exitCode, 9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-init checkpoint failure cannot recover a buffered result without trusted remote-authority evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-checkpoint-no-terminal-"));
  const harness = createHarness({ ownsDescendantReaping: true });
  try {
    const dependencies: CursorProviderAdapterDependencies = {
      ...harness.dependencies,
      prepareTurnState(path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      },
      launchTurn(input) {
        const child = harness.dependencies.launchTurn(input);
        Object.defineProperty(child, "requiresDurableTerminalEvidence", { value: true });
        return child;
      },
    };
    const adapter = new CursorProviderAdapter({
      dependencies,
      supervisedProfileFactory: (input) => {
        const profileRoot = input.profileRoot ?? root;
        const homeDir = join(profileRoot, "home");
        const configDir = join(profileRoot, "config");
        mkdirSync(homeDir, { recursive: true });
        mkdirSync(configDir, { recursive: true });
        return {
          homeDir,
          configDir,
          dataDir: join(profileRoot, "data"),
          cacheDir: join(profileRoot, "cache"),
          env: { HOME: homeDir, NPM_CONFIG_CACHE: join(profileRoot, "npm-cache") },
          ...(input.inspectionOnly ? {} : wrapperHostedMcpFixture(profileRoot)),
        };
      },
    });
    const handle = await spawnDaemonLane(adapter, harness, daemonSpawnRequest({
      cwd: root,
      permissionProfileId: "sandboxed_write",
      launchPolicy: { force: true, sandbox: "enabled" },
    }));
    const terminals: ProviderTerminalPayload[] = [];
    adapter.onExit(handle, (terminal) => terminals.push(terminal));
    let realSessionCheckpoints = 0;
    let terminalCheckpoints = 0;
    const pending = adapter.runRoomTurn(handle, roomTurnRequest({ inboxItemId: "checkpoint-no-terminal" }), {
      checkpointTurnStarted: async () => {},
      checkpointProviderState: async (state) => {
        if (state.providerContinuationId !== "sess-cursor-1") return;
        realSessionCheckpoints += 1;
        if (realSessionCheckpoints !== 1) return;
        // Buffer a superficially successful result before the transient
        // manifest failure forces teardown. The injected supervised child
        // exits on TERM but deliberately writes no containment terminal,
        // modeling a wrapper lost to forced process-group SIGKILL.
        harness.children[0]!.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "must-not-publish-from-memory",
          session_id: "sess-cursor-1",
        });
        throw new Error("transient manifest checkpoint failure");
      },
      checkpointTerminalResult: async () => { terminalCheckpoints += 1; },
    });

    await assert.rejects(
      withLoopAlive(pending),
      /trusted terminal recovery was unavailable.*no trusted terminal evidence/i,
    );
    assert.equal(realSessionCheckpoints, 1, "untrusted recovery never retries the provider checkpoint");
    assert.equal(terminalCheckpoints, 0, "the buffered result never reaches durable publication");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]!.terminalCause, "protocol_error");
    assert.equal(handle.observedState(), "failed");
    assert.deepEqual(harness.signals, [{ pid: 5200, signal: "SIGTERM" }]);
    assert.equal(existsSync(`${harness.launches[0]!.statePath}.terminal.json`), false);
    assert.deepEqual(
      harness.workspaceGenerationEvents.map((event) => event.kind),
      ["create"],
      "missing containment evidence leaves the writable generation receipt untouched",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
