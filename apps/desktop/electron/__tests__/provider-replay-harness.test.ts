import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import {
  REPLAY_EMAIL,
  REPLAY_HOME_DIRECTORY,
  REPLAY_REDACTED,
  ReplayRedactor,
  findReplayLeaks,
  type ReplayRedactionContext,
} from "./provider-replay/redaction.js";
import { ProviderReplaySession, type ProviderReplaySessionOptions } from "./provider-replay/replay-session.js";
import {
  ProviderReplayTranscriptError,
  countProviderReplayEntries,
  parseProviderReplayTranscript,
  serializeProviderReplayTranscript,
  type JsonObject,
  type ProviderReplayEntry,
  type TranscriptStartEntry,
} from "./provider-replay/transcript.js";

const START: TranscriptStartEntry = {
  type: "transcript_start",
  format: 1,
  provider: "example",
  protocol: "example/lines",
  providerVersion: "1.2.3",
  scenario: "unit",
  capture: { recorder: "unit test" },
};
const EXIT: ProviderReplayEntry = {
  type: "runtime_exit", requested: false, transportClosedBeforeExit: false, code: 0, signal: null,
};

function lines(...entries: unknown[]): string {
  return entries.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n") + "\n";
}

test("a transcript loads in file order and keeps each entry's line", () => {
  const entries: ProviderReplayEntry[] = [
    { type: "expect_outbound", label: "hello", frame: { id: 1, method: "hello" } },
    { type: "emit_inbound", label: "hello", frame: { id: 1, result: {} } },
    EXIT,
  ];
  const text = serializeProviderReplayTranscript(START, entries);
  const transcript = parseProviderReplayTranscript(text, "unit.ndjson");
  assert.deepEqual(transcript.start, START);
  assert.deepEqual(transcript.entries.map((entry) => [entry.type, entry.line]),
    [["expect_outbound", 2], ["emit_inbound", 3], ["runtime_exit", 4]]);
  assert.deepEqual(countProviderReplayEntries(transcript),
    { transcript_start: 1, expect_outbound: 1, emit_inbound: 1, runtime_exit: 1 });
});

test("a transcript that is not exactly the format fails loudly, with its line", () => {
  const frame = { type: "emit_inbound", frame: { method: "ping" } };
  const cases: Array<[string, string, RegExp]> = [
    ["an unknown entry type", lines(START, { type: "emit_sideways", frame: {} }, EXIT), /unit\.ndjson:2: unknown entry type "emit_sideways"/],
    ["a line that is not JSON", lines(START, "{\"type\":\"emit_inbound\",", EXIT), /unit\.ndjson:2: not JSON/],
    ["an empty line", lines(START, "", EXIT), /unit\.ndjson:2: empty line/],
    ["an entry that is not an object", lines(START, "[1,2]", EXIT), /unit\.ndjson:2: an entry must be a JSON object/],
    ["an unknown key", lines(START, { ...frame, afterMs: 5 }, EXIT), /unit\.ndjson:2: unknown key "afterMs"/],
    ["a frame that is not an object", lines(START, { type: "expect_outbound", frame: "ping" }, EXIT), /unit\.ndjson:2: expect_outbound needs a frame object/],
    ["no header", lines(frame, EXIT), /unit\.ndjson:1: the first line must be transcript_start/],
    ["a second header", lines(START, START, EXIT), /unit\.ndjson:2: transcript_start must be the first line/],
    ["another format", lines({ ...START, format: 2 }, EXIT), /unit\.ndjson:1: unsupported format 2/],
    ["a header with no provider version", lines({ ...START, providerVersion: "" }, EXIT), /unit\.ndjson:1: transcript_start needs a providerVersion/],
    ["no runtime_exit", lines(START, frame), /unit\.ndjson:2: the transcript must end with runtime_exit/],
    ["an entry after runtime_exit", lines(START, EXIT, frame), /unit\.ndjson:3: an entry follows runtime_exit on line 2/],
    ["a runtime_exit with no close order", lines(START, { type: "runtime_exit", requested: true, code: 0, signal: null }), /unit\.ndjson:2: runtime_exit needs a boolean transportClosedBeforeExit/],
    ["an empty file", "", /unit\.ndjson:1: the transcript is empty/],
  ];
  for (const [name, text, expected] of cases) {
    assert.throws(() => parseProviderReplayTranscript(text, "unit.ndjson"), (error: unknown) => {
      assert.ok(error instanceof ProviderReplayTranscriptError, name);
      assert.match(error.message, expected, name);
      return true;
    });
  }
});

function replay(entries: ProviderReplayEntry[], options: ProviderReplaySessionOptions = {}) {
  const transcript = parseProviderReplayTranscript(serializeProviderReplayTranscript(START, entries), "unit.ndjson");
  const delivered: JsonObject[] = [];
  const exits: number[] = [];
  const session = new ProviderReplaySession(transcript, {
    deliverInbound: (frame) => { delivered.push(frame); },
    exitRuntime: () => { exits.push(delivered.length); },
  }, options);
  return { session, delivered, exits };
}

