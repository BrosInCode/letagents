import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";

import { assertCursorSupervisedMcpAuthority } from "../main/agents/cursor-mcp-authority.js";

const previousNonDarwinOverride = process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
if (process.platform !== "darwin") process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = "1";
test.after(() => {
  if (previousNonDarwinOverride === undefined) delete process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON;
  else process.env.LETAGENTS_ALLOW_NON_DARWIN_DAEMON = previousNonDarwinOverride;
});

test("Cursor MCP inspection strips supervised turn authority from its native environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-inspection-env-"));
  const executable = join(root, "fake-cursor-agent");
  const expectedServerName = "letagents_supervised_deadbeef";
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const forbidden = [
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "LETAGENTS_TOKEN",
  "LETAGENTS_AGENT_SESSION_BEARER",
  "LETAGENTS_SUPERVISOR_ENTRY_ID",
  "LETAGENTS_SUPERVISOR_DAEMON_SOCKET",
  "LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID",
  "LETAGENTS_SUPERVISED_BOUNDED_TURNS",
  "LETAGENTS_EXECUTION_PROFILE",
  "LETAGENTS_PERMISSION_PROFILE_ID",
];
if (forbidden.some((key) => process.env[key] !== undefined)) process.exit(3);
if (process.env.LETAGENTS_API_URL !== "https://letagents.invalid") process.exit(4);
process.stdout.write(${JSON.stringify(`${expectedServerName}: ready\n`)});
`);
    chmodSync(executable, 0o700);

    await assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      expectedServerName,
      env: {
        ...process.env,
        CURSOR_API_KEY: "cursor-api-key-must-not-leak",
        CURSOR_AUTH_TOKEN: "cursor-auth-token-must-not-leak",
        LETAGENTS_API_URL: "https://letagents.invalid",
        LETAGENTS_TOKEN: "owner-token-must-not-leak",
        LETAGENTS_AGENT_SESSION_BEARER: "worker-bearer-must-not-leak",
        LETAGENTS_SUPERVISOR_ENTRY_ID: "entry-must-not-leak",
        LETAGENTS_SUPERVISOR_DAEMON_SOCKET: "/tmp/socket-must-not-leak",
        LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "turn-must-not-leak",
        LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
        LETAGENTS_EXECUTION_PROFILE: "supervised_room_turn",
        LETAGENTS_PERMISSION_PROFILE_ID: "read_only",
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS Cursor MCP inspection cannot mutate the real profile outside its disposable root", {
  skip: process.platform !== "darwin",
}, async () => {
  const inspectionRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-write-sandbox-"));
  const realProfileRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-real-profile-"));
  const executable = join(inspectionRoot, "fake-cursor-agent");
  const forbiddenWrite = join(realProfileRoot, "mcp.json");
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
try {
  writeFileSync(${JSON.stringify(forbiddenWrite)}, "mutated");
  process.exit(6);
} catch {}
process.stdout.write("letagents: ready\\n");
`);
    chmodSync(executable, 0o700);

    await assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: inspectionRoot,
      writableProfileRoot: inspectionRoot,
      env: { ...process.env },
    });
    assert.equal(existsSync(forbiddenWrite), false);
  } finally {
    rmSync(inspectionRoot, { recursive: true, force: true });
    rmSync(realProfileRoot, { recursive: true, force: true });
  }
});

test("macOS Cursor MCP inspection cannot signal an unrelated same-UID process", {
  skip: process.platform !== "darwin",
}, async () => {
  const inspectionRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-signal-sandbox-"));
  const executable = join(inspectionRoot, "fake-cursor-agent");
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
  const victimClosed = new Promise<void>((resolve) => victim.once("close", () => resolve()));
  try {
    writeFileSync(executable, `#!/usr/bin/env node
try {
  process.kill(${victim.pid}, "SIGTERM");
  process.exit(7);
} catch (error) {
  if (!error || (error.code !== "EPERM" && error.code !== "EACCES")) process.exit(8);
}
process.stdout.write("letagents: ready\\n");
`);
    chmodSync(executable, 0o700);

    await assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: inspectionRoot,
      writableProfileRoot: inspectionRoot,
      env: { ...process.env },
    });
    assert.doesNotThrow(() => process.kill(victim.pid!, 0), "the unrelated process remains alive");
  } finally {
    try { victim.kill("SIGKILL"); } catch {}
    await victimClosed;
    rmSync(inspectionRoot, { recursive: true, force: true });
  }
});

