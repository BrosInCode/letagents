import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { launchPackagedApp, PACKAGED_READY_MARKER } from "./packaged-launch.mjs";

/** A stand-in app: Node runs the given program text. */
function standIn(program) {
  return { executable: process.execPath, args: ["-e", program], env: process.env };
}

test("a ready line before the deadline passes", async () => {
  const output = await launchPackagedApp({ ...standIn(`console.log("${PACKAGED_READY_MARKER} {}"); setInterval(() => {}, 1000);`), timeoutMs: 20_000 });
  assert.match(output, new RegExp(PACKAGED_READY_MARKER));
});

test("an exit before the ready line fails with the exit code", async () => {
  await assert.rejects(launchPackagedApp({ ...standIn(`console.log("starting"); process.exit(3);`), timeoutMs: 20_000 }), /packaged Electron exited 3: starting/);
});

test("a ready line that comes after the deadline does not pass", async () => {
  const folder = await mkdtemp(join(tmpdir(), "letagents-packaged-launch-"));
  try {
    const go = join(folder, "go");
    const printed = join(folder, "printed");
    // The stand-in prints the ready line when the file "go" appears, and then writes "printed".
    // So the test decides when the line comes, and knows when it is out, with no signal and no fixed wait.
    const program = `
      const fs = require("node:fs");
      console.log("waiting");
      const poll = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(go)})) return;
        clearInterval(poll);
        process.stdout.write("${PACKAGED_READY_MARKER} {}\\n", () => fs.writeFileSync(${JSON.stringify(printed)}, ""));
        setInterval(() => {}, 1000);
      }, 20);`;
    const launch = launchPackagedApp({
      ...standIn(program),
      timeoutMs: 1_500,
      collectEvidence: async () => {
        await writeFile(go, "");
        while (!existsSync(printed)) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        // One more turn of the event loop, so that the line reaches this process before the evidence step ends.
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        return "evidence text";
      },
    });
    await assert.rejects(launch, (error) => {
      assert.match(error.message, /timed out after 1500 ms: waiting/);
      assert.match(error.message, /evidence text/);
      assert.doesNotMatch(error.message, new RegExp(PACKAGED_READY_MARKER), "the report holds the output at the deadline");
      return true;
    });
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("an exit while the evidence is collected stays a timeout", async () => {
  const launch = launchPackagedApp({
    ...standIn(`process.on("SIGTERM", () => process.exit(7)); console.log("waiting"); setInterval(() => {}, 1000);`),
    timeoutMs: 1_500,
    collectEvidence: async (pid) => {
      const gone = new Promise((resolveGone) => {
        const poll = setInterval(() => {
          try { process.kill(pid, 0); } catch { clearInterval(poll); resolveGone(); }
        }, 25);
      });
      process.kill(pid, "SIGTERM");
      await gone;
      return "evidence after the exit";
    },
  });
  await assert.rejects(launch, (error) => {
    assert.match(error.message, /timed out after 1500 ms: waiting/);
    assert.match(error.message, /evidence after the exit/);
    assert.doesNotMatch(error.message, /exited/);
    return true;
  });
});

test("a fault of the evidence step still reports the timeout", async () => {
  await assert.rejects(
    launchPackagedApp({ ...standIn(`setInterval(() => {}, 1000);`), timeoutMs: 500, collectEvidence: () => { throw new Error("sample failed"); } }),
    /timed out after 500 ms: \nno evidence \(sample failed\)/,
  );
});
