// The daemon's process birth reading with the platform injected: records in
// the POSIX `ps lstart` format written before Windows support stay readable,
// and the Windows format is evidence only on Windows.
import assert from "node:assert/strict";
import test from "node:test";

import { createSystemProcessIdentity, processBirthState, sameProcessBirthIdentity } from "../process-identity.js";

const LSTART = "Tue Oct 29 01:02:03 2026";

test("journals written before this change stay readable: an lstart record is judged as before on POSIX", () => {
  const darwin = {
    ...createSystemProcessIdentity("darwin"),
    probe: () => {},
    readBirthIdentity: () => `${LSTART}\n`,
  };
  assert.equal(processBirthState(10, LSTART, darwin), "live");
  // A record from daemon < 2.0.12 also carried argv after the start time.
  assert.equal(processBirthState(10, `${LSTART} /usr/local/bin/codex app-server`, darwin), "live");
  assert.equal(processBirthState(10, "Wed Oct 30 01:02:03 2026", darwin), "gone");
  // A Windows-format record is never evidence on POSIX.
  assert.equal(processBirthState(10, "win32-ft:5", darwin), "unknown");
});

test("Windows: the daemon's recovery reads births through the helper and refuses lstart records", () => {
  const births: Record<number, string | null | undefined> = { 20: "win32-ft:5", 21: "win32-ft:6", 22: undefined };
  const windows = { ...createSystemProcessIdentity("win32", (pid) => births[pid]), probe: () => {} };
  assert.equal(processBirthState(20, "win32-ft:5", windows), "live");
  assert.equal(processBirthState(21, "win32-ft:5", windows), "gone");
  assert.equal(processBirthState(22, "win32-ft:5", windows), "unknown");
  assert.equal(processBirthState(20, LSTART, windows), "unknown");
  const gone = { ...windows, probe: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } };
  assert.equal(processBirthState(20, "win32-ft:5", gone), "gone");
});

test("Windows births compare exactly; lstart births by their start time", () => {
  assert.equal(sameProcessBirthIdentity("win32-ft:5", " win32-ft:5 "), true);
  assert.equal(sameProcessBirthIdentity("win32-ft:5", "win32-ft:50"), false);
  assert.equal(sameProcessBirthIdentity(LSTART, `${LSTART} /usr/local/bin/codex`), true);
});