test("macOS Cursor MCP inspection cannot reach the network", {
  skip: process.platform !== "darwin",
}, async () => {
  const inspectionRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-network-sandbox-"));
  const executable = join(inspectionRoot, "fake-cursor-agent");
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(executable, `#!/usr/bin/env node
const { connect } = require("node:net");
const socket = connect({ host: "127.0.0.1", port: ${address.port} });
socket.once("connect", () => process.exit(7));
const timer = setTimeout(() => process.exit(8), 1_000);
socket.once("error", () => {
  clearTimeout(timer);
  process.stdout.write("letagents: ready\\n", () => process.exit(0));
});
`);
    chmodSync(executable, 0o700);

    await assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: inspectionRoot,
      writableProfileRoot: inspectionRoot,
      env: { ...process.env },
    });
    assert.equal(connections, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(inspectionRoot, { recursive: true, force: true });
  }
});

test("macOS packaged-bridge validation reads only its runtime and cannot use network or outside paths", {
  skip: process.platform !== "darwin",
}, async () => {
  const inspectionRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-real-bridge-"));
  const runtimeRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-runtime-"));
  const forbiddenRoot = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-forbidden-"));
  const executable = join(inspectionRoot, "fake-cursor-agent");
  const runtimeFile = join(runtimeRoot, "server.js");
  const allowedWrite = join(inspectionRoot, "cache-write");
  const forbiddenWrite = join(forbiddenRoot, "forbidden-write");
  const forbiddenRead = join(forbiddenRoot, "credential");
  const forbiddenExecutable = join(forbiddenRoot, "outside-helper");
  const forbiddenExecutionMarker = join(forbiddenRoot, "outside-helper-ran");
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    writeFileSync(runtimeFile, "packaged-runtime");
    writeFileSync(forbiddenRead, "credential-must-not-be-readable");
    writeFileSync(forbiddenExecutable, `#!/bin/sh\nprintf ran > ${JSON.stringify(forbiddenExecutionMarker)}\n`);
    chmodSync(forbiddenExecutable, 0o700);
    writeFileSync(executable, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { connect } = require("node:net");
writeFileSync(${JSON.stringify(allowedWrite)}, "cached");
if (readFileSync(${JSON.stringify(runtimeFile)}, "utf8") !== "packaged-runtime") process.exit(5);
try {
  writeFileSync(${JSON.stringify(forbiddenWrite)}, "escaped");
  process.exit(6);
} catch {}
try {
  readFileSync(${JSON.stringify(forbiddenRead)}, "utf8");
  process.exit(8);
} catch {}
const execution = spawnSync(${JSON.stringify(forbiddenExecutable)}, [], { stdio: "ignore" });
if (!execution.error && execution.status === 0) process.exit(9);
const socket = connect({ host: "127.0.0.1", port: ${address.port} });
socket.once("connect", () => process.exit(7));
const timer = setTimeout(() => process.exit(10), 1_000);
socket.once("error", () => {
  clearTimeout(timer);
  process.stdout.write("letagents: ready\\n", () => process.exit(0));
});
`);
    chmodSync(executable, 0o700);

    await assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: inspectionRoot,
      writableProfileRoot: inspectionRoot,
      requiredReadableRoots: [runtimeRoot],
      env: { ...process.env },
    });
    assert.equal(connections, 0);
    assert.equal(readFileSync(allowedWrite, "utf8"), "cached");
    assert.equal(existsSync(forbiddenWrite), false);
    assert.equal(existsSync(forbiddenExecutionMarker), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(inspectionRoot, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(forbiddenRoot, { recursive: true, force: true });
  }
});

test("Cursor MCP attestation rejects unbounded or redirected writable roots before launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-root-bounds-"));
  const redirected = join(dirname(root), `${root.split("/").at(-1)}-redirected`);
  try {
    await assert.rejects(assertCursorSupervisedMcpAuthority({
      cursorBin: process.execPath,
      cwd: root,
      writableProfileRoot: "/",
      env: { ...process.env },
    }), /unbounded writable root/);
    symlinkSync(root, redirected);
    await assert.rejects(assertCursorSupervisedMcpAuthority({
      cursorBin: process.execPath,
      cwd: root,
      writableProfileRoot: redirected,
      env: { ...process.env },
    }), /redirected writable profile root/);
  } finally {
    rmSync(redirected, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor MCP wrapper drains trailing registry entries before making the exact-authority decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-drain-"));
  const executable = join(root, "fake-cursor-agent");
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "--disable-project-configs" || args[1] !== "mcp" || args[2] !== "list") process.exit(2);
process.stdout.write("letagents: ready\\nunapproved: ready\\n");
`);
    chmodSync(executable, 0o700);

    await assert.rejects(assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      env: { ...process.env },
    }), /exactly one effective MCP entry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor MCP wrapper retries a transient birth observation only after its exact prepared handshake", async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-prepare-identity-"));
  const executable = join(root, "fake-cursor-agent");
  let identityReads = 0;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "--disable-project-configs" || args[1] !== "mcp" || args[2] !== "list") process.exit(2);