test("a replay delivers the provider's frames in order and holds each one behind the frame the adapter owes", async () => {
  const { session, delivered, exits } = replay([
    { type: "emit_inbound", frame: { method: "greeting" } },
    { type: "expect_outbound", frame: { id: 1, method: "ask" } },
    { type: "emit_inbound", frame: { id: 1, result: { answer: 1 } } },
    { type: "emit_inbound", frame: { method: "after" } },
    { ...EXIT, requested: true } as ProviderReplayEntry,
  ]);
  const seenBeforeAsk: JsonObject[] = [];
  await session.run(async () => {
    session.open();
    await new Promise<void>((resolve) => session.onInboundDelivered((entry) => { if (entry.frame.method === "greeting") resolve(); }));
    // Give the session every chance to run ahead: it must not pass the frame it is owed.
    for (let turn = 0; turn < 5; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    seenBeforeAsk.push(...delivered);
    session.send({ id: 1, method: "ask" });
    await session.untilExitIsNext();
    assert.deepEqual(exits, [], "the runtime stays up until the adapter stops it");
    session.requestExit();
  });
  assert.deepEqual(seenBeforeAsk, [{ method: "greeting" }]);
  assert.deepEqual(delivered, [{ method: "greeting" }, { id: 1, result: { answer: 1 } }, { method: "after" }]);
  assert.deepEqual(exits, [3]);
  assert.deepEqual(session.outbound, [{ id: 1, method: "ask" }]);
});

test("a frame the adapter sends early waits for its place in the recording", async () => {
  const { session, delivered } = replay([
    { type: "emit_inbound", frame: { method: "one" } },
    { type: "emit_inbound", frame: { method: "two" } },
    { type: "expect_outbound", frame: { method: "reaction" } },
    EXIT,
  ]);
  await session.run(async () => {
    session.onInboundDelivered((entry) => { if (entry.frame.method === "one") session.send({ method: "reaction" }); });
    session.open();
  });
  assert.deepEqual(delivered.map((frame) => frame.method), ["one", "two"]);
});

test("an outbound frame that differs from the recording fails with both frames", async () => {
  const { session } = replay([
    { type: "expect_outbound", label: "turn/start", frame: { id: 1, method: "turn/start", params: { threadId: "t-1" } } },
    EXIT,
  ]);
  await assert.rejects(session.run(async () => {
    session.open();
    session.send({ id: 1, method: "turn/start", params: { threadId: "t-2" } });
    // An adapter may swallow its own send error. The run still fails.
    await session.untilExitIsNext().catch(() => undefined);
  }), (error: Error) => {
    // A terminal that asks for colour gets colour codes in the diff. They are not part of the text.
    const message = stripVTControlCharacters(error.message);
    assert.match(message, /Outbound frame 1 does not match the recording \(unit\.ndjson, expect_outbound "turn\/start" \(line 2\)\)/);
    assert.match(message, /\+\s+threadId: 't-2'/);
    assert.match(message, /-\s+threadId: 't-1'/);
    const { actual, expected } = error.cause as { actual: JsonObject; expected: JsonObject };
    assert.deepEqual([actual.params, expected.params], [{ threadId: "t-2" }, { threadId: "t-1" }]);
    return true;
  });
});

test("a listener sees the adapter's reaction one event-loop turn after a frame, before the next frame is played", async () => {
  const entries: ProviderReplayEntry[] = [
    { type: "emit_inbound", frame: { id: 1, result: {} } },
    { type: "emit_inbound", frame: { method: "later" } },
    { type: "expect_outbound", frame: { method: "at-once" } },
    { type: "expect_outbound", frame: { method: "next-request" } },
    EXIT,
  ];
  const transcript = parseProviderReplayTranscript(serializeProviderReplayTranscript(START, entries), "unit.ndjson");
  const delivered: string[] = [];
  const reactions: string[] = [];
  const session: ProviderReplaySession = new ProviderReplaySession(transcript, {
    // Like an adapter: one frame goes out in the same call, and one after the awaited reply.
    deliverInbound: (frame) => {
      delivered.push(String(frame.method ?? "reply"));
      if (frame.method !== undefined) return;
      void Promise.resolve().then(() => { reactions.push("continued"); session.send({ method: "next-request" }); });
      session.send({ method: "at-once" });
    },
    exitRuntime: () => {},
  });
  const seen: Array<{ when: string; delivered: string[]; reactions: string[] }> = [];
  const look = (when: string) => seen.push({ when, delivered: [...delivered], reactions: [...reactions] });
  session.onInboundDelivered((entry) => {
    if (entry.frame.method !== undefined) return;
    look("at delivery");
    setImmediate(() => look("one turn later"));
  });
  await session.run(async () => { session.open(); });
  assert.deepEqual(delivered, ["reply", "later"]);
  // The frame sent inside the delivery must not let the session play "later" before the listener's look.
  assert.deepEqual(seen, [
    { when: "at delivery", delivered: ["reply"], reactions: [] },
    { when: "one turn later", delivered: ["reply"], reactions: ["continued"] },
  ]);
});

test("a frame sent after the replay ended is reported: it throws to its sender and is kept", async () => {
  const { session } = replay([{ type: "expect_outbound", frame: { method: "hello" } }, EXIT]);
  await session.run(async () => {
    session.open();
    session.send({ method: "hello" });
  });
  assert.deepEqual(session.lateFrames, []);
  assert.throws(() => session.send({ method: "thread/read" }), /The adapter sent "thread\/read" after the replay ended/);
  assert.deepEqual(session.lateFrames, [{ method: "thread/read" }]);

  // While `run` still waits for the body, the same frame fails the run.
  const early = replay([EXIT]);
  await assert.rejects(early.session.run(async () => {
    early.session.open();
    await early.session.finished;
    try { early.session.send({ method: "too-late" }); } catch { /* An adapter may swallow it. */ }
  }), /The adapter sent "too-late" after the replay ended/);
});

test("a frame the recording does not hold, and a frame that never comes, both fail the replay", async () => {
  const extra = replay([{ type: "emit_inbound", frame: { method: "done" } }, EXIT]);
  await assert.rejects(extra.session.run(async () => {
    extra.session.onInboundDelivered(() => extra.session.send({ method: "surprise" }));
    extra.session.open();
  }), /The adapter sent "surprise", which the recording does not hold: the next recorded entry is runtime_exit \(line 3\)/);

  // The guard time only bounds how long a broken replay takes to say so.
  const missing = replay([{ type: "expect_outbound", label: "turn/interrupt", frame: { method: "turn/interrupt" } }, EXIT],
    { stallTimeoutMs: 20 });
  await assert.rejects(missing.session.run(async () => { missing.session.open(); }),
    /stalled: the recording expects the adapter to send expect_outbound "turn\/interrupt" \(line 2\)/);

  const neverStopped = replay([{ ...EXIT, requested: true } as ProviderReplayEntry], { stallTimeoutMs: 20 });
  await assert.rejects(neverStopped.session.run(async () => { neverStopped.session.open(); }),
    /stalled: the recording expects the adapter to stop the runtime/);
});

// Sample secrets are built from parts, so no scanner takes this file for a leak.
const sampleApiKey = ["sk", "live0123456789abcdefABCDEF"].join("-");
const sampleGitHubToken = ["ghp", "0123456789abcdefghijABCDEFGHIJ012345"].join("_");
const sampleJwt = [Buffer.from('{"alg":"none"}').toString("base64url"), Buffer.from('{"sub":"1"}').toString("base64url"), "c2ln"].join(".");
const sampleHome = ["", "Users", "ada"].join("/");

const CONTEXT: ReplayRedactionContext = {
  workspacePaths: ["/private/var/folders/xy/T/work-1", "/var/folders/xy/T/work-1"],
  tempDirectories: ["/private/var/folders/xy/T", "/var/folders/xy/T"],
  repositoryPaths: [`${sampleHome}/code/letagents`],
  homeDirectory: sampleHome,
  username: "ada",
  personalNames: ["Ada Lovelace", "Lovelace"],
  hostnames: ["Adas-Laptop.local", "Adas-Laptop"],
  secrets: ["room-credential-0123456789"],
  ownerSetupNames: ["blender"],
  accountMethods: [/^account\//],
};

test("redaction replaces what identifies the machine and its owner, and keeps ids correlated", () => {
  const redactor = new ReplayRedactor(CONTEXT);
  const thread = "0199c0de-0000-7000-8000-00000000aaaa";
  const turn = "0199c0de-0000-7000-8000-00000000bbbb";
  const frame = redactor.redactFrame({
    method: "thread/started",
    params: {
      threadId: thread,
      turnId: turn,
      cwd: "/private/var/folders/xy/T/work-1/src",
      path: `${sampleHome}/.codex/sessions/rollout-${thread}.jsonl`,
      other: `${["", "Users", "grace"].join("/")}/notes.txt`,
      scratch: "/var/folders/xy/T/other",
      entry: `${sampleHome}/code/letagents/apps/desktop/stub.mjs`,
      serverName: "Adas-Laptop",
      author: "Ada Lovelace <ada.lovelace@example.org>, signed ADA",
      header: ["authorization:", "Bearer", "abcdefghijklmnop0123456789"].join(" "),
      note: `keys ${sampleApiKey} ${sampleGitHubToken} ${sampleJwt} and room-credential-0123456789`,
      accessToken: "anything at all",
      installationId: "inst-9000",
      itemId: "msg_0123456789abcdefghij0123",
      servers: [{ name: "blender" }, { name: "letagents" }],
      text: "a blender is a kitchen tool",
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  });
  assert.deepEqual(frame, {
    method: "thread/started",
    params: {
      threadId: "00000000-0000-4000-8000-000000000001",
      turnId: "00000000-0000-4000-8000-000000000002",
      cwd: "<workspace>/src",
      path: `${REPLAY_HOME_DIRECTORY}/.codex/sessions/rollout-00000000-0000-4000-8000-000000000001.jsonl`,
      other: `${REPLAY_HOME_DIRECTORY}/notes.txt`,
      scratch: "<tmp>/other",
      entry: "<repo>/apps/desktop/stub.mjs",
      serverName: "replay-host",
      author: `replay-user <${REPLAY_EMAIL}>, signed replay-user`,
      header: ["authorization:", "Bearer", REPLAY_REDACTED].join(" "),
      note: `keys ${REPLAY_REDACTED} ${REPLAY_REDACTED} ${REPLAY_REDACTED} and ${REPLAY_REDACTED}`,
      accessToken: REPLAY_REDACTED,
      installationId: "installation-id-1",
      itemId: "msg_replay0001",
      servers: [{ name: "owner-setup-name-1" }, { name: "letagents" }],
      text: "a blender is a kitchen tool",
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  });
  // The same real id gets the same fake id in a later frame, in either direction.
  assert.deepEqual(redactor.redactFrame({ id: 4, method: "turn/interrupt", params: { threadId: thread, turnId: turn } }),
    { id: 4, method: "turn/interrupt", params: { threadId: "00000000-0000-4000-8000-000000000001", turnId: "00000000-0000-4000-8000-000000000002" } });
  assert.equal(redactor.counts.uuid, 2);
});

test("redaction blanks an account notification and keeps its shape", () => {
  const redactor = new ReplayRedactor(CONTEXT);
  assert.deepEqual(redactor.redactFrame({
    method: "account/rateLimits/updated",
    params: { planType: "pro", primary: { usedPercent: 41, resetsAt: 1790000000 }, credits: { hasCredits: true, balance: "12.50" }, secondary: null },
    emittedAtMs: 1790000000123,
  }), {
    method: "account/rateLimits/updated",
    params: { planType: REPLAY_REDACTED, primary: { usedPercent: 0, resetsAt: 0 }, credits: { hasCredits: false, balance: REPLAY_REDACTED }, secondary: null },
    emittedAtMs: 1790000000123,
  });
});

test("the leak check finds what redaction should have removed, and passes what it wrote", () => {
  const redactor = new ReplayRedactor(CONTEXT);
  const leaky = { method: "note", params: { text: `${sampleHome}/x on Adas-Laptop, ada@example.org, ${sampleApiKey}`, names: ["blender"] } };
  const redacted = JSON.stringify(redactor.redactFrame(leaky));
  assert.deepEqual(findReplayLeaks(redacted, CONTEXT), []);
  assert.deepEqual(
    [...new Set(findReplayLeaks(JSON.stringify(leaky), CONTEXT).map((leak) => leak.rule))].sort(),
    ["email", "home-directory", "hostname", "owner-setup-name", "token", "username"],
  );
});

// More sample secrets, built from parts for the same reason.
const sampleAwsKeyId = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const sampleGoogleKey = ["AIza", "SyA1234567890abcdefghijklmnopqrstuv"].join("");
const sampleHexSecret = "0123456789abcdef".repeat(4);
const leakRules = (text: string, context: ReplayRedactionContext = CONTEXT) =>
  [...new Set(findReplayLeaks(text, context).map((leak) => leak.rule))].sort();

test("redaction reads a string that is JSON as data, so the keys inside it count", () => {
  const redactor = new ReplayRedactor(CONTEXT);
  const inside = { accessToken: "opaque-value", password: "hunter2", accountId: "acct-77", userId: 4411, note: "kept" };
  const frame = { id: 4, result: { contents: [{ uri: "x://y", text: JSON.stringify(inside) }] } };
  // Found as data: the keys of the JSON inside the string. A string that is JSON is not also read as free text.
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame })), ["credential-key", "identity-key"],
    "the leak check reads the inner JSON too");
  const redacted = redactor.redactFrame(frame);
  assert.deepEqual(JSON.parse(((redacted.result as JsonObject).contents as JsonObject[])[0]!.text as string),
    { accessToken: REPLAY_REDACTED, password: REPLAY_REDACTED, accountId: "account-id-1", userId: "user-id-1", note: "kept" });
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame: redacted })), []);

  // A JSON string with nothing to redact is not rewritten, whatever its spacing.
  const spaced = '{\n  "format": 1,\n  "tools": [ "send_message" ]\n}';
  assert.deepEqual(redactor.redactFrame({ result: { text: spaced } }), { result: { text: spaced } });
});

