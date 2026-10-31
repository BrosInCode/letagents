import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recordDesktopExit } from "../main/supervisor-daemon/lifecycle-log.js";

test("an exit is on disk when the call returns, and a full or missing log changes nothing", () => {
  const folder = mkdtempSync(join(tmpdir(), "letagents-exit-record-"));
  try {
    const log = join(folder, "daemon-lifecycle.jsonl");
    recordDesktopExit(log, "desktop_quit");
    assert.throws(() => statSync(log), "no log yet: the daemon's folder does not exist or it has not started");
    writeFileSync(log, "");
    recordDesktopExit(log, "desktop_child_gone", "GPU: crashed");
    const line = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(line.event, "desktop_child_gone");
    assert.equal(line.detail, "GPU: crashed");
    assert.equal(line.pid, process.pid);
    truncateSync(log, 256 * 1024);
    recordDesktopExit(log, "desktop_quit");
    assert.equal(statSync(log).size, 256 * 1024);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
