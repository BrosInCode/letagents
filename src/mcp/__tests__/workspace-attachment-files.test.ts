import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MESSAGE_ATTACHMENT_LIMITS } from "../../../shared/message-attachments.mjs";
import { readWorkspaceAttachmentFile, workspaceAliases } from "../../../shared/workspace-attachment-files.mjs";

// The npm MCP server and the desktop daemon read attached files with this one
// reader. The MCP server also runs on Windows, so every check here runs there
// too, with a junction where POSIX uses a folder symlink.
const windows = process.platform === "win32";

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "letagents-attach-read-")));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "shots"), { recursive: true });
  await writeFile(join(workspace, "shots", "result.png"), "png bytes");
  await writeFile(join(workspace, "notes.md"), "# notes");
  const outside = join(root, "outside-secret.txt");
  await writeFile(outside, "owner secret");
  return { root, workspace, outside, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A file symlink needs an administrator or developer mode on Windows; a test that cannot make one says so. */
async function trySymlink(target: string, path: string, type?: "dir" | "junction"): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch (error) {
    if (windows && (error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}

test("the reader returns the exact bytes, name and type of a file inside the workspace", async () => {
  const env = await setup();
  try {
    const relative = await readWorkspaceAttachmentFile({ workspace: env.workspace }, join("shots", "result.png"));
    assert.deepEqual({ ...relative, bytes: relative.bytes.toString() }, { name: "result.png", mimeType: "image/png", bytes: "png bytes" });
    const absolute = await readWorkspaceAttachmentFile({ workspace: env.workspace }, join(env.workspace, "notes.md"));
    assert.equal(absolute.name, "notes.md");
    assert.equal(absolute.mimeType, "text/markdown");
    assert.equal(absolute.bytes.toString(), "# notes");
    // A relative name resolves against the given folder, and is still held to the workspace.
    const fromSubfolder = await readWorkspaceAttachmentFile({ workspace: env.workspace, baseDirectory: join(env.workspace, "shots") }, "result.png");
    assert.equal(fromSubfolder.bytes.toString(), "png bytes");
    await assert.rejects(readWorkspaceAttachmentFile({ workspace: env.workspace, baseDirectory: join(env.workspace, "shots") },
      join("..", "..", "outside-secret.txt")), /outside your workspace/);
  } finally { await env.cleanup(); }
});

test("the reader refuses files outside the workspace, links out of it, and hard links", async () => {
  const env = await setup();
  try {
    const refusals: Array<[string, RegExp]> = [
      [env.outside, /outside your workspace/],
      [join("..", "outside-secret.txt"), /outside your workspace/],
      [env.workspace, /outside your workspace/],
      ["missing.png", /does not exist/],
    ];
    // A folder link out of the workspace: a junction on Windows needs no extra rights.
    await symlink(env.root, join(env.workspace, "parent"), windows ? "junction" : "dir");
    refusals.push([join("parent", "outside-secret.txt"), /outside your workspace/]);
    if (await trySymlink(env.outside, join(env.workspace, "innocent.png"))) {
      refusals.push(["innocent.png", /outside your workspace/]);
    }
    await link(env.outside, join(env.workspace, "hard.txt"));
    refusals.push(["hard.txt", /hard link/]);
    for (const [file, pattern] of refusals) {
      await assert.rejects(readWorkspaceAttachmentFile({ workspace: env.workspace }, file), pattern, file);
    }
  } finally { await env.cleanup(); }
});

test("the reader refuses a link inside the workspace, and reads through another name of the workspace", async () => {
  const env = await setup();
  try {
    await symlink(join(env.workspace, "shots"), join(env.workspace, "latest"), windows ? "junction" : "dir");
    await assert.rejects(readWorkspaceAttachmentFile({ workspace: env.workspace }, join("latest", "result.png")), /reached through a link/);
    // The agent may know the workspace by a name that passes through a link (macOS /tmp is /private/tmp).
    const alias = join(env.root, "alias");
    await symlink(env.workspace, alias, windows ? "junction" : "dir");
    await assert.rejects(readWorkspaceAttachmentFile({ workspace: env.workspace }, join(alias, "notes.md")), /outside your workspace/);
    assert.deepEqual(await workspaceAliases(env.workspace, join(env.workspace, "shots"), [join(alias, "shots"), join(env.root, "missing"), undefined]), [alias]);
    const throughAlias = await readWorkspaceAttachmentFile({ workspace: env.workspace, aliases: [alias] }, join(alias, "notes.md"));
    assert.equal(throughAlias.bytes.toString(), "# notes");
    // A link below the alias is still a link.
    await assert.rejects(readWorkspaceAttachmentFile({ workspace: env.workspace, aliases: [alias] }, join(alias, "latest", "result.png")), /reached through a link/);
  } finally { await env.cleanup(); }
});

test("the reader refuses files that may hold credentials, in any letter case", async () => {
  const env = await setup();
  try {
    const names = [".env", ".ENV.local", ".envrc", "id_ed25519", "deploy.pem", "auth.json", "credentials.yml.enc", ".npmrc",
      ".mcp.json", "prod.tfvars", "my-service-account.json", ".letagents-supervisor-context.json", ".credentials.json",
      "mcp-state.json", "client_secret_123.json", "token.json", "login.keychain-db"];
    for (const name of names) await writeFile(join(env.workspace, name), "secret");
    const folders = windows ? [".git", ".cursor", ".claude", ".ssh"] : [".git", ".cursor", ".claude", ".ssh", ".Git"];
    for (const folder of folders) {
      await mkdir(join(env.workspace, folder), { recursive: true });
      await writeFile(join(env.workspace, folder, "config"), "token=secret");
    }
    for (const file of [...names, ...folders.map((folder) => join(folder, "config"))]) {
      await assert.rejects(readWorkspaceAttachmentFile({ workspace: env.workspace }, file), /may hold credentials/, file);
    }
  } finally { await env.cleanup(); }
});

test("the reader refuses folders, empty files, files over the limit and named pipes", async () => {
  const env = await setup();
  try {
    await writeFile(join(env.workspace, "empty.txt"), "");
    await writeFile(join(env.workspace, "big.bin"), Buffer.alloc(MESSAGE_ATTACHMENT_LIMITS.maxFileBytes + 1));
    const refusals: Array<[string, RegExp]> = [
      ["shots", /not a regular file/],
      ["empty.txt", /empty/],
      ["big.bin", /larger than 25 MB/],
    ];
    if (!windows) {
      execFileSync("mkfifo", [join(env.workspace, "shots", "pipe.png")]);
      refusals.push([join("shots", "pipe.png"), /not a regular file/]);
    }
    for (const [file, pattern] of refusals) {
      await assert.rejects(readWorkspaceAttachmentFile({ workspace: env.workspace }, file), pattern, file);
    }
  } finally { await env.cleanup(); }
});

test("on Windows the reader refuses other drives, network paths and alternate data streams", { skip: windows ? false : "Windows path forms" }, async () => {
  const env = await setup();
  try {
    // Refused before the file system is asked, so no connection to the host is made.
    await assert.rejects(readWorkspaceAttachmentFile({ workspace: env.workspace }, "\\\\letagents-test.invalid\\share\\file.png"), /outside your workspace/);
    await assert.rejects(readWorkspaceAttachmentFile({ workspace: env.workspace }, "//letagents-test.invalid/share/file.png"), /outside your workspace/);
    const otherDrive = env.workspace.slice(0, 1).toUpperCase() === "Z" ? "Y:\\file.png" : "Z:\\file.png";
    await assert.rejects(readWorkspaceAttachmentFile({ workspace: env.workspace }, otherDrive), /outside your workspace/);
    await writeFile(join(env.workspace, "auth.json"), "secret");
    await writeFile(join(env.workspace, "notes.md:hidden"), "stream");
    // An alternate data stream reads another name's bytes; Windows drops a trailing dot or space; device names open devices.
    for (const file of ["auth.json::$DATA", "notes.md:hidden", "notes.md.", "notes.md ", "CON", "nul.txt", "nul .txt", join("shots", "COM1.png"), "LPT1"]) {
      await assert.rejects(readWorkspaceAttachmentFile({ workspace: env.workspace }, file), /not a plain file name/, file);
    }
  } finally { await env.cleanup(); }
});