test("a string that is JSON is not cut by the rule for a credential written into text", () => {
  // That rule reads a value with no quotes to the next space. Compact JSON has no space after `null`,
  // so the rule read on through the JSON and replaced what it read.
  const page = JSON.stringify({ next_page_token: null, items: [{ title: "read me" }, { title: "second" }] });
  const readiness = JSON.stringify({ format: 1, profile: "supervised_room_turn", token: null, tools: ["claim_task", "get_board"], note: "ready to work" });
  for (const text of [page, readiness]) {
    const frame = { id: 4, result: { contents: [{ uri: "x://y", text }] } };
    assert.deepEqual(new ReplayRedactor(CONTEXT).redactFrame(frame), frame, text);
    assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame })), [], text);
  }

  // A credential in such a string is still found and blanked, as data, and the rest of the JSON stays.
  const withCursor = JSON.stringify({ next_page_token: "opaque cursor", items: [{ title: "read me" }] });
  const frame = { id: 5, result: { text: withCursor } };
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame })), ["credential-key"]);
  const redacted = new ReplayRedactor(CONTEXT).redactFrame(frame);
  assert.deepEqual(JSON.parse((redacted.result as JsonObject).text as string),
    { next_page_token: REPLAY_REDACTED, items: [{ title: "read me" }] });
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame: redacted })), []);

  // Text that only holds JSON is free text: the rule reads the quoted value there, to its closing quote.
  const inText = { id: 6, result: { text: `the page was ${withCursor}` } };
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame: inText })), ["credential-text"]);
  assert.deepEqual(new ReplayRedactor(CONTEXT).redactFrame(inText),
    { id: 6, result: { text: `the page was {"next_page_token":"${REPLAY_REDACTED}","items":[{"title":"read me"}]}` } });
});

