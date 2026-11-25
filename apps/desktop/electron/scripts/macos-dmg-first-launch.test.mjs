import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDaemonSocketFits,
  assertGatekeeperAccepted,
  DEFAULT_TIMEOUT_MS,
  FINDER_PATH,
  firstLaunchEnvironment,
  launchUntilExit,
  mountPointFromAttachPlist,
  parseArguments,
  parseDmgName,
  processIdsUnder,
  QUARANTINE_AGENT,
  quarantineValue,
  smokeVerdict,
  SMOKE_RESULT_MARKER,
} from "./macos-dmg-first-launch.mjs";

test("the DMG defaults to the release artifact for this version and architecture", () => {
  const options = parseArguments([], { version: "1.2.3", arch: "arm64" });
  assert.match(options.dmg, /release\/artifacts\/LetAgents-1\.2\.3-darwin-arm64\.dmg$/);
  assert.equal(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(options.workRoot, "/tmp");
  assert.equal(options.unsignedDmg, false);
  assert.equal(options.unsigned, false);
});

test("arguments set the DMG, architecture, limit and the local unsigned modes", () => {
  const options = parseArguments(["--dmg", "/x/LetAgents-1.2.3-darwin-x64.dmg", "--arch", "x64", "--timeout-ms", "1000", "--unsigned", "--keep"], { version: "1.2.3", arch: "arm64" });
  assert.equal(options.dmg, "/x/LetAgents-1.2.3-darwin-x64.dmg");
  assert.equal(options.arch, "x64");
  assert.equal(options.timeoutMs, 1000);
  assert.equal(options.unsigned, true);
  assert.equal(options.unsignedDmg, true, "--unsigned also skips the DMG's checks");
  assert.equal(options.keep, true);
  assert.equal(parseArguments(["--unsigned-dmg"], { version: "1.2.3", arch: "arm64" }).unsigned, false);
});

test("bad arguments are refused", () => {
  for (const argv of [["--arch", "ia32"], ["--timeout-ms", "0"], ["--timeout-ms", "soon"], ["--dmg"], ["--dmg", "--keep"], ["--skip-everything"]]) {
    assert.throws(() => parseArguments(argv, { version: "1.2.3", arch: "arm64" }), undefined, argv.join(" "));
  }
});

test("the DMG name gives the version and architecture", () => {
  assert.deepEqual(parseDmgName("/a/b/LetAgents-0.1.143-darwin-arm64.dmg"), { version: "0.1.143", arch: "arm64" });
  assert.deepEqual(parseDmgName("LetAgents-2.0.0-darwin-x64.dmg"), { version: "2.0.0", arch: "x64" });
  assert.throws(() => parseDmgName("LetAgents-0.1.143-win32-x64-setup.exe"));
  assert.throws(() => parseDmgName("LetAgents-0.1.143-darwin-arm64.zip"));
});

test("the quarantine mark is a browser download that the user has not approved", () => {
  const value = quarantineValue({ now: 0x6b0754df * 1000, id: "0980267d-e8f9-4e35-b69e-b396ee0a6a9c" });
  assert.equal(value, `0081;6b0754df;${QUARANTINE_AGENT};0980267D-E8F9-4E35-B69E-B396EE0A6A9C`);
  const flags = Number.parseInt(value.split(";")[0], 16);
  assert.equal(flags & 0x0001, 0x0001, "downloaded");
  assert.equal(flags & 0x0040, 0, "not user approved, so Gatekeeper assesses the first launch");
  assert.match(quarantineValue(), /^0081;[0-9a-f]{8};[^;]+;[0-9A-F-]{36}$/);
});

test("the mount point comes from hdiutil's plist, and only one is accepted", () => {
  const entity = (point) => `<dict><key>content-hint</key><string>Apple_APFS</string>${point ? `<key>mount-point</key>\n\t\t\t<string>${point}</string>` : ""}</dict>`;
  const plist = (...points) => `<?xml version="1.0"?><plist><dict><key>system-entities</key><array>${points.map(entity).join("")}</array></dict></plist>`;
  assert.equal(mountPointFromAttachPlist(plist(null, "/private/tmp/letagents-dmg-a/dmg.b")), "/private/tmp/letagents-dmg-a/dmg.b");
  assert.throws(() => mountPointFromAttachPlist(plist(null)), /0 mount points/);
  assert.throws(() => mountPointFromAttachPlist(plist("/a", "/b")), /2 mount points/);
});

test("the first launch gets Finder's PATH, an empty HOME and TMPDIR, and none of the caller's settings", () => {
  const env = firstLaunchEnvironment({
    USER: "runner",
    LOGNAME: "runner",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: "/opt/homebrew/bin:/usr/bin",
    HOME: "/Users/runner",
    TMPDIR: "/var/folders/x/T/",
    NVM_BIN: "/Users/runner/.nvm/bin",
    NODE_OPTIONS: "--require /x.js",
    ELECTRON_RUN_AS_NODE: "1",
    LETAGENTS_STATE_PATH: "/Users/runner/state.json",
    LETAGENTS_OPENCODE_BIN: "/x/opencode",
    GITHUB_TOKEN: "not-for-the-app",
  }, { home: "/private/tmp/f/home", temporary: "/private/tmp/f/tmp" });
  assert.deepEqual(env, {
    USER: "runner",
    LOGNAME: "runner",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: FINDER_PATH,
    HOME: "/private/tmp/f/home",
    TMPDIR: "/private/tmp/f/tmp/",
    LETAGENTS_DESKTOP_SMOKE_CHECK: "1",
    LETAGENTS_DESKTOP_SMOKE_DEBUG: "1",
    ELECTRON_ENABLE_LOGGING: "1",
  });
});

test("the daemon socket must fit in a macOS socket path", () => {
  assert.equal(assertDaemonSocketFits("/private/tmp/letagents-dmg-AbCdEf/home"), "/private/tmp/letagents-dmg-AbCdEf/home/.letagents/daemon.sock");
  // The folder that failed with EINVAL: a HOME below the user's TMPDIR.
  assert.throws(
    () => assertDaemonSocketFits("/private/var/folders/lz/6p70_zzs64x8pc5x45qt18j00000gn/T/letagents-dmg-first-launch-lzHaJ9/home"),
    /has 1\d\d bytes; macOS allows 103/,
  );
});

test("Gatekeeper must accept the item as notarized Developer ID software", () => {
  assert.doesNotThrow(() => assertGatekeeperAccepted("/x/LetAgents.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example (TEAMID)\n", "the app"));
  assert.throws(() => assertGatekeeperAccepted("/x/LetAgents.app: accepted\nsource=Developer ID\n", "the app"), /did not accept the app/);
  assert.throws(() => assertGatekeeperAccepted("/x/LetAgents.app: rejected\nsource=Unnotarized Developer ID\n", "the app"), /did not accept/);
  assert.throws(() => assertGatekeeperAccepted("/x/LetAgents.dmg: rejected (the code is valid but does not seem to be an app)\nsource=Notarized Developer ID\n", "the DMG"), /did not accept the DMG/);
});

test("the smoke verdict passes only on exit 0 with every smoke check true", () => {
  const line = (result) => `noise\n${SMOKE_RESULT_MARKER} ${JSON.stringify(result)}\n`;
  assert.equal(smokeVerdict({ status: 0, signal: null, output: line({ appInfo: true, roomSnapshot: true }) }).passed, true);
  const cases = [
    [{ status: 0, signal: null, output: "started\n" }, /without a smoke result/],
    [{ status: 0, signal: null, output: line({ appInfo: true, codexProvider: false }) }, /smoke checks failed: codexProvider/],
    [{ status: 1, signal: null, output: `${SMOKE_RESULT_MARKER} failed: Timed out waiting for desktop smoke UI state\n` }, /exited with 1/],
    [{ status: null, signal: "SIGKILL", output: "" }, /ended by SIGKILL \(Gatekeeper/],
    [{ status: null, signal: "SIGKILL", output: "", timedOut: true, timeoutMs: 5 }, /within 5 ms/],
    [{ status: 0, signal: null, output: `${SMOKE_RESULT_MARKER} {not json\n` }, /without a smoke result/],
  ];
  for (const [launch, reason] of cases) {
    const verdict = smokeVerdict(launch);
    assert.equal(verdict.passed, false, JSON.stringify(launch));
    assert.match(verdict.reason, reason);
  }
});

test("only processes that run from the check's folder are selected", () => {
  const folder = "/private/tmp/letagents-dmg-AbCdEf";
  const ps = [
    `  101 ${folder}/Applications/LetAgents.app/Contents/MacOS/LetAgents ${folder}/Applications/LetAgents.app/Contents/Resources/app/dist-daemon/main.js`,
    "  102 /Applications/LetAgents.app/Contents/MacOS/LetAgents /Applications/LetAgents.app/Contents/Resources/app/dist-daemon/main.js",
    `  103 ${folder}-other/Applications/LetAgents.app/Contents/MacOS/LetAgents`,
    `  104 node macos-dmg-first-launch.mjs --work-root ${folder}/`,
    "garbage",
  ].join("\n");
  assert.deepEqual(processIdsUnder(ps, folder, { exclude: [104] }), [101]);
  assert.deepEqual(processIdsUnder(ps, `${folder}/`, { exclude: [] }), [101, 104]);
});

/** A stand-in app: Node runs the given program text. */
const standIn = (program) => ({ executable: process.execPath, args: ["-e", program], env: process.env, echo: false });

test("a launch that exits by itself reports its status and output", async () => {
  const launch = await launchUntilExit({ ...standIn(`console.log("${SMOKE_RESULT_MARKER} {\\"appInfo\\":true}"); process.exit(0);`), timeoutMs: 20_000 });
  assert.equal(launch.status, 0);
  assert.equal(launch.timedOut, false);
  assert.equal(smokeVerdict(launch).passed, true);
});

test("a launch that does not finish is stopped at the time limit", async () => {
  let stopped = null;
  const launch = await launchUntilExit({
    ...standIn(`console.log("waiting"); setInterval(() => {}, 1000);`),
    timeoutMs: 500,
    onTimeout: async (child) => { stopped = child.pid; },
  });
  assert.ok(stopped, "onTimeout ran");
  assert.equal(launch.timedOut, true);
  assert.equal(launch.signal, "SIGKILL");
  assert.match(launch.output, /waiting/);
  assert.equal(smokeVerdict({ ...launch, timeoutMs: 500 }).passed, false);
});

test("a process the app leaves running with its output does not hold the result", async () => {
  // The app exits; a child it started keeps the inherited output pipes open.
  const program = `
    const { spawn } = require("node:child_process");
    const left = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit", detached: true });
    left.unref();
    console.log("left " + left.pid);
    console.log("${SMOKE_RESULT_MARKER} {\\"appInfo\\":true}");
    process.exit(0);`;
  const startedAt = Date.now();
  const launch = await launchUntilExit({ ...standIn(program), timeoutMs: 20_000, closeGraceMs: 300 });
  const left = Number(/left (\d+)/.exec(launch.output)?.[1]);
  try { process.kill(left, "SIGKILL"); } catch { /* already gone */ }
  assert.ok(left > 0, "the stand-in reported the process it left");
  assert.ok(Date.now() - startedAt < 10_000, "the result came soon after the exit");
  assert.equal(smokeVerdict(launch).passed, true);
});
