#!/usr/bin/env node
// Build letagents-process-tree.exe with MSVC, and check it against its seal.
//
//   node apps/desktop/native/win-process-tree/build.mjs [--arch x64|arm64] [--check [--strict]]
//
// Runs on Windows with Visual Studio's C++ tools (windows-latest has them).
// No npm package and no install script takes part: the compiler is found
// with Visual Studio's own vswhere.exe. /Brepro makes the output the same
// bytes for the same source and the same compiler, so the digest of a
// build is recorded in shared/letagents-process-tree.seal.json, where the
// app reads it at run time and refuses a helper with other bytes.
//
// --check fails when the source changed without the seal moving, and when
// the same compiler and SDK as the seal's built different bytes. A newer
// compiler on the runner gives other bytes: that is reported as a warning
// with the values to reseal, not a failure, so a runner image update does
// not fail every pull request. --strict (packaging) fails on any build that
// is not the sealed one: the app would refuse to use it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkProcessTreeSeal, sourceDigest } from "./seal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "letagents-process-tree.c");
const sealPath = join(here, "..", "..", "..", "..", "shared", "letagents-process-tree.seal.json");

const args = process.argv.slice(2);
const arch = args.includes("--arch") ? args[args.indexOf("--arch") + 1] : "x64";
const strict = args.includes("--strict");
const check = strict || args.includes("--check");
if (arch !== "x64" && arch !== "arm64") throw new Error(`Unknown --arch ${arch}: use x64 or arm64.`);

const seal = JSON.parse(readFileSync(sealPath, "utf8"));
const actualSource = sourceDigest(readFileSync(source));
if (check && actualSource !== seal.sourceSha256) {
  console.error(`letagents-process-tree.c changed (sha256 ${actualSource}) but the seal still names ${seal.sourceSha256}.`);
  console.error("Build it on Windows with this script and copy the printed values into shared/letagents-process-tree.seal.json.");
  process.exit(1);
}

if (process.platform !== "win32") {
  console.error("letagents-process-tree.exe builds only on Windows.");
  process.exit(check && !strict ? 0 : 1);
}

const programFiles = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
const vswhere = join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
if (!existsSync(vswhere)) throw new Error(`Visual Studio's vswhere.exe was not found at ${vswhere}.`);
const found = spawnSync(vswhere, [
  "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
  "-property", "installationPath",
], { encoding: "utf8" });
const installation = found.stdout?.trim().split(/\r?\n/)[0];
if (found.status !== 0 || !installation) throw new Error("No Visual Studio with the C++ x64 tools was found.");
const vcvarsall = join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat");

const output = join(here, "build", arch);
const objects = join(output, "obj");
rmSync(output, { recursive: true, force: true });
mkdirSync(objects, { recursive: true });
const executable = join(output, "letagents-process-tree.exe");

const compile = [
  "cl.exe", "/nologo", "/O2", "/W4", "/WX", "/sdl", "/MT", "/GS", "/guard:cf", "/Brepro",
  "/DUNICODE", "/D_UNICODE", `"${source}"`, `/Fo"${join(objects, "letagents-process-tree.obj")}"`, `/Fe"${executable}"`,
  "/link", "/Brepro", "/DYNAMICBASE", "/NXCOMPAT", "/guard:cf", "/SUBSYSTEM:CONSOLE",
  ...(arch === "x64" ? ["/CETCOMPAT"] : []), "kernel32.lib",
].join(" ");
const line = [
  `"${vcvarsall}" ${arch === "x64" ? "x64" : "x64_arm64"} >nul`,
  // `set NAME` prints the value at run time; %NAME% would expand before vcvarsall ran.
  "set VCToolsVersion",
  "set WindowsSDKVersion",
  compile,
].join(" && ");
const comSpec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
const built = spawnSync(comSpec, ["/d", "/s", "/c", `"${line}"`], {
  encoding: "utf8", windowsVerbatimArguments: true, cwd: output,
});
process.stdout.write(built.stdout ?? "");
process.stderr.write(built.stderr ?? "");
if (built.status !== 0 || !existsSync(executable)) {
  console.error(`The build failed (exit ${built.status}).`);
  process.exit(1);
}
rmSync(objects, { recursive: true, force: true });

const vcToolsVersion = /^VCToolsVersion=(\S+)/m.exec(built.stdout)?.[1] ?? "unknown";
const windowsSdkVersion = (/^WindowsSDKVersion=(\S+)/m.exec(built.stdout)?.[1] ?? "unknown").replace(/\\$/, "");
const sha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
const result = { arch, file: executable, sha256, vcToolsVersion, windowsSdkVersion, sourceSha256: actualSource };
console.log(JSON.stringify(result, null, 2));

if (check) {
  const verdict = checkProcessTreeSeal(seal, result);
  if (verdict.level === "error" || (strict && verdict.level !== "ok")) {
    console.error(verdict.message);
    process.exit(1);
  }
  if (verdict.level === "warning") console.log(`::warning title=letagents-process-tree seal::${verdict.message}`);
  else console.log(verdict.message);
}
