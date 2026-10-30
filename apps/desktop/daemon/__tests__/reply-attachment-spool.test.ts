import "../../electron/__tests__/isolated-home.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, readFile, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MESSAGE_ATTACHMENT_LIMITS, validRecordedReplyAttachments } from "../../../../shared/message-attachments.mjs";
import { ReplyAttachmentSpool } from "../reply-attachment-spool.js";
import { removeTestDirectory } from "../../electron/__tests__/harness.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "letagents-reply-spool-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "shots"), { recursive: true });
  await writeFile(join(workspace, "shots", "result.png"), "png bytes");
  await writeFile(join(workspace, "notes.md"), "# notes");
  const spool = new ReplyAttachmentSpool(join(root, "spool"));
  const input = (files: string[], mcpRequestId = "request-1") => ({
    workspacePath: workspace, inboxItemId: "inbox-1", agentId: "agent-1", providerTurnId: "turn-1", mcpRequestId, files,
  });
  return { root, workspace, spool, input, cleanup: () => removeTestDirectory(root) };
}

test("the spool copies workspace files at call time and journals only their identity", async () => {
  const env = await setup();
  try {
    const recorded = await env.spool.snapshot(env.input(["shots/result.png", join(env.workspace, "notes.md")]));
    assert.equal(validRecordedReplyAttachments(recorded), true);
    assert.deepEqual(recorded.files.map(({ name, mime_type, size_bytes }) => ({ name, mime_type, size_bytes })), [
      { name: "result.png", mime_type: "image/png", size_bytes: 9 },
      { name: "notes.md", mime_type: "text/markdown", size_bytes: 7 },
    ]);
    assert.equal(JSON.stringify(recorded).includes(env.workspace), false, "no workspace path is journaled");

    // A later edit is not sent: the reply carries the bytes from call time.
    await writeFile(join(env.workspace, "shots", "result.png"), "edited later");
    assert.equal((await env.spool.read("inbox-1", recorded.files[0]!)).toString(), "png bytes");
    // A replayed request id names the same copies, so the journal sees the same record.
    assert.deepEqual(await env.spool.snapshot(env.input(["shots/result.png", join(env.workspace, "notes.md")])), recorded);

    await env.spool.remove("inbox-1");
    await assert.rejects(env.spool.read("inbox-1", recorded.files[0]!), /no longer available/);
  } finally { await env.cleanup(); }
});

test("the spool refuses files outside the workspace, through symlinks or hard links, and files that may hold credentials", async () => {
  const env = await setup();
  try {
    const outside = join(env.root, "outside-secret.txt");
    await writeFile(outside, "owner secret");
    await symlink(outside, join(env.workspace, "innocent.png"));
    await symlink(env.root, join(env.workspace, "parent"));
    // Stricter than a containment check: a link that stays inside the workspace is refused too.
    await symlink(join(env.workspace, "shots"), join(env.workspace, "latest"));
    await link(outside, join(env.workspace, "hard.txt"));
    await mkdir(join(env.workspace, ".git"));
    await writeFile(join(env.workspace, ".git", "config"), "[remote] url = https://token@example.test");
    for (const name of [".env", ".env.local", ".envrc", "id_ed25519", "deploy.pem", "auth.json", "credentials.yml.enc", ".npmrc", ".mcp.json", "prod.tfvars", "my-service-account.json", ".letagents-supervisor-context.json"]) {
      await writeFile(join(env.workspace, name), "secret");
    }
    for (const folder of [".cursor", ".vscode", ".Git"]) {
      await mkdir(join(env.workspace, folder), { recursive: true });
      await writeFile(join(env.workspace, folder, "settings.json"), "{\"token\":\"secret\"}");
    }
    // A named pipe in a folder is POSIX only: Windows keeps its pipes under \\.\pipe\, never in a workspace
    // (Git Bash's mkfifo makes a file only its own programs see). The "shots" folder row covers "not a regular file" there.
    const fifo = process.platform !== "win32";
    if (fifo) execFileSync("mkfifo", [join(env.workspace, "shots", "pipe.png")]);
    await writeFile(join(env.workspace, "empty.txt"), "");
    const refusals: Array<[string, RegExp]> = [
      [outside, /outside your workspace/],
      ["../outside-secret.txt", /outside your workspace/],
      ["innocent.png", /outside your workspace/],
      ["parent/outside-secret.txt", /outside your workspace/],
      ["latest/result.png", /reached through a link/],
      ["hard.txt", /hard link/],
      [".git/config", /credentials/],
      [".env", /credentials/], [".env.local", /credentials/], [".envrc", /credentials/], ["id_ed25519", /credentials/],
      ["deploy.pem", /credentials/], ["auth.json", /credentials/], ["credentials.yml.enc", /credentials/], [".npmrc", /credentials/],
      [".mcp.json", /credentials/], ["prod.tfvars", /credentials/], ["my-service-account.json", /credentials/],
      [".letagents-supervisor-context.json", /credentials/],
      [".cursor/settings.json", /credentials/], [".vscode/settings.json", /credentials/], [".Git/settings.json", /credentials/],
      ...(fifo ? [["shots/pipe.png", /not a regular file/] as [string, RegExp]] : []),
      ["shots", /not a regular file/],
      ["empty.txt", /empty/],
      ["missing.png", /does not exist/],
    ];
    for (const [file, pattern] of refusals) {
      await assert.rejects(env.spool.snapshot(env.input([file], `request-${file}`)), pattern, file);
    }
    await assert.rejects(env.spool.snapshot({ ...env.input(["notes.md"]), workspacePath: null }), /workspace folder/);
  } finally { await env.cleanup(); }
});