test("a credential key written as one word is blanked, as a frame key and inside a string that is JSON; a counter is not", () => {
  // Each is two words that name a credential. Written with a separator or a capital they were always found.
  const names = ["authtoken", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "bearertoken", "accesskey", "privatekey", "clientsecret"];
  // Any letter case: as it is, all capitals, one capital, and capitals where no word starts.
  const cased = (name: string) => [name, name.toUpperCase(), name[0]!.toUpperCase() + name.slice(1),
    [...name].map((letter, index) => (index % 2 ? letter.toUpperCase() : letter)).join("")];
  const entry = (frame: JsonObject) => JSON.stringify({ type: "emit_inbound", frame });
  for (const key of names.flatMap(cased)) {
    const frame = { method: "note", params: { [key]: "opaque value", note: "kept" } };
    assert.deepEqual(leakRules(entry(frame)), ["credential-key"], `${key}: reported as a frame key`);
    const redacted = new ReplayRedactor(CONTEXT).redactFrame(frame);
    assert.deepEqual(redacted, { method: "note", params: { [key]: REPLAY_REDACTED, note: "kept" } }, key);
    assert.deepEqual(leakRules(entry(redacted)), [], key);

    // A tool result whose text is JSON. The text is read as data, so only the key can find the credential.
    const inside = { id: 4, result: { contents: [{ uri: "x://y", text: JSON.stringify({ [key]: "opaque value", items: [{ title: "read me" }] }) }] } };
    assert.deepEqual(leakRules(entry(inside)), ["credential-key"], `${key}: reported inside a string that is JSON`);
    const redactedInside = new ReplayRedactor(CONTEXT).redactFrame(inside);
    assert.deepEqual(JSON.parse(((redactedInside.result as JsonObject).contents as JsonObject[])[0]!.text as string),
      { [key]: REPLAY_REDACTED, items: [{ title: "read me" }] }, key);
    assert.deepEqual(leakRules(entry(redactedInside)), [], key);
  }

  // A passkey is a credential, under any key that holds the word, written as one word or as two.
  // A key that only has those letters in it is not one.
  const passkeys = { passkey: "opaque value", passKey: "opaque value", user_passkeys: ["opaque one"], PASSKEY: "opaque value",
    pass_key: "opaque value", "pass-key": "opaque value", userPassKey: "opaque value", PASS_KEYS: ["opaque one"] };
  assert.deepEqual(leakRules(entry({ method: "note", params: passkeys })), ["credential-key"]);
  assert.deepEqual(new ReplayRedactor(CONTEXT).redactFrame({ method: "note", params: passkeys }), {
    method: "note",
    params: { passkey: REPLAY_REDACTED, passKey: REPLAY_REDACTED, user_passkeys: [REPLAY_REDACTED], PASSKEY: REPLAY_REDACTED,
      pass_key: REPLAY_REDACTED, "pass-key": REPLAY_REDACTED, userPassKey: REPLAY_REDACTED, PASS_KEYS: [REPLAY_REDACTED] },
  });
  const passkeyInside = { id: 4, result: { contents: [{ uri: "x://y", text: JSON.stringify({ passkey: "opaque value", note: "kept" }) }] } };
  assert.deepEqual(leakRules(entry(passkeyInside)), ["credential-key"]);
  assert.deepEqual(JSON.parse(((new ReplayRedactor(CONTEXT).redactFrame(passkeyInside).result as JsonObject).contents as JsonObject[])[0]!.text as string),
    { passkey: REPLAY_REDACTED, note: "kept" });
  const notPasskeys = { method: "note", params: { compasskey: "kept", passkeyboard: "kept", bypasskeys: "kept",
    compass_key: "kept", bypassKey: "kept", pass_keyboard: "kept", passKeyboard: "kept" } };
  assert.deepEqual(new ReplayRedactor(CONTEXT).redactFrame(notPasskeys), notPasskeys);
  assert.deepEqual(leakRules(entry(notPasskeys)), []);

  // A counter is not a credential, however it is written, and a credential key with no value has nothing to blank.
  const counters = {
    tokenUsage: { inputTokens: 12, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1, totalTokens: 15 },
    maxTokens: 4096, tokenType: "example", token_count: 2, tokens: ["a", "b"],
    tokenusage: 1, inputtokens: 12, outputtokens: 3, reasoningoutputtokens: 1, totaltokens: 15, maxtokens: 4096, MAXTOKENS: 4096,
    accessKeyboard: "kept", idTokenizer: "kept", keyring: "kept",
    next_page_token: null, nextPageToken: null, authtoken: null, sessiontoken: "",
  };
  for (const frame of [
    { method: "note", params: counters },
    { id: 5, result: { contents: [{ uri: "x://y", text: JSON.stringify(counters) }] } },
  ] as JsonObject[]) {
    assert.deepEqual(new ReplayRedactor(CONTEXT).redactFrame(frame), frame);
    assert.deepEqual(leakRules(entry(frame)), []);
  }
});

