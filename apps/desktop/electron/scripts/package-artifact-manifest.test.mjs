import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPackageArtifactManifest,
  isMachO,
  nestedCodeSignArguments,
  packageArtifactManifestPath,
  parseSigningIdentityHash,
  readPackageArtifactManifest,
  resolveManifestEntry,
  signMacBundleWithManifest,
  signManifestMachOEntries,
  verifyPackageArtifactManifest,
} from "./package-artifact-manifest.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const IDENTITY = "Developer ID Application: Example (TEAM123456)";
const IDENTITY_HASH = "0123456789ABCDEF0123456789ABCDEF01234567";
const FIND_IDENTITY = `  1) ${IDENTITY_HASH} "${IDENTITY}"\n     1 valid identities found\n`;

// A thin arm64 Mach-O header (MH_MAGIC_64, little-endian) and some body bytes.
const machOBytes = () => Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]), Buffer.alloc(64, 7)]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "letagents-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Writes the files into the bundle and a manifest that lists them as they are. */
async function makeBundle(directory, { platform, files }) {
  const bundle = join(directory, platform === "darwin" ? "LetAgents.app" : "LetAgents");
  const entries = [];
  for (const [path, bytes] of Object.entries(files)) {
    const absolutePath = resolveManifestEntry({ bundle, platform, path });
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, bytes);
    entries.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = { format: 2, platform, arch: "arm64", files: entries };
  await mkdir(dirname(packageArtifactManifestPath({ bundle, platform })), { recursive: true });
  await writeFile(packageArtifactManifestPath({ bundle, platform }), `${JSON.stringify(manifest, null, 2)}\n`);
  return bundle;
}

/** A codesign stand-in that rewrites a Mach-O file the way a signature does. */
function fakeSigner({ calls }) {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (command === "security") return { stdout: FIND_IDENTITY, stderr: "" };
    if (command === "codesign" && args[0] === "--sign") {
      const file = args.at(-1);
      await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("signature")]));
    }
    return { stdout: "", stderr: "" };
  };
}

test("the verifier accepts a bundle whose files match the manifest", async (t) => {
  const directory = await temporaryDirectory(t);
  const bundle = await makeBundle(directory, {
    platform: "darwin",
    files: {
      "dist-electron/main.js": "console.log(1);\n",
      "runtime/opencode": machOBytes(),
      "Contents/shared/routing-aliases.mjs": "export {};\n",
    },
  });
  assert.equal(await assertPackageArtifactManifest({ bundle, platform: "darwin" }), 3);
});

test("the verifier reports every entry that differs from the file that ships", async (t) => {
  const directory = await temporaryDirectory(t);
  const bundle = await makeBundle(directory, {
    platform: "darwin",
    files: {
      "dist-electron/main.js": "console.log(1);\n",
      "dist-electron/page-preload.cjs": "module.exports = 1;\n",
      "runtime/opencode": machOBytes(),
      "Contents/shared/routing-aliases.mjs": "export {};\n",
    },
  });
  const manifest = await readPackageArtifactManifest({ bundle, platform: "darwin" });
  // Same size, other bytes.
  await writeFile(join(bundle, "Contents/Resources/app/dist-electron/main.js"), "console.log(2);\n");
  // Signing grows a Mach-O file.
  await writeFile(join(bundle, "Contents/Resources/app/runtime/opencode"), Buffer.concat([machOBytes(), Buffer.from("signature")]));
  await rm(join(bundle, "Contents/shared/routing-aliases.mjs"));
  manifest.files.push({ ...manifest.files[1] });
  const { checked, mismatches } = await verifyPackageArtifactManifest({ bundle, platform: "darwin", manifest });
  assert.equal(checked, 5);
  assert.deepEqual(mismatches.map(({ path, reason }) => [path, reason.split(" ")[0]]), [
    ["dist-electron/main.js", "SHA-256"],
    ["runtime/opencode", "size"],
    ["Contents/shared/routing-aliases.mjs", "missing"],
    ["dist-electron/page-preload.cjs", "listed"],
  ]);
  await assert.rejects(
    assertPackageArtifactManifest({ bundle, platform: "darwin" }),
    (error) => /dist-electron\/main\.js: SHA-256/.test(error.message)
      && /runtime\/opencode: size is \d+, manifest has \d+/.test(error.message)
      && /routing-aliases\.mjs: missing/.test(error.message),
  );
});

