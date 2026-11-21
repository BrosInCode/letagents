import assert from "node:assert/strict";
import test from "node:test";

import { launchPackagedApp, PACKAGED_READY_MARKER } from "./packaged-launch.mjs";

/** A stand-in app: Node runs the given program text. */
function standIn(program) {
  return { executable: process.execPath, args: ["-e", program], env: process.env };
}

/** Evidence that ends only when the test lets it, so the test controls what happens during it. */
function heldEvidence() {
  let release;
  let started;
  const begun = new Promise((resolveBegun) => { started = resolveBegun; });
  const held = new Promise((resolveHeld) => { release = resolveHeld; });
  return { begun, release: () => release(), collect: async () => { started(); await held; return "evidence text"; } };
}

test("a ready line before the deadline passes", async () => {
  const output = await launchPackagedApp({ ...standIn(`console.log("${PACKAGED_READY_MARKER} {}"); setInterval(() => {}, 1000);`), timeoutMs: 20_000 });
  assert.match(output, new RegExp(PACKAGED_READY_MARKER));
});

test("an exit before the ready line fails with the exit code", async () => {
  await assert.rejects(launchPackagedApp({ ...standIn(`console.log("starting"); process.exit(3);`), timeoutMs: 20_000 }), /packaged Electron exited 3: starting/);
});

test("a ready line that comes after the deadline does not pass", async () => {
  const evidence = heldEvidence();
  // The stand-in prints the ready line when it gets a signal, so the test decides when the line comes.
  const launch = launchPackagedApp({
    ...standIn(`process.on("SIGUSR2", () => console.log("${PACKAGED_READY_MARKER} {}")); console.log("waiting"); setInterval(() => {}, 1000);`),
    timeoutMs: 1_500,
    collectEvidence: async (pid) => {
      process.kill(pid, "SIGUSR2");
      // Give the late ready line time to arrive while the evidence step is still open.
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      return evidence.collect();
    },
  });
  const settled = assert.rejects(launch, (error) => {
    assert.match(error.message, /timed out after 1500 ms: waiting/);
    assert.match(error.message, /evidence text/);
    assert.doesNotMatch(error.message, new RegExp(PACKAGED_READY_MARKER), "the report holds the output at the deadline");
    return true;
  });
  await evidence.begun;
  evidence.release();
  await settled;
}, { skip: process.platform === "win32" ? "the stand-in needs a POSIX signal" : false });

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