process.stdout.write("letagents: ready\\n");
`);
    chmodSync(executable, 0o700);

    await assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      env: { ...process.env },
      dependencies: {
        getProcessIdentity() {
          identityReads += 1;
          return identityReads === 1 ? undefined : "prepared-wrapper-birth";
        },
      },
    });
    assert.equal(identityReads, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor MCP timeout returns boundedly when an exact prepared wrapper cannot process termination IPC", {
  skip: process.platform === "win32",
  timeout: 7_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-stopped-wrapper-"));
  const executable = join(root, "fake-cursor-agent");
  let wrapperPid: number | null = null;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write("letagents: ready\\n");
`);
    chmodSync(executable, 0o700);

    const startedAt = Date.now();
    await assert.rejects(assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      env: { ...process.env },
      timeoutMs: 50,
      dependencies: {
        getProcessIdentity(pid) {
          wrapperPid = pid;
          process.kill(pid, "SIGSTOP");
          return "stopped-prepared-wrapper-birth";
        },
      },
    }), /failed while inspecting/);
    assert.ok(Date.now() - startedAt < 5_000, "a frozen exact wrapper cannot retain the caller");
    assert.equal(wrapperPid !== null && processAlive(wrapperPid), true);
  } finally {
    if (wrapperPid && processAlive(wrapperPid)) {
      try {
        process.kill(wrapperPid, "SIGKILL");
      } catch {
        // Best-effort cleanup of the deliberately stopped test wrapper.
      }
      await eventually(() => !processAlive(wrapperPid!), "stopped MCP wrapper exit");
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor MCP wrapper bounds an output flood internally and rejects after cooperative group retirement", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-output-flood-"));
  const executable = join(root, "fake-cursor-agent");
  const descendantPidPath = join(root, "descendant.pid");
  const descendantReadyPath = join(root, "descendant.ready");
  const descendantSource = [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(descendantReadyPath)}, "ready");`,
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  let descendantPid: number | null = null;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "--disable-project-configs" || args[1] !== "mcp" || args[2] !== "list") process.exit(2);
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
function floodAfterDescendantReady() {
  if (!existsSync(${JSON.stringify(descendantReadyPath)})) {
    setTimeout(floodAfterDescendantReady, 10);
    return;
  }
  process.stdout.write(Buffer.alloc(4 * 1024 * 1024, 0x78));
  setInterval(() => {}, 1_000);
}
floodAfterDescendantReady();
`);
    chmodSync(executable, 0o700);

    const attestation = assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      env: { ...process.env },
      timeoutMs: 4_000,
    });
    const rejected = assert.rejects(attestation, /failed while inspecting/);
    await eventually(() => existsSync(descendantPidPath), "flood descendant pid");
    descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    await eventually(() => existsSync(descendantReadyPath), "flood descendant readiness");
    await rejected;
    await eventually(() => !processAlive(descendantPid!), "flood descendant exit");
  } finally {
    if (descendantPid && processAlive(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Best-effort test cleanup after an assertion failure.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful Cursor MCP attestation starts cleanup at native exit and drains inherited descendant pipes", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-success-reap-"));
  const executable = join(root, "fake-cursor-agent");
  const descendantPidPath = join(root, "descendant.pid");
  const descendantReadyPath = join(root, "descendant.ready");
  const descendantSource = [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(descendantReadyPath)}, "ready");`,
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  let descendantPid: number | null = null;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "--disable-project-configs" || args[1] !== "mcp" || args[2] !== "list") process.exit(2);
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: ["ignore", "inherit", "inherit"] });
descendant.unref();
writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
function finishAfterDescendantReady() {
  if (!existsSync(${JSON.stringify(descendantReadyPath)})) {
    setTimeout(finishAfterDescendantReady, 10);
    return;
  }
  process.stdout.write("letagents: ready\\n");
}
finishAfterDescendantReady();
`);
    chmodSync(executable, 0o700);

    const attestation = assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      env: { ...process.env },
    });
    await eventually(() => existsSync(descendantPidPath), "successful MCP descendant pid");
    descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    await eventually(() => existsSync(descendantReadyPath), "successful MCP descendant readiness");

    await attestation;
    await eventually(() => !processAlive(descendantPid!), "successful MCP descendant exit");
  } finally {
    if (descendantPid && processAlive(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Best-effort test cleanup after an assertion failure.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("forced MCP group reaping preserves success only after isolated evidence pipes already closed", {
  skip: process.platform === "win32",
}, async () => {
  await exerciseSuccessfulMcpWithStubbornDescendant({ inheritOutput: false, expectSuccess: true });
});

test("forced MCP group reaping rejects when a stubborn descendant prevents evidence-pipe close", {
  skip: process.platform === "win32",
}, async () => {
  await exerciseSuccessfulMcpWithStubbornDescendant({ inheritOutput: true, expectSuccess: false });
});

test("Cursor MCP attestation fails boundedly when an escaped descendant retains native evidence pipes", {
  skip: process.platform === "win32",
  timeout: 8_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-escaped-pipes-"));
  const executable = join(root, "fake-cursor-agent");
  const descendantPidPath = join(root, "descendant.pid");
  const descendantReadyPath = join(root, "descendant.ready");
  const descendantSource = [
    'const { writeFileSync } = require("node:fs");',
    `writeFileSync(${JSON.stringify(descendantReadyPath)}, "ready");`,
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  let descendantPid: number | null = null;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "--disable-project-configs" || args[1] !== "mcp" || args[2] !== "list") process.exit(2);
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
descendant.unref();
writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
function finishAfterDescendantReady() {
  if (!existsSync(${JSON.stringify(descendantReadyPath)})) {
    setTimeout(finishAfterDescendantReady, 10);
    return;
  }
  process.stdout.write("letagents: ready\\n");
}
finishAfterDescendantReady();
`);
    chmodSync(executable, 0o700);

    const startedAt = Date.now();
    const attestation = assert.rejects(assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      env: { ...process.env },
      timeoutMs: 0,
    }), /failed while inspecting/);
    await eventually(() => existsSync(descendantPidPath), "escaped MCP descendant pid");
    descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    await eventually(() => existsSync(descendantReadyPath), "escaped MCP descendant readiness");

    await attestation;
    assert.ok(Date.now() - startedAt < 6_000, "escaped evidence pipes cannot hang attestation");
    assert.equal(processAlive(descendantPid), true, "fixture proves the descendant escaped the wrapper group");
  } finally {
    if (descendantPid && processAlive(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Best-effort cleanup of the deliberately escaped test process.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor MCP attestation never signals a process group after its wrapper PGID is recycled", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-recycled-group-"));
  const executable = join(root, "fake-cursor-agent");
  let identityReads = 0;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== "--disable-project-configs" || args[1] !== "mcp" || args[2] !== "list") process.exit(2);
process.stdout.write("letagents: ready\\n");
`);
    chmodSync(executable, 0o700);

    await assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      env: { ...process.env },
      dependencies: {
        getProcessIdentity() {
          identityReads += 1;
          return identityReads === 1 ? "original-wrapper-birth" : "unrelated-recycled-birth";
        },
        processGroupAlive: () => true,
      },
    });

    assert.equal(identityReads, 2, "post-close observation detects the recycled group leader");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor MCP attestation rejects boundedly when post-close group retirement remains ambiguous", {
  skip: process.platform === "win32",
  timeout: 7_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-ambiguous-retire-"));
  const executable = join(root, "fake-cursor-agent");
  let identityReads = 0;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write("letagents: ready\\n");
`);
    chmodSync(executable, 0o700);

    const startedAt = Date.now();
    await assert.rejects(assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      env: { ...process.env },
      dependencies: {
        getProcessIdentity() {
          identityReads += 1;
          return identityReads === 1 ? "original-wrapper-birth" : null;
        },
        processGroupAlive: () => true,
      },
    }), /failed while inspecting/);
    assert.ok(Date.now() - startedAt < 5_000, "ambiguous post-close group evidence is bounded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor MCP cancellation uses its exact IPC capability even when later PID evidence is recycled", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-recycled-wrapper-"));
  const executable = join(root, "fake-cursor-agent");
  const readyPath = join(root, "ready");
  let wrapperPid: number | null = null;
  let identityReads = 0;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "--disable-project-configs" || args[1] !== "mcp" || args[2] !== "list") process.exit(2);
writeFileSync(${JSON.stringify(readyPath)}, "ready");
setInterval(() => {}, 1_000);
`);
    chmodSync(executable, 0o700);

    const controller = new AbortController();
    const attestation = assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      env: { ...process.env },
      timeoutMs: 0,
      signal: controller.signal,
      dependencies: {
        getProcessIdentity(pid) {
          wrapperPid ??= pid;
          identityReads += 1;
          return identityReads === 1 ? "original-wrapper-birth" : "unrelated-recycled-birth";
        },
        processGroupAlive: () => true,
      },
    });
    const rejected = assert.rejects(attestation, /failed while inspecting/);
    await eventually(() => existsSync(readyPath), "MCP inspection readiness");

    controller.abort();
    await rejected;
    assert.equal(identityReads, 2, "PID evidence is consulted only at prepare and post-close observation");
  } finally {
    if (wrapperPid && processAlive(wrapperPid)) {
      try {
        process.kill(wrapperPid, "SIGKILL");
      } catch {
        // Best-effort test cleanup after an assertion failure.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("Cursor MCP attestation cancellation reaps a TERM-resistant MCP descendant", {
  skip: process.platform === "win32",
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-attestation-"));
  const executable = join(root, "fake-cursor-agent");
  const descendantPidPath = join(root, "descendant.pid");
  const descendantReadyPath = join(root, "descendant.ready");
  const descendantSource = [
    'const { writeFileSync } = require("node:fs");',
    'process.on("SIGTERM", () => {});',
    `writeFileSync(${JSON.stringify(descendantReadyPath)}, "ready");`,
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  let descendantPid: number | null = null;
  try {
    writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "--disable-project-configs" || args[1] !== "mcp" || args[2] !== "list") process.exit(2);
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });
writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`);
    chmodSync(executable, 0o700);

    const controller = new AbortController();
    const attestation = assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      env: { ...process.env },
      timeoutMs: 0,
      signal: controller.signal,
    });
    const rejected = assert.rejects(attestation, /failed while inspecting/);
    await eventually(() => existsSync(descendantPidPath), "MCP descendant pid");
    descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    await eventually(() => existsSync(descendantReadyPath), "MCP descendant readiness");

    controller.abort();
    await rejected;
    await eventually(() => !processAlive(descendantPid!), "MCP descendant exit");
  } finally {
    if (descendantPid && processAlive(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Best-effort test cleanup after an assertion failure.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function exerciseSuccessfulMcpWithStubbornDescendant(input: {
  inheritOutput: boolean;
  expectSuccess: boolean;
}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "letagents-cursor-mcp-stubborn-success-"));
  const executable = join(root, "fake-cursor-agent");
  const descendantPidPath = join(root, "descendant.pid");
  const descendantReadyPath = join(root, "descendant.ready");
  const descendantSource = [
    'const { writeFileSync } = require("node:fs");',
    'process.on("SIGTERM", () => {});',
    `writeFileSync(${JSON.stringify(descendantReadyPath)}, "ready");`,
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  let descendantPid: number | null = null;
  try {
    const descendantStdio = input.inheritOutput
      ? '["ignore", "inherit", "inherit"]'
      : '"ignore"';
    writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "--disable-project-configs" || args[1] !== "mcp" || args[2] !== "list") process.exit(2);
const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: ${descendantStdio} });
descendant.unref();
writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
function finishAfterDescendantReady() {
  if (!existsSync(${JSON.stringify(descendantReadyPath)})) {
    setTimeout(finishAfterDescendantReady, 10);
    return;
  }
  process.stdout.write("letagents: ready\\n");
}
finishAfterDescendantReady();
`);
    chmodSync(executable, 0o700);

    const attestation = assertCursorSupervisedMcpAuthority({
      cursorBin: executable,
      cwd: root,
      writableProfileRoot: root,
      env: { ...process.env },
    });
    const observed = input.expectSuccess
      ? attestation
      : assert.rejects(attestation, /failed while inspecting/);
    await eventually(() => existsSync(descendantPidPath), "stubborn MCP descendant pid");
    descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
    await eventually(() => existsSync(descendantReadyPath), "stubborn MCP descendant readiness");
    await observed;
    await eventually(() => !processAlive(descendantPid!), "stubborn MCP descendant exit");
  } finally {
    if (descendantPid && processAlive(descendantPid)) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Best-effort test cleanup after an assertion failure.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function eventually(check: () => boolean, label: string): Promise<void> {
  // The full Electron suite launches many child-process tests concurrently;
  // give birth evidence room to appear under CI contention without weakening
  // any production timeout or cleanup bound.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