test("redaction blanks everything under a credential key, whatever its type", () => {
  const redactor = new ReplayRedactor(CONTEXT);
  const frame = {
    method: "example/login",
    params: {
      credentials: { scheme: "custom", value: "opaque-value", expiresAt: 1790000000, refreshable: true },
      authorization: { headers: ["opaque-one", "opaque-two"] },
      sessionKey: 987654321,
      apiKey: null,
      nextPageToken: "opaque-cursor",
      tokenUsage: { inputTokens: 12, totalTokens: 15 },
      tokenType: "example",
    },
  };
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame })), ["credential-key"]);
  const redacted = redactor.redactFrame(frame);
  assert.deepEqual(redacted, {
    method: "example/login",
    params: {
      credentials: { scheme: REPLAY_REDACTED, value: REPLAY_REDACTED, expiresAt: 0, refreshable: false },
      authorization: { headers: [REPLAY_REDACTED, REPLAY_REDACTED] },
      sessionKey: 0,
      apiKey: null,
      nextPageToken: REPLAY_REDACTED,
      // Counters are not credentials.
      tokenUsage: { inputTokens: 12, totalTokens: 15 },
      tokenType: "example",
    },
  });
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame: redacted })), []);
});

test("redaction blanks an account reply by the method it answers, and an account request by its own", () => {
  const redactor = new ReplayRedactor(CONTEXT);
  const reply = { id: 7, result: { account: { planType: "pro", balance: "12.50" }, requiresAuth: true } };
  const failure = { id: 8, error: { code: -32000, message: "no account for someone" } };
  const request = { id: 7, method: "account/read", params: { refresh: true } };
  // A reply has no method. Without the method it answers, nothing says it is about the account.
  assert.deepEqual(redactor.redactFrame(reply), reply);
  assert.deepEqual(redactor.redactFrame(reply, "account/read"),
    { id: 7, result: { account: { planType: REPLAY_REDACTED, balance: REPLAY_REDACTED }, requiresAuth: false } });
  assert.deepEqual(redactor.redactFrame(failure, "account/read"), { id: 8, error: { code: 0, message: REPLAY_REDACTED } });
  assert.deepEqual(redactor.redactFrame(request), { id: 7, method: "account/read", params: { refresh: false } });
  assert.deepEqual(redactor.redactFrame({ id: 9, result: { thread: { preview: "kept" } } }, "thread/read"),
    { id: 9, result: { thread: { preview: "kept" } } });

  // The request has now been seen, so its reply is known by its id even without the label.
  assert.deepEqual(redactor.redactFrame(reply),
    { id: 7, result: { account: { planType: REPLAY_REDACTED, balance: REPLAY_REDACTED }, requiresAuth: false } });

  const entry = (frame: JsonObject) => JSON.stringify({ type: "emit_inbound", label: "account/read", frame });
  assert.deepEqual(leakRules(entry(reply)), ["account-frame"]);
  assert.deepEqual(leakRules(entry(redactor.redactFrame(reply, "account/read"))), []);
});

