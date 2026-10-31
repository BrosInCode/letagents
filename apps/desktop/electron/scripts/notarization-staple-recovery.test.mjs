import assert from "node:assert/strict";
import test from "node:test";
import { notarizeWithStapleRecovery, validateStapledTicket } from "./notarization-staple-recovery.mjs";

const options = { appPath: "/tmp/Let Agents.dmg", appleApiKey: "/private/key.p8" };
const networkError = () => new Error('Failed to staple your application with code: 68\nNSURLErrorDomain Code=-1005 "The network connection was lost."');
const commandNetworkError = () => Object.assign(new Error("stapler failed"), {
  code: 68,
  stdout: 'NSURLErrorDomain Code=-1005 "The network connection was lost."',
});

function harness(notaryError, commandErrors = []) {
  const calls = { notarize: [], exec: [], waits: [], warnings: [] };
  return {
    calls,
    deps: {
      notarize: async args => { calls.notarize.push(args); if (notaryError) throw notaryError; },
      execFile: async (...args) => {
        calls.exec.push(args);
        const error = commandErrors.shift();
        if (error) throw error;
      },
      wait: async ms => { calls.waits.push(ms); },
      warn: message => { calls.warnings.push(message); },
    },
  };
}

test("successful notarization does not run extra commands", async () => {
  const { calls, deps } = harness();
  await notarizeWithStapleRecovery(options, deps);
  assert.deepEqual(calls, { notarize: [options], exec: [], waits: [], warnings: [] });
});

test("lost ticket connection retries stapling without resubmitting or exposing credentials", async () => {
  const { calls, deps } = harness(networkError(), [commandNetworkError()]);
  await notarizeWithStapleRecovery(options, deps);
  assert.equal(calls.notarize.length, 1);
  assert.deepEqual(calls.waits, [5000, 15000]);
  assert.equal(calls.exec.length, 2);
  assert.deepEqual(calls.exec[0], ["xcrun", ["stapler", "staple", "-v", options.appPath], {
    timeout: 120000, maxBuffer: 1048576,
  }]);
  assert.ok(calls.warnings.every(message => !message.includes(options.appleApiKey)));
});

test("repeated network failures exhaust a bounded retry budget", async () => {
  const finalError = commandNetworkError();
  const { calls, deps } = harness(networkError(), [commandNetworkError(), commandNetworkError(), finalError]);
  await assert.rejects(notarizeWithStapleRecovery(options, deps), error => error === finalError);
  assert.equal(calls.notarize.length, 1);
  assert.equal(calls.exec.length, 3);
  assert.deepEqual(calls.waits, [5000, 15000, 30000]);
});

for (const message of [
  "Notarization rejected: invalid signature",
  "Authorization failed: NSURLErrorDomain Code=-1005",
  "Failed to staple your application with code: 68\nNo ticket found",
  "Failed to staple your application with code: 65\nNSURLErrorDomain Code=-1005",
]) {
  test(`does not recover unrelated errors: ${message.split("\n")[0]}`, async () => {
    const failure = new Error(message);
    const { calls, deps } = harness(failure);
    await assert.rejects(notarizeWithStapleRecovery(options, deps), error => error === failure);
    assert.equal(calls.exec.length, 0);
    assert.equal(calls.waits.length, 0);
  });
}

for (const failure of [
  Object.assign(new Error("invalid ticket"), { code: 65, stdout: "NSURLErrorDomain Code=-1005" }),
  Object.assign(new Error("missing ticket"), { code: 68, stdout: "No ticket found" }),
  Object.assign(new Error("timeout"), { code: null, killed: true }),
]) {
  test(`fails closed during recovery: ${failure.message}`, async () => {
    const { calls, deps } = harness(networkError(), [failure]);
    await assert.rejects(notarizeWithStapleRecovery(options, deps), error => error === failure);
    assert.equal(calls.exec.length, 1);
  });
}

test("ticket validation succeeds without retrying or notarizing", async () => {
  const { calls, deps } = harness();
  await validateStapledTicket(options.appPath, deps);
  assert.equal(calls.notarize.length, 0);
  assert.equal(calls.exec.length, 1);
  assert.deepEqual(calls.exec[0], ["xcrun", ["stapler", "validate", options.appPath], {
    timeout: 120000, maxBuffer: 1048576,
  }]);
  assert.deepEqual(calls.waits, []);
});

test("ticket validation retries network loss and timeout, then requires successful validation", async () => {
  const timeout = Object.assign(new Error("network timeout"), { code: 68, stderr: "NSURLErrorDomain Code=-1001" });
  const { calls, deps } = harness(undefined, [commandNetworkError(), timeout]);
  await validateStapledTicket(options.appPath, deps);
  assert.equal(calls.notarize.length, 0);
  assert.equal(calls.exec.length, 3);
  assert.ok(calls.exec.every(([, args]) => args[1] === "validate"));
  assert.deepEqual(calls.waits, [5000, 15000]);
});

test("ticket validation fails when all network retries fail", async () => {
  const finalError = commandNetworkError();
  const { calls, deps } = harness(undefined, [commandNetworkError(), commandNetworkError(), commandNetworkError(), finalError]);
  await assert.rejects(validateStapledTicket(options.appPath, deps), error => error === finalError);
  assert.equal(calls.exec.length, 4);
  assert.deepEqual(calls.waits, [5000, 15000, 30000]);
});

test("a missing or invalid ticket is never treated as a network failure", async () => {
  const failure = Object.assign(new Error("invalid ticket"), { code: 68, stdout: "The ticket is not valid." });
  const { calls, deps } = harness(undefined, [failure]);
  await assert.rejects(validateStapledTicket(options.appPath, deps), error => error === failure);
  assert.equal(calls.exec.length, 1);
  assert.deepEqual(calls.waits, []);
});

test("validation stops immediately if a network retry reveals an invalid ticket", async () => {
  const failure = Object.assign(new Error("invalid ticket"), { code: 65 });
  const { calls, deps } = harness(undefined, [commandNetworkError(), failure]);
  await assert.rejects(validateStapledTicket(options.appPath, deps), error => error === failure);
  assert.equal(calls.exec.length, 2);
});