test("the spool keeps the shared size limits and detects a changed copy", async () => {
  const env = await setup();
  try {
    await writeFile(join(env.workspace, "big.bin"), Buffer.alloc(MESSAGE_ATTACHMENT_LIMITS.maxFileBytes + 1));
    await assert.rejects(env.spool.snapshot(env.input(["big.bin"])), /larger than 25 MB/);
    const recorded = await env.spool.snapshot(env.input(["notes.md"], "request-ok"));
    const [copy] = await readdir(join(env.root, "spool", (await readdir(join(env.root, "spool")))[0]!));
    await writeFile(join(env.root, "spool", (await readdir(join(env.root, "spool")))[0]!, copy!), "# tampered");
    await assert.rejects(env.spool.read("inbox-1", recorded.files[0]!), /changed after it was attached/);
  } finally { await env.cleanup(); }
});

test("a sweep removes only copies older than the limit", async () => {
  const env = await setup();
  try {
    await env.spool.snapshot(env.input(["notes.md"]));
    await env.spool.snapshot({ ...env.input(["notes.md"]), inboxItemId: "inbox-2" });
    const folders = await readdir(join(env.root, "spool"));
    assert.equal(folders.length, 2);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(join(env.root, "spool", folders[0]!), old, old);
    await env.spool.sweep(7 * 24 * 60 * 60 * 1000);
    assert.deepEqual(await readdir(join(env.root, "spool")), [folders[1]]);
  } finally { await env.cleanup(); }
});

test("a refused call keeps nothing it copied, and a new choice keeps only its own copies", async () => {
  const env = await setup();
  try {
    await writeFile(join(env.workspace, "auth.png"), "screenshot of the sign-in page");
    await writeFile(join(env.workspace, ".env"), "TOKEN=secret");
    await assert.rejects(env.spool.snapshot(env.input(["auth.png", ".env"], "partial")), /credentials/);
    const folder = join(env.root, "spool", (await readdir(join(env.root, "spool")))[0]!);
    assert.deepEqual(await readdir(folder), [], "the first file's copy was removed with the refusal");

    const first = await env.spool.snapshot(env.input(["auth.png", "notes.md"], "first"));
    const second = await env.spool.snapshot(env.input(["notes.md"], "second"));
    assert.equal((await readdir(folder)).length, 3);
    await env.spool.keepOnly("inbox-1", second.files.map((file) => file.spool_id));
    assert.deepEqual(await readdir(folder), [second.files[0]!.spool_id]);
    await assert.rejects(env.spool.read("inbox-1", first.files[0]!), /no longer available/);
  } finally { await env.cleanup(); }
});

test("an existing spool copy is trusted only as a regular file the daemon wrote", async () => {
  const env = await setup();
  try {
    const recorded = await env.spool.snapshot(env.input(["notes.md"], "planted"));
    const folder = join(env.root, "spool", (await readdir(join(env.root, "spool")))[0]!);
    const copy = join(folder, recorded.files[0]!.spool_id);
    const outside = join(env.root, "outside-secret.txt");
    await writeFile(outside, "owner secret");
    await unlink(copy);
    await symlink(outside, copy);
    await assert.rejects(env.spool.read("inbox-1", recorded.files[0]!), /no longer available/);
    // A replay does not follow the planted link either: it replaces it with a fresh copy of the workspace file.
    assert.deepEqual(await env.spool.snapshot(env.input(["notes.md"], "planted")), recorded);
    assert.equal((await env.spool.read("inbox-1", recorded.files[0]!)).toString(), "# notes");
    assert.equal((await readFile(outside, "utf8")), "owner secret");
  } finally { await env.cleanup(); }
});