test("the leak check reports an id that redaction did not map", () => {
  const realThread = "0199c0de-0000-7000-8000-00000000aaaa";
  const frame = { method: "turn/started", params: { threadId: realThread, itemId: "msg_0123456789abcdefghij0123", installationId: "inst-9000" } };
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame })), ["identity-key", "provider-id", "uuid"]);
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame: new ReplayRedactor(CONTEXT).redactFrame(frame) })), []);
});

test("redaction knows more credential shapes: cloud keys, long hex, and credentials written into text", () => {
  const redactor = new ReplayRedactor(CONTEXT);
  const frame = {
    method: "item/completed",
    params: {
      aws: `key id ${sampleAwsKeyId} in use`,
      google: `maps key ${sampleGoogleKey}.`,
      digest: sampleHexSecret,
      again: `sha256:${sampleHexSecret.toUpperCase()}`,
      url: "https://api.example.test/v1/items?api_key=opaque-value&page=2&token=another-value#top",
      env: "LETAGENTS_TOKEN=opaque-value PASSWORD: hunter2 mode=fast",
      embedded: 'the body was {"client_secret": "opaque-value", "name": "kept"}',
      shortHex: "deadbeefdeadbeef",
    },
  };
  assert.deepEqual(leakRules(JSON.stringify(frame)), ["credential-text", "long-hex", "token"]);
  const redacted = redactor.redactFrame(frame);
  assert.deepEqual(redacted, {
    method: "item/completed",
    params: {
      aws: `key id ${REPLAY_REDACTED} in use`,
      google: `maps key ${REPLAY_REDACTED}.`,
      // One real value, one fake: the two places still show the same secret.
      digest: "<redacted-hex-1>",
      again: "sha256:<redacted-hex-1>",
      url: `https://api.example.test/v1/items?api_key=${REPLAY_REDACTED}&page=2&token=${REPLAY_REDACTED}#top`,
      env: `LETAGENTS_TOKEN=${REPLAY_REDACTED} PASSWORD: ${REPLAY_REDACTED} mode=fast`,
      embedded: `the body was {"client_secret": "${REPLAY_REDACTED}", "name": "kept"}`,
      shortHex: "deadbeefdeadbeef",
    },
  });
  assert.deepEqual(leakRules(JSON.stringify(redacted)), []);
});

/** The last part of a secret: the part a rule that stops early leaves in the text. */
const MARK = "LEFTOVER";

test("a credential written into text is redacted whole, and one that is partly redacted is reported", () => {
  const basic = Buffer.from("ada:open sesame").toString("base64");
  // `left` is what redaction once wrote for `text`: a placeholder, with the rest of the secret beside it.
  type Sample = { text: string; redacted: string; left?: string };
  const probes: Sample[] = [
    // A value with no quotes ends at a space, not at a comma.
    { text: `password=ab,${MARK}`, redacted: `password=${REPLAY_REDACTED}`, left: `password=${REPLAY_REDACTED},${MARK}` },
    // A quoted value ends at its closing quote, not at its first space.
    { text: `password: "correct horse ${MARK}"`, redacted: `password: "${REPLAY_REDACTED}"`, left: `password: "${REPLAY_REDACTED} horse ${MARK}"` },
    // An authorization value is redacted after any scheme, not only after `Bearer`.
    { text: `Authorization: ApiKey ${MARK}`, redacted: `Authorization: ApiKey ${REPLAY_REDACTED}`, left: `Authorization: ${REPLAY_REDACTED} ${MARK}` },
    { text: `Authorization: Basic ${basic}`, redacted: `Authorization: Basic ${REPLAY_REDACTED}` },
    // A value may start with `<`.
    { text: `api_key=<${MARK}>`, redacted: `api_key=${REPLAY_REDACTED}` },
  ];
  // `String.raw` keeps each backslash as it is written here.
  const others: Sample[] = [
    // A scheme that is not a known one is not kept: it can be the first word of a secret.
    { text: `Authorization: ab ${MARK}`, redacted: `Authorization: ${REPLAY_REDACTED}` },
    {
      text: String.raw`"authorization": "Digest realm=\"api\", response=\"${MARK}\""`,
      redacted: `"authorization": "Digest ${REPLAY_REDACTED}"`,
    },
    // A header ends with its line: its value holds spaces, commas and semicolons.
    { text: `Cookie: session=abc; theme=${MARK}\nAccept: text/html`, redacted: `Cookie: ${REPLAY_REDACTED}\nAccept: text/html` },
    // Quotes: an escaped quote inside, single quotes, and one that is never closed.
    { text: String.raw`password: "a \" ${MARK}" mode=fast`, redacted: `password: "${REPLAY_REDACTED}" mode=fast` },
    { text: `token='a b ${MARK}' next`, redacted: `token='${REPLAY_REDACTED}' next` },
    { text: `secret: "a b ${MARK}`, redacted: `secret: "${REPLAY_REDACTED}` },
    // A string inside a string: `\"` opens and closes the value, and `\\\"` is a quote inside it.
    {
      text: String.raw`sent {\"password\":\"a \\\" ${MARK}\",\"mode\":\"fast\"} ok`,
      redacted: String.raw`sent {\"password\":\"${REPLAY_REDACTED}\",\"mode\":\"fast\"} ok`,
    },
    // A URL query value ends at `&` or `#`, whatever the name before the credential word.
    { text: `https://x.example.test/cb?code=ab<${MARK}>&state=1#top`, redacted: `https://x.example.test/cb?code=${REPLAY_REDACTED}&state=1#top` },
    { text: `https://x.example.test/cb?my_token=ab,${MARK}&page=2`, redacted: `https://x.example.test/cb?my_token=${REPLAY_REDACTED}&page=2` },
  ];
  const entry = (text: string) => JSON.stringify({ type: "emit_inbound", frame: { method: "note", params: { text } } });
  for (const { text, redacted, left } of [...probes, ...others]) {
    assert.ok(text.includes(MARK) || text.includes(basic), text);
    assert.equal(new ReplayRedactor(CONTEXT).redactText(text), redacted, text);
    assert.equal(redacted.includes(MARK) || redacted.includes(basic), false, text);
    assert.deepEqual(leakRules(entry(text)), ["credential-text"], `${text}: reported before redaction`);
    assert.deepEqual(leakRules(entry(redacted)), [], `${text}: passed after redaction`);
    // What redaction wrote is not redacted again.
    assert.equal(new ReplayRedactor(CONTEXT).redactText(redacted), redacted, text);
    if (left === undefined) continue;
    // The check no longer passes text that only looks finished, and redaction finishes it.
    assert.deepEqual(leakRules(entry(left)), ["credential-text"], `${left}: a partly redacted value is reported`);
    const finished = new ReplayRedactor(CONTEXT).redactText(left);
    assert.equal(finished.includes(MARK), false, left);
    assert.deepEqual(leakRules(entry(finished)), [], left);
  }
});