test("the verifier rejects a manifest for another platform or with no files", async (t) => {
  const directory = await temporaryDirectory(t);
  const bundle = await makeBundle(directory, { platform: "darwin", files: { LICENSE: "MIT\n" } });
  const manifest = await readPackageArtifactManifest({ bundle, platform: "darwin" });
  const { mismatches } = await verifyPackageArtifactManifest({ bundle, platform: "darwin", manifest: { ...manifest, platform: "win32" } });
  assert.deepEqual(mismatches.map(({ path }) => path), ["package-artifact-manifest.json"]);
  await writeFile(packageArtifactManifestPath({ bundle, platform: "darwin" }), JSON.stringify({ ...manifest, files: [] }));
  await assert.rejects(assertPackageArtifactManifest({ bundle, platform: "darwin" }), /lists no files/);
});

test("Windows entries resolve against the install folder or resources/app", async (t) => {
  const directory = await temporaryDirectory(t);
  const bundle = await makeBundle(directory, {
    platform: "win32",
    files: {
      "LetAgents.exe": "MZ",
      "resources/letagents.ico": "ico",
      "resources/app-update.yml": "provider: generic\n",
      "shared/process-tree.mjs": "export {};\n",
      "runtime/opencode.exe": "MZ opencode",
      LICENSE: "MIT\n",
    },
  });
  assert.equal(resolveManifestEntry({ bundle, platform: "win32", path: "LetAgents.exe" }), join(bundle, "LetAgents.exe"));
  assert.equal(resolveManifestEntry({ bundle, platform: "win32", path: "runtime/opencode.exe" }), join(bundle, "resources", "app", "runtime", "opencode.exe"));
  assert.equal(await assertPackageArtifactManifest({ bundle, platform: "win32" }), 6);
});

test("manifest paths cannot leave the bundle", () => {
  for (const path of ["../outside", "runtime/../../x", "/etc/passwd", "C:/Windows/x", "runtime\\opencode.exe", "runtime//x", "", undefined]) {
    assert.throws(() => resolveManifestEntry({ bundle: "/b/LetAgents.app", platform: "darwin", path }), /unsafe path/, String(path));
  }
});

test("Mach-O detection accepts thin and universal binaries only", () => {
  assert.equal(isMachO(machOBytes()), true);
  assert.equal(isMachO(Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0])), true);
  assert.equal(isMachO(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])), true);
  // A Java class file: same magic, then minor and major version (52).
  assert.equal(isMachO(Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52])), false);
  assert.equal(isMachO(Buffer.from("#!/bin/sh\necho\n")), false);
  assert.equal(isMachO(Buffer.from([0xcf, 0xfa])), false);
});

test("the signing identity is chosen the way osx-sign chooses it", () => {
  const output = `  1) ${IDENTITY_HASH} "${IDENTITY}"\n  2) FEDCBA9876543210FEDCBA9876543210FEDCBA98 "${IDENTITY}"\n     2 valid identities found\n`;
  assert.equal(parseSigningIdentityHash(output, IDENTITY), IDENTITY_HASH);
  assert.throws(() => parseSigningIdentityHash("     0 valid identities found\n", IDENTITY), /No valid code signing identity/);
});

test("signed Mach-O entries are recorded with their signed bytes", async (t) => {
  const directory = await temporaryDirectory(t);
  const bundle = await makeBundle(directory, {
    platform: "darwin",
    files: {
      "dist-electron/main.js": "console.log(1);\n",
      "runtime/opencode": machOBytes(),
      "Contents/shared/routing-aliases.mjs": "export {};\n",
    },
  });
  const before = await readPackageArtifactManifest({ bundle, platform: "darwin" });
  const calls = [];
  const opencode = join(bundle, "Contents", "Resources", "app", "runtime", "opencode");
  const signed = await signManifestMachOEntries({ bundle, identity: IDENTITY, entitlements: "/osx-sign/default.darwin.plist", execFile: fakeSigner({ calls }) });

  assert.deepEqual([...signed], [opencode]);
  assert.deepEqual(calls, [
    ["security", "find-identity", "-v"],
    ["codesign", ...nestedCodeSignArguments({ identityHash: IDENTITY_HASH, entitlements: "/osx-sign/default.darwin.plist", file: opencode })],
    ["codesign", "--verify", "--strict", "--verbose=2", opencode],
  ]);
  const after = await readPackageArtifactManifest({ bundle, platform: "darwin" });
  assert.deepEqual(after.files.filter(({ path }) => path !== "runtime/opencode"), before.files.filter(({ path }) => path !== "runtime/opencode"));
  const opencodeEntry = after.files.find(({ path }) => path === "runtime/opencode");
  assert.deepEqual(Object.keys(opencodeEntry), ["path", "bytes", "sha256"]);
  assert.equal(opencodeEntry.sha256, sha256(await readFile(opencode)));
  assert.notEqual(opencodeEntry.sha256, before.files.find(({ path }) => path === "runtime/opencode").sha256);
  assert.equal(await assertPackageArtifactManifest({ bundle, platform: "darwin" }), 3);
});

