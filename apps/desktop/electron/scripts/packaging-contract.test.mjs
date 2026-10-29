import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptsDirectory, "../..");
const repositoryRoot = resolve(desktopRoot, "../..");

async function source(path) {
  return readFile(path, "utf8");
}

test("manual release builds never publish, even when dispatched on a release tag", async () => {
  const workflow = parse(await source(join(repositoryRoot, ".github/workflows/desktop-release.yml")));
  assert.equal(workflow.jobs.publish.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/desktop-v')");
  assert.deepEqual(workflow.jobs.publish.needs, ["build-macos", "build-windows"]);
  assert.equal(workflow.jobs["build-windows"].needs, "build-macos");
  for (const job of ["build-macos", "build-windows"]) {
    assert.equal(workflow.jobs[job].permissions.contents, "read");
    assert.doesNotMatch(workflow.jobs[job].steps.map(step => step.run ?? "").join("\n"), /aws s3|gh release|npm publish/);
    assert.ok(workflow.jobs[job].steps.some(step => step.name === "Upload release artifacts to this workflow"));
  }
  assert.ok(workflow.jobs["build-macos"].steps.some(step => step.name === "Build, sign, notarize, and package"));
  assert.ok(workflow.jobs["build-windows"].steps.some(step => step.name === "Build and package the Windows installer"));
});

test("the Windows release job installs, smoke-checks and uploads the installer with no new secrets", async () => {
  const workflow = parse(await source(join(repositoryRoot, ".github/workflows/desktop-release.yml")));
  const job = workflow.jobs["build-windows"];
  // windows-2025 (windows-latest) has no NSIS; windows-2022 ships it.
  assert.equal(job["runs-on"], "windows-2022");
  const steps = job.steps.map(step => step.name ?? step.uses);
  const packageStep = steps.indexOf("Build and package the Windows installer");
  const smokeStep = steps.indexOf("Install, smoke-check, and uninstall the installer");
  const uploadStep = steps.indexOf("Upload release artifacts to this workflow");
  assert.ok(packageStep >= 0 && smokeStep > packageStep && uploadStep > smokeStep, "the installer is uploaded only after it installed and ran");
  assert.equal(job.steps[smokeStep].run, "npm --prefix apps/desktop run smoke:windows-install");
  assert.match(job.steps[packageStep].run, /npm --prefix apps\/desktop run package:win/);
  assert.equal(job.steps[uploadStep].with.name, "desktop-release-win32-x64");
  assert.doesNotMatch(JSON.stringify(job), /secrets\./, "Windows builds are unsigned and need no secrets");
  const openCode = job.steps.find(step => step.name === "Install the locked OpenCode runtime").run;
  assert.match(openCode, /LETAGENTS_OPENCODE_BIN=\$\{RUNNER_TEMP\}\/opencode\/node_modules\/opencode-ai\/bin\/opencode\.exe/);
});

test("release ref validation accepts manual candidates while rejecting incorrect pushed tags and architectures", async () => {
  const workflow = parse(await source(join(repositoryRoot, ".github/workflows/desktop-release.yml")));
  const { version } = JSON.parse(await source(join(desktopRoot, "package.json")));
  const temporary = await mkdtemp(join(tmpdir(), "letagents-release-ref-"));
  try {
    for (const job of ["build-macos", "build-windows"]) {
    const script = workflow.jobs[job].steps.find(step => step.name === "Validate release ref, version, and runner architecture").run;
    const cases = [
      ["workflow_dispatch", "branch", "codex/candidate", process.arch, 0],
      ["workflow_dispatch", "tag", `desktop-v${version}`, process.arch, 0],
      ["push", "tag", `desktop-v${version}`, process.arch, 0],
      ["push", "tag", "desktop-v0.0.0", process.arch, 1],
      ["push", "branch", "staging", process.arch, 1],
      ["workflow_dispatch", "branch", "codex/candidate", "wrong-architecture", 1],
    ];
    for (const [event, type, name, arch, status] of cases) {
      const result = spawnSync("bash", ["-c", script], {
        cwd: repositoryRoot,
        env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF_TYPE: type, GITHUB_REF_NAME: name, EXPECTED_ARCH: arch, GITHUB_ENV: join(temporary, "environment") },
        encoding: "utf8",
      });
      assert.equal(result.status, status, `${job}:${event}:${type}:${name}:${arch}\n${result.stderr}`);
    }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("packaging preserves APNs plist behavior and rebrands every Electron helper", async () => {
  const [packager, smoke] = await Promise.all([
    source(join(scriptsDirectory, "package-artifact.mjs")),
    source(join(scriptsDirectory, "packaged-supervisor-smoke.mjs")),
  ]);

  assert.match(packager, /\["NSUserNotificationAlertStyle", "alert"\]/);
  assert.match(packager, /rebrandHelper\(\{\}\)/);
  assert.match(packager, /qualifier: " \(GPU\)"/);
  assert.match(packager, /qualifier: " \(Plugin\)"/);
  assert.match(packager, /qualifier: " \(Renderer\)"/);
  assert.match(smoke, /"Contents", "MacOS", "LetAgents"/);
  assert.match(smoke, /daemonTypes\.DAEMON_PROTOCOL_VERSION/);
  assert.doesNotMatch(smoke, /const protocolVersion = \d+/);
});

test("packaging rejects a non-square application icon before generating the iconset", async () => {
  const packager = await source(join(scriptsDirectory, "package-artifact.mjs"));

  assert.match(packager, /"brand", "letagents-app-icon\.png"/);
  assert.doesNotMatch(packager, /"docs", "logo\.png"/);
  assert.match(packager, /sips", \["-g", "pixelWidth", "-g", "pixelHeight"/);
  assert.match(packager, /assertSquareImageDimensions\(parseSipsDimensions\(sourceMetadata\), source\)/);
});

test("signed release packaging requires and embeds the APNs provisioning contract", async () => {
  const [packager, entitlements, workflow] = await Promise.all([
    source(join(scriptsDirectory, "package-macos.mjs")),
    source(join(desktopRoot, "electron", "entitlements.mac.plist")),
    source(join(repositoryRoot, ".github", "workflows", "desktop-release.yml")),
  ]);

  assert.match(entitlements, /<key>com\.apple\.developer\.aps-environment<\/key>\s*<string>production<\/string>/);
  assert.match(packager, /MACOS_PROVISIONING_PROFILE_PATH/);
  assert.match(packager, /"Contents", "embedded\.provisionprofile"/);
  assert.match(packager, /provisioningProfile,/);
  assert.match(packager, /optionsForFile:/);
  assert.match(packager, /entitlements\.mac\.plist/);
  assert.match(workflow, /MACOS_PROVISIONING_PROFILE_BASE64: \$\{\{ secrets\.MACOS_PROVISIONING_PROFILE_BASE64 \}\}/);
  assert.match(workflow, /MACOS_PROVISIONING_PROFILE_PATH=/);
});

test("release DMGs are signed before notarization and Gatekeeper assessment", async () => {
  const packager = await source(join(scriptsDirectory, "package-macos.mjs"));
  const signDmg = packager.indexOf('await execFileAsync("codesign", ["--sign", identity, "--force", "--timestamp", dmg]);');
  const verifyDmg = packager.indexOf('await execFileAsync("codesign", ["--verify", "--verbose=2", dmg]);');
  const notarizeDmg = packager.indexOf("await notarizeWithStapleRecovery({ appPath: dmg, ...credentials }, { notarize, execFile: execFileAsync });");
  const validateDmg = packager.indexOf('await validateStapledTicket(dmg, { execFile: execFileAsync });');
  const assessDmg = packager.indexOf('"context:primary-signature"');

  assert.ok(signDmg >= 0, "the DMG must receive a Developer ID signature");
  assert.ok(verifyDmg > signDmg, "the DMG signature must be verified after signing");
  assert.ok(notarizeDmg > verifyDmg, "the signed DMG must be notarized after verification");
  assert.ok(validateDmg > notarizeDmg, "the stapled ticket must be validated after notarization and recovery");
  assert.ok(assessDmg > validateDmg, "Gatekeeper assessment must run after ticket validation");
});

test("release workflow builds, attests, and publishes independent public R2 feeds", async () => {
  const workflow = await source(join(repositoryRoot, ".github", "workflows", "desktop-release.yml"));

  assert.match(workflow, /arch: arm64\s+runner: macos-15/);
  assert.match(workflow, /arch: x64\s+runner: macos-15-intel/);
  assert.match(
    workflow,
    /uses: actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4/,
    "release provenance must use the reviewed immutable actions/attest v4 commit",
  );
  assert.match(workflow, /github\.event\.repository\.visibility == 'public'/);
  assert.match(workflow, /vars\.ENABLE_DESKTOP_PROVENANCE_ATTESTATION == 'true'/);
  assert.match(workflow, /Report unavailable provenance attestation/);
  assert.match(workflow, /artifact-metadata: write/);
  assert.match(workflow, /R2_ACCESS_KEY_ID: \$\{\{ secrets\.R2_ACCESS_KEY_ID \}\}/);
  assert.match(workflow, /R2_SECRET_ACCESS_KEY: \$\{\{ secrets\.R2_SECRET_ACCESS_KEY \}\}/);
  assert.match(workflow, /desktop\/v\$\{DESKTOP_VERSION\}/);
  assert.match(workflow, /public-release-manifest\.mjs/);
  assert.match(workflow, /current_key="desktop\/current\.json"/);
  assert.match(workflow, /feed_key="desktop\/feeds\/\$\{arch\}\/\$\{public_name\}"/);
  assert.match(workflow, /RELEASES-\$\{arch\}\.json\|RELEASES\.json\|application\/json/);
  assert.match(workflow, /latest-mac-\$\{arch\}\.yml\|latest-mac\.yml\|application\/yaml/);
  // Windows: its own feed folder, read by NsisUpdater as latest.yml.
  assert.match(workflow, /for arch in arm64 x64 win32-x64; do/);
  assert.match(workflow, /win32-\*\) feed_specs=\("latest-\$\{arch\}\.yml\|latest\.yml\|application\/yaml"\)/);
  assert.match(workflow, /\*\.exe\) content_type="application\/vnd\.microsoft\.portable-executable"/);
  assert.match(workflow, /\*\.blockmap\) content_type="application\/octet-stream"/);
  assert.match(workflow, /\*\.txt\) content_type="text\/plain"/);
  assert.match(workflow, /public,max-age=31536000,immutable/);
  assert.match(workflow, /public,max-age=60,must-revalidate/);
  assert.ok(
    workflow.indexOf("Advance public website release pointer")
      > workflow.indexOf("Advance public architecture-specific update feeds"),
    "the website pointer must advance only after every update feed",
  );
  assert.ok(
    workflow.indexOf("Validate mutable release monotonicity")
      < workflow.indexOf("Publish immutable versioned release"),
    "the downgrade guard must run before GitHub or updater feed publication",
  );
  const monotonicityGuard = await readFile(
    new URL("./release-monotonicity.mjs", import.meta.url),
    "utf8",
  );
  assert.match(monotonicityGuard, /Refusing to publish mutable channels/);
  assert.doesNotMatch(workflow, /if aws s3api head-object/);
  assert.match(workflow, /Immutable R2 object/);
  assert.match(workflow, /RELEASES-\$\{arch\}\.json/);
  assert.match(workflow, /GITHUB_REF_NAME}" --draft=false --prerelease --latest=false/);
  assert.doesNotMatch(workflow, /releases\/latest/);
  assert.doesNotMatch(workflow, /--latest(?:\s|$)/);
  assert.doesNotMatch(workflow, /desktop-feed-\$\{arch\}/);
});

test("Windows packaging bundles opencode.exe and points the packaged updater at the Windows feed", async () => {
  const [packager, windowsPackager] = await Promise.all([
    source(join(scriptsDirectory, "package-artifact.mjs")),
    source(join(scriptsDirectory, "package-windows.mjs")),
  ]);
  assert.match(packager, /const bundledOpenCode = windows \? "opencode\.exe" : "opencode";/);
  assert.match(packager, /createDesktopUpdaterConfig\(\{ arch: desktopArch, platform: process\.platform \}\)/);
  assert.match(packager, /assertWindowsExecutableBytes\(await readFile\(openCodePath\), openCodePath\)/);
  assert.match(packager, /brandWindowsExecutable\(/);
  // The MCP runtime is installed and digest-checked by the same code on both platforms.
  assert.equal(packager.match(/installLockedMcpRuntime\(/g)?.length, 1);
  assert.match(packager, /runtimeTreeSha256 !== runtimeIntegrity\.LETAGENTS_MCP_RUNTIME_TREE_SHA256/);
  assert.match(windowsPackager, /signed: false/);
  assert.match(windowsPackager, /createDifferentialBlockmap\(installer, blockmap\)/);
});

test("the installer's shortcuts and the app's process share one AppUserModelID", async () => {
  const [installer, identity, main, windowsPackaging] = await Promise.all([
    source(join(desktopRoot, "electron", "installer", "windows", "installer.nsi")),
    source(join(desktopRoot, "electron", "main", "windows-app-identity.ts")),
    source(join(desktopRoot, "electron", "main.ts")),
    import("./windows-packaging.mjs"),
  ]);
  const installerId = /^!define APP_ID "([^"]+)"$/m.exec(installer)?.[1];
  const processId = /export const WINDOWS_APP_USER_MODEL_ID = "([^"]+)";/.exec(identity)?.[1];
  assert.ok(installerId);
  assert.equal(processId, installerId);
  assert.equal(windowsPackaging.WINDOWS_APP_USER_MODEL_ID, installerId);
  // Each shortcut the installer creates gets the ID right after it is created.
  const shortcuts = [...installer.matchAll(/CreateShortCut "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(shortcuts, ["$SMPROGRAMS\\${PRODUCT_NAME}.lnk", "$DESKTOP\\${PRODUCT_NAME}.lnk"]);
  for (const shortcut of shortcuts) {
    const created = installer.indexOf(`CreateShortCut "${shortcut}"`);
    const tagged = installer.indexOf(`!insertmacro SET_SHORTCUT_APP_ID "${shortcut}"`);
    assert.ok(tagged > created && installer.slice(created, tagged).split("\n").length <= 2, `${shortcut} gets the AppUserModelID`);
  }
  assert.match(installer, /\$\{IPropertyStore::SetValue\} \$2 '\(\$3,\$6\)'/);
  assert.match(installer, /PKEY_AppUserModel_ID/);
  // The app sets it before notifications are prepared and any window opens.
  const applied = main.indexOf("applyWindowsAppUserModelId(app);");
  assert.ok(applied > 0);
  assert.ok(applied < main.indexOf("prepareDesktopNotifications();\n"));
  assert.ok(applied < main.indexOf("createWindow();"));
});