test("the leak check accepts a numeric id that an account frame blanked to 0", () => {
  const frame = { method: "account/updated", params: { userId: 4411, planType: "pro" } };
  const redacted = new ReplayRedactor(CONTEXT).redactFrame(frame);
  assert.deepEqual(redacted, { method: "account/updated", params: { userId: 0, planType: REPLAY_REDACTED } });
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame: redacted })), []);
  // A numeric id that nothing blanked is still a real one.
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame: { method: "thread/started", params: { userId: 4411 } } })), ["identity-key"]);
});

test("the leak check sees a long hex run after `0x`, and a temp folder path", () => {
  const frame = { method: "note", params: { digest: `0x${sampleHexSecret}`, same: sampleHexSecret, scratch: "/var/folders/xy/T/other" } };
  assert.deepEqual(leakRules(JSON.stringify(frame)), ["long-hex", "temp-directory"]);
  assert.deepEqual(leakRules(JSON.stringify({ params: { digest: `0x${sampleHexSecret}` } })), ["long-hex"]);
  assert.deepEqual(leakRules(JSON.stringify({ params: { scratch: "/private/var/folders/xy/T" } })), ["temp-directory"]);
  const redacted = new ReplayRedactor(CONTEXT).redactFrame(frame);
  // The `0x` stays, and the digits get the fake that the same digits get without it.
  assert.deepEqual(redacted, { method: "note", params: { digest: "0x<redacted-hex-1>", same: "<redacted-hex-1>", scratch: "<tmp>/other" } });
  assert.deepEqual(leakRules(JSON.stringify(redacted)), []);
});

test("a long run with no `@` is read once, not once for each of its characters", () => {
  // Each character of a run once started a new email match that read to the end of the run:
  // 320 KB took most of a minute. Read once, it takes a few milliseconds, so the bound is loose.
  // The last one is not a run: it is as much text, made of credentials, for the rule that reads each to its end.
  const texts = ["a".repeat(320_000), "0123456789abcdef".repeat(20_000), `${"a-b.c_d%e+".repeat(32_000)} end`, "token=x ".repeat(40_000)];
  const startedAt = performance.now();
  for (const text of texts) {
    new ReplayRedactor(CONTEXT).redactText(text);
    findReplayLeaks(JSON.stringify({ type: "emit_inbound", frame: { params: { text } } }), CONTEXT);
  }
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 10_000, `four texts of 320 KB took ${Math.round(elapsedMs)} ms`);
  // The rule itself is unchanged: an address is found wherever it starts.
  assert.equal(new ReplayRedactor(CONTEXT).redactText("mail grace.hopper+notes@example.org, (x.y@example.org)"),
    `mail ${REPLAY_EMAIL}, (${REPLAY_EMAIL})`);
});

test("redaction replaces an owner's server name inside an MCP tool name", () => {
  const context = { ...CONTEXT, ownerSetupNames: ["blender", "chrome-devtools"] };
  const redactor = new ReplayRedactor(context);
  const frame = {
    method: "item/started",
    params: {
      tool: "mcp__blender__render_scene",
      // Codex writes other characters of a server name as `_` in a tool name.
      other: "ran mcp__chrome_devtools__click, then mcp__letagents__send_message",
      servers: { "chrome-devtools": { name: "chrome-devtools" } },
    },
  };
  assert.deepEqual(leakRules(JSON.stringify(frame), context), ["owner-setup-name"]);
  const redacted = redactor.redactFrame(frame);
  assert.deepEqual(redacted, {
    method: "item/started",
    params: {
      tool: "mcp__owner-setup-name-1__render_scene",
      other: "ran mcp__owner-setup-name-2__click, then mcp__letagents__send_message",
      servers: { "owner-setup-name-2": { name: "owner-setup-name-2" } },
    },
  });
  assert.deepEqual(leakRules(JSON.stringify(redacted), context), []);
});