test("a manifest written before signing does not describe a signed Mach-O entry", async (t) => {
  // The 0.1.143 failure: osx-sign signs OpenCode after the manifest is written.
  const directory = await temporaryDirectory(t);
  const bundle = await makeBundle(directory, { platform: "darwin", files: { "runtime/opencode": machOBytes() } });
  const opencode = join(bundle, "Contents", "Resources", "app", "runtime", "opencode");
  await fakeSigner({ calls: [] })("codesign", ["--sign", IDENTITY_HASH, "--force", opencode]);
  await assert.rejects(assertPackageArtifactManifest({ bundle, platform: "darwin" }), /runtime\/opencode: size/);
});

test("a bundle with no Mach-O entries needs no identity", async (t) => {
  const directory = await temporaryDirectory(t);
  const bundle = await makeBundle(directory, { platform: "darwin", files: { LICENSE: "MIT\n" } });
  const calls = [];
  assert.equal((await signManifestMachOEntries({ bundle, identity: IDENTITY, entitlements: "/e.plist", execFile: fakeSigner({ calls }) })).size, 0);
  assert.deepEqual(calls, []);
});

test("osx-sign signs a nested file with the arguments the manifest pre-sign uses, and skips ignored files", {
  skip: process.platform !== "darwin" && "osx-sign adds the hardened runtime only on macOS",
}, async (t) => {
  const { sign } = await import("@electron/osx-sign");
  const entitlements = fileURLToPath(new URL("../entitlements/default.darwin.plist", import.meta.resolve("@electron/osx-sign")));
  assert.ok(existsSync(entitlements), "package-macos.mjs pre-signs with osx-sign's default entitlements");

  const directory = await temporaryDirectory(t);
  const bin = join(directory, "bin");
  const log = join(directory, "codesign.log");
  await mkdir(bin);
  await writeFile(join(bin, "codesign"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\t' "$a"; done >> "${log}"\necho >> "${log}"\n`);
  await writeFile(join(bin, "security"), `#!/bin/sh\nprintf '%s' '${FIND_IDENTITY}'\n`);
  await chmod(join(bin, "codesign"), 0o755);
  await chmod(join(bin, "security"), 0o755);
  const app = join(directory, "LetAgents.app");
  const opencode = join(app, "Contents", "Resources", "app", "runtime", "opencode");
  const other = join(app, "Contents", "Resources", "app", "runtime", "other-tool");
  await mkdir(dirname(opencode), { recursive: true });
  await writeFile(opencode, machOBytes());
  await writeFile(other, machOBytes());

  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    await sign({
      app,
      identity: IDENTITY,
      platform: "darwin",
      type: "distribution",
      hardenedRuntime: true,
      preEmbedProvisioningProfile: false,
      preAutoEntitlements: false,
      optionsForFile: (filePath) => filePath === app ? { entitlements } : {},
      ignore: (filePath) => filePath === opencode,
    });
  } finally {
    process.env.PATH = path;
  }
  const signing = (await readFile(log, "utf8")).trim().split("\n").map((line) => line.replace(/\t$/, "").split("\t")).filter((args) => args[0] === "--sign");
  assert.equal(signing.some((args) => args.at(-1) === opencode), false, "osx-sign leaves an ignored file alone");
  assert.deepEqual(signing.find((args) => args.at(-1) === other), nestedCodeSignArguments({ identityHash: IDENTITY_HASH, entitlements, file: other }));
});

test("symbolic links are not accepted as manifest entries", async (t) => {
  const directory = await temporaryDirectory(t);
  const bundle = await makeBundle(directory, {
    platform: "darwin",
    files: { "runtime/opencode": machOBytes(), "dist-electron/main.js": "console.log(1);\n" },
  });
  const app = join(bundle, "Contents", "Resources", "app");
  // A link to a file with the same bytes still fails.
  await writeFile(join(directory, "outside.js"), "console.log(1);\n");
  await rm(join(app, "dist-electron", "main.js"));
  await symlink(join(directory, "outside.js"), join(app, "dist-electron", "main.js"));
  // A linked folder above an entry fails too.
  await rename(join(app, "runtime"), join(directory, "runtime"));
  await symlink(join(directory, "runtime"), join(app, "runtime"));
  const { mismatches } = await verifyPackageArtifactManifest({ bundle, platform: "darwin" });
  assert.deepEqual(mismatches.map(({ path }) => path), ["runtime/opencode", "dist-electron/main.js"]);
  assert.ok(mismatches.every(({ reason }) => /symbolic link/.test(reason)));
  await assert.rejects(
    signManifestMachOEntries({ bundle, identity: IDENTITY, entitlements: "/e.plist", execFile: fakeSigner({ calls: [] }) }),
    /symbolic link/,
  );
});

test("the verifier refuses a folder where a file is listed", async (t) => {
  const directory = await temporaryDirectory(t);
  const bundle = await makeBundle(directory, { platform: "darwin", files: { LICENSE: "MIT\n" } });
  await rm(join(bundle, "Contents", "Resources", "app", "LICENSE"));
  await mkdir(join(bundle, "Contents", "Resources", "app", "LICENSE"));
  const { mismatches } = await verifyPackageArtifactManifest({ bundle, platform: "darwin" });
  assert.match(mismatches[0].reason, /not a regular file/);
});

test("only plain Mach-O files in Contents/Resources/app are pre-signed", async (t) => {
  for (const path of ["Contents/MacOS/LetAgents", "Contents/Frameworks/Tool.framework/Tool", "runtime/Nested.app/Contents/MacOS/Nested"]) {
    const directory = await temporaryDirectory(t);
    const bundle = await makeBundle(directory, { platform: "darwin", files: { [path]: machOBytes() } });
    const calls = [];
    await assert.rejects(
      signManifestMachOEntries({ bundle, identity: IDENTITY, entitlements: "/e.plist", execFile: fakeSigner({ calls }) }),
      /not a plain file in Contents\/Resources\/app/,
      path,
    );
    assert.deepEqual(calls, [], `${path}: nothing is signed`);
  }
});

test("the macOS signing order pre-signs, seals, verifies, then checks the manifest", async (t) => {
  const directory = await temporaryDirectory(t);
  const bundle = await makeBundle(directory, {
    platform: "darwin",
    files: { "runtime/opencode": machOBytes(), "dist-electron/main.js": "console.log(1);\n" },
  });
  const opencode = join(bundle, "Contents", "Resources", "app", "runtime", "opencode");
  const steps = [];
  const execFile = async (command, args) => {
    steps.push(`${command} ${args[0]}${args.includes("--deep") ? " --deep" : ""}`);
    return fakeSigner({ calls: [] })(command, args);
  };
  const signBundle = async ({ ignore }) => {
    steps.push("osx-sign");
    assert.equal(ignore(opencode), true);
    assert.equal(ignore(join(bundle, "Contents", "Resources", "app", "dist-electron", "main.js")), false);
    assert.equal(ignore(bundle), false);
  };
  assert.equal(await signMacBundleWithManifest({ bundle, identity: IDENTITY, entitlements: "/e.plist", execFile, signBundle }), 2);
  assert.deepEqual(steps, ["security find-identity", "codesign --sign", "codesign --verify", "osx-sign", "codesign --verify --deep"]);

  // A bundle seal that changes a listed file fails before notarization.
  const changed = await makeBundle(await temporaryDirectory(t), { platform: "darwin", files: { "runtime/opencode": machOBytes() } });
  const changedOpenCode = join(changed, "Contents", "Resources", "app", "runtime", "opencode");
  await assert.rejects(
    signMacBundleWithManifest({
      bundle: changed,
      identity: IDENTITY,
      entitlements: "/e.plist",
      execFile: fakeSigner({ calls: [] }),
      // osx-sign without the ignore function: it signs OpenCode again.
      signBundle: () => fakeSigner({ calls: [] })("codesign", ["--sign", IDENTITY_HASH, "--force", changedOpenCode]),
    }),
    /runtime\/opencode: size/,
  );
});

test("package-macos.mjs uses the signing order and checks the manifest in the final app", async () => {
  const mac = await readFile(join(scriptsDirectory, "package-macos.mjs"), "utf8");
  const position = (text) => {
    const index = mac.indexOf(text);
    assert.notEqual(index, -1, `missing: ${text}`);
    return index;
  };
  const signing = position("await signMacBundleWithManifest(");
  assert.ok(signing < position("await sign("), "osx-sign runs inside the signing order");
  assert.match(mac.slice(signing, position("await assertPackagedElectronFuses(")), /\n\s+ignore,\n/, "osx-sign gets the ignore function");
  assert.ok(signing < position("notarizeWithStapleRecovery({ appPath: packagedApp"), "the first check runs before notarization");
  const check = position("await assertPackageArtifactManifest({ bundle: packagedApp, platform: \"darwin\" })");
  assert.ok(check > position("await validateStapledTicket(packagedApp"), "the check reads the stapled app");
  assert.ok(check < position("\"ditto\""), "the check runs before the update zip");
  assert.ok(check < position("\"hdiutil\""), "the check runs before the DMG");

  const windows = await readFile(join(scriptsDirectory, "package-windows.mjs"), "utf8");
  const windowsCheck = windows.indexOf("await assertPackageArtifactManifest({ bundle: packagedApp, platform: \"win32\" })");
  assert.ok(windowsCheck > 0, "package-windows.mjs checks the manifest");
  assert.ok(windowsCheck < windows.indexOf("execFileAsync(makensis, ["), "the check runs before the installer");
});
