import assert from "node:assert/strict";
import test from "node:test";

import { ProviderProcessCustody, safeStreamPayload, type ProviderProcessExit } from "../main/agents/provider-evidence.js";

test("provider evidence recursively redacts credential-shaped keys and embedded tool output", () => {
  const canary = "canary-not-a-real-credential-123456789";
  const workerBearer = `lasb_${"A".repeat(43)}`;
  const hostGrant = `lashg_${"b".repeat(43)}`;
  const safe = safeStreamPayload({
    nested: [{ LETAGENTS_TOKEN: canary }, { api_key: canary }, { clientSecret: canary, dbPassword: canary, privateKey: canary, setCookie: canary }],
    json: JSON.stringify({ LETAGENTS_TOKEN: canary }),
    env: `LETAGENTS_TOKEN=${canary}`,
    header: `Authorization: Bearer ${canary}`,
    basic: `Authorization: Basic ${canary}`,
    arbitraryAuthorization: `Authorization: ${canary}`,
    stringifiedHeaders: JSON.stringify({ bearer: `Authorization: Bearer ${canary}`, basic: `Authorization: Basic ${canary}`, arbitrary: `Authorization: ${canary}` }),
    stringifiedCamelCase: JSON.stringify({ clientSecret: canary, dbPassword: canary, privateKey: canary, setCookie: canary }),
    standaloneOwnedTokens: `worker=${workerBearer} host=${hostGrant}`,
    stringifiedOwnedTokens: JSON.stringify({ message: `${workerBearer} ${hostGrant}` }),
  });
  assert.equal(safe.payloadRedacted, true);
  assert.equal(safe.payloadTruncated, false);
  assert.doesNotMatch(JSON.stringify(safe.payload), new RegExp(canary));
  assert.doesNotMatch(JSON.stringify(safe.payload), new RegExp(workerBearer));
  assert.doesNotMatch(JSON.stringify(safe.payload), new RegExp(hostGrant));
  assert.match(JSON.stringify(safe.payload), /REDACTED/);
});

test("provider evidence bounds wide, large, cyclic, and unreadable payloads before serialization", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const unreadable = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("must not escape"); } });
  const safe = safeStreamPayload({
    large: Array.from({ length: 10_000 }, (_value, index) => index),
    wide: Object.fromEntries(Array.from({ length: 10_000 }, (_value, index) => [`field_${index}`, index])),
    cyclic,
    unreadable,
  });
  const payload = safe.payload as { large: unknown[]; wide: Record<string, unknown>; cyclic: { self: string }; unreadable: { secret: string } };
  assert.equal(safe.payloadTruncated, true);
  assert.equal(payload.large.length, 100);
  assert.equal(Object.keys(payload.wide).length, 100);
  assert.equal(payload.cyclic.self, "[CIRCULAR]");
  assert.equal(payload.unreadable.secret, "[UNREADABLE]");
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 32 * 1024);
});

test("provider evidence leaves innocuous bounded payloads unchanged", () => {
  const payload = { status: "working", tool: "Bash", content: ["tests passed"] };
  const safe = safeStreamPayload(payload);
  assert.deepEqual(safe.payload, payload);
  assert.equal(safe.payloadRedacted, false);
  assert.equal(safe.payloadTruncated, false);
});


test("native custody retains failed births and releases only positive physical retirement", async () => {
  const identities = new Map<number, string | null | undefined>([[1, "birth-a"], [2, "birth-b"]]);
  const custody = new ProviderProcessCustody({ getProcessIdentity: pid => identities.get(pid) });
  let rejectPreparation!: (error: Error) => void;
  let exitOld!: (exit: ProviderProcessExit) => void;
  const oldChild = { pid: 1, exited: new Promise<ProviderProcessExit>(resolve => { exitOld = resolve; }) };
  assert.equal(custody.state("attempt"), "absent");
  const preparation = custody.acquire("attempt", async () => {
    assert.equal(custody.state("attempt"), "unknown", "reservation precedes native acquisition");
    custody.record("attempt", oldChild)();
    await new Promise<void>((_resolve, reject) => { rejectPreparation = reject; });
  });
  assert.equal(custody.state("attempt", oldChild), "unknown");
  rejectPreparation(new Error("cleanup could not confirm termination"));
  await assert.rejects(preparation, /cleanup/);
  assert.equal(custody.state("attempt"), "unknown", "a rejected acquisition has no returned channel");
  exitOld({ type: "error", error: new Error("transport failed before physical exit") });
  await Promise.resolve();
  assert.equal(custody.state("attempt", oldChild), "unknown", "error is not native death");
  const newChild = { pid: 2, exited: new Promise<ProviderProcessExit>(() => {}) };
  custody.record("attempt", newChild)();
  assert.equal(custody.state("attempt", newChild), "unknown", "a later child cannot hide the earlier birth");
  identities.set(1, undefined);
  assert.equal(custody.state("attempt", newChild), "unknown");
  identities.set(1, "replacement-birth");
  assert.equal(custody.state("attempt", newChild), "owned", "exact old birth retirement restores liveness");
  identities.set(2, null);
  assert.equal(custody.state("attempt", newChild), "absent");
});

test("native custody records uninspectable births and accepts actual exit without a PID", async () => {
  let exit!: (exit: ProviderProcessExit) => void;
  const child = { pid: null, exited: new Promise<ProviderProcessExit>(resolve => { exit = resolve; }) };
  const custody = new ProviderProcessCustody({ getProcessIdentity() { throw new Error("unavailable"); } });
  custody.record("no-pid", child);
  const unreadable = { pid: 9, exited: new Promise<ProviderProcessExit>(() => {}) };
  assert.equal(custody.record("unreadable", unreadable)(), undefined);
  assert.equal(custody.state("unreadable", unreadable), "unknown");
  assert.equal(custody.state("no-pid"), "unknown");
  const failed = { pid: null, exited: Promise.resolve<ProviderProcessExit>({ type: "error", error: new Error("unattested error") }) };
  custody.record("unattested-error", failed);
  await Promise.resolve();
  assert.equal(custody.state("unattested-error"), "unknown", "null PID plus an arbitrary error is not absence");
  exit({ type: "exit", code: 1, signal: null });
  await Promise.resolve();
  assert.equal(custody.state("no-pid"), "absent");
});