test("a user name is replaced where it names the person, and never as a bare word", () => {
  // `user` is a user name, and also a value the Codex protocol uses.
  const context = { ...CONTEXT, username: "user", homeDirectory: ["", "home", "user"].join("/"), personalNames: ["User"] };
  const redactor = new ReplayRedactor(context);
  const frame = {
    method: "thread/started",
    params: {
      approvalsReviewer: "user",
      text: "Honor the user's existing authorization.",
      scratch: "/private/tmp/agent-501/-Users-user-Projects-app/run",
      mount: "/Volumes/user/shared and /srv/user",
      login: "user@buildbox",
      owner: "user",
      userAgent: "example/1.0 (user agent)",
    },
  };
  const redacted = redactor.redactFrame(frame);
  assert.deepEqual(redacted, {
    method: "thread/started",
    params: {
      approvalsReviewer: "user",
      text: "Honor the user's existing authorization.",
      scratch: "/private/tmp/agent-501/-Users-replay-user-Projects-app/run",
      mount: "/Volumes/replay-user/shared and /srv/replay-user",
      login: "replay-user@buildbox",
      owner: "replay-user",
      userAgent: "example/1.0 (user agent)",
    },
  });
  // What was left is not hidden: the check names each place, and the recorder then writes nothing.
  assert.deepEqual(
    findReplayLeaks(JSON.stringify({ type: "emit_inbound", frame: redacted }), context).map(({ rule, path }) => `${rule} at ${path}`),
    ["username at frame.params.approvalsReviewer", "username at frame.params.text", "username at frame.params.userAgent"],
  );

  // A two-letter user name gets the same care: replaced in a path, reported as a bare word.
  const short = { ...CONTEXT, username: "al", homeDirectory: ["", "Users", "al"].join("/"), personalNames: [] };
  const shortFrame = { method: "note", params: { cwd: `${short.homeDirectory}/code`, scratch: "/tmp/-Users-al-code", note: "ask al first", word: "always" } };
  const shortRedacted = new ReplayRedactor(short).redactFrame(shortFrame);
  assert.deepEqual(shortRedacted, {
    method: "note",
    params: { cwd: `${REPLAY_HOME_DIRECTORY}/code`, scratch: "/tmp/-Users-replay-user-code", note: "ask al first", word: "always" },
  });
  assert.deepEqual(findReplayLeaks(JSON.stringify(shortRedacted), short).map(({ rule, path }) => `${rule} at ${path}`),
    ["username at params.note"]);
});

test("two keys that redact to the same text stay two keys", () => {
  const redactor = new ReplayRedactor(CONTEXT);
  const redacted = redactor.redactFrame({
    result: {
      owners: { "ada@example.org": { role: "admin" }, "grace@example.org": { role: "member" }, "eve@example.org": { role: "guest" } },
    },
  });
  assert.deepEqual(redacted, {
    result: {
      owners: {
        [REPLAY_EMAIL]: { role: "admin" },
        [`${REPLAY_EMAIL} (2)`]: { role: "member" },
        [`${REPLAY_EMAIL} (3)`]: { role: "guest" },
      },
    },
  });
  assert.equal(redactor.counts["key-collision"], 2);
});

test("the leak check leaves the transcript header's own words alone", () => {
  // The recorder counts its rules by name in the header. Those names are not provider data.
  const header = { ...START, capture: { recorder: "unit test", redactions: { "credential-key": 3, token: 2, secret: 1 } } };
  assert.deepEqual(leakRules(JSON.stringify(header)), []);
  assert.deepEqual(leakRules(JSON.stringify({ type: "emit_inbound", frame: { params: { token: "opaque-value" } } })), ["credential-key"]);
});

test("the committed recordings hold no known leak shape and do not change under redaction", () => {
  // A machine-independent guard. It cannot know this machine's names; a person's read of a new recording does.
  const context: ReplayRedactionContext = {
    workspacePaths: [], tempDirectories: [], repositoryPaths: [], homeDirectory: "", username: "",
    personalNames: [], hostnames: [], secrets: [], ownerSetupNames: [], accountMethods: [/^account\//],
  };
  for (const name of ["simple", "turn_interrupt"]) {
    const text = readFileSync(fileURLToPath(new URL(`./provider-replay/fixtures/codex/${name}.ndjson`, import.meta.url)), "utf8");
    const transcript = parseProviderReplayTranscript(text, name);
    assert.deepEqual(findReplayLeaks(text, context), [], `${name} holds no known leak shape`);
    const redactor = new ReplayRedactor(context);
    const entries = transcript.entries.map(({ line: _line, ...entry }): ProviderReplayEntry =>
      entry.type === "runtime_exit" ? entry : { ...entry, frame: redactor.redactFrame(entry.frame, entry.label) });
    assert.equal(serializeProviderReplayTranscript(transcript.start, entries), text, `${name} is unchanged by redaction`);
  }
});

test("the Codex recorder records nothing when it is imported, and its cleanup stops the app-server and removes the workspace", async () => {
  // Importing would run a recording if the file did not check how it was started.
  const { discardRecording } = await import("../scripts/record-codex-replay.js");
  const stopped: number[] = [];
  const running = mkdtempSync(join(tmpdir(), "letagents-replay-cleanup-"));
  writeFileSync(join(running, "left-behind.txt"), "x");
  discardRecording({ pid: 4242, exited: false, workspace: running }, (pid) => { stopped.push(pid); });
  assert.deepEqual(stopped, [4242]);
  assert.equal(existsSync(running), false);

  // A process that already exited is not signalled: its pid may belong to another process by now.
  const ended = mkdtempSync(join(tmpdir(), "letagents-replay-cleanup-"));
  discardRecording({ pid: 4242, exited: true, workspace: ended }, (pid) => { stopped.push(pid); });
  discardRecording({ pid: null, exited: false, workspace: ended }, (pid) => { stopped.push(pid); });
  assert.deepEqual(stopped, [4242]);
  assert.equal(existsSync(ended), false);
});
