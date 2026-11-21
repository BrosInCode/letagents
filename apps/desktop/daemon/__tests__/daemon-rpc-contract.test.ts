import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { z } from "zod";
import {
  assertPlainWireValue,
  assertWireBoundarySchema,
  buildDaemonRpcContractDocument,
  daemonAgentConfigurationViewSchema,
  daemonAttemptDetailSchema,
  DAEMON_CONTROL_MAX_REQUEST_BYTES,
  DAEMON_IMPLEMENTATION_VERSION,
  DAEMON_LOCAL_BOARD_MAX_FRAME_BYTES,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RPC_METHOD_NAMES,
  DAEMON_RPC_METHODS,
  DAEMON_RPC_TIMEOUTS,
  DAEMON_STATE_ACTIVITY_SUMMARY_LIMIT,
  HANDOFF_DRAIN_METHODS,
  HANDOFF_LIFECYCLE_METHODS,
  isDaemonRpcMethod,
  isPlainWireValue,
  jsonRecordSchema,
  jsonValueSchema,
  looseJsonObject,
  maxRequestBytesForMethod,
  parseDaemonRpcParams,
  resolveDaemonRpcTimeoutMs,
  serializeDaemonRpcContractDocument,
  toWireJsonSchema,
  VERSION_AGNOSTIC_METHODS,
  WIRE_JSON_SCHEMA_DRAFT,
} from "#daemon-contract/index.js";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
  imports?: Record<string, unknown>;
};
const SOURCE_CONDITION = "letagents-source";
const tsxLoader = import.meta.resolve("tsx");

test("the desktop package declares the daemon contract import with a source condition", () => {
  const entry = desktopPackage.imports?.["#daemon-contract/*.js"] as Record<string, string> | undefined;
  assert.ok(entry, "apps/desktop/package.json must declare #daemon-contract/*.js");
  assert.deepEqual(Object.keys(entry), [SOURCE_CONDITION, "types", "default"]);
  assert.equal(entry[SOURCE_CONDITION], "./daemon-contract/*.ts");
  assert.equal(entry.default, "./dist-daemon-contract/*.js");
});

test("daemon-contract resolves to source under letagents-source and to build output when compiled", () => {
  assert.match(
    import.meta.resolve("#daemon-contract/index.js"),
    /\/daemon-contract\/index\.ts$/,
  );
  const root = mkdtempSync(join(tmpdir(), "letagents-daemon-contract-imports-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", imports: desktopPackage.imports }));
    mkdirSync(join(root, "daemon-contract"));
    mkdirSync(join(root, "dist-daemon-contract"));
    mkdirSync(join(root, "consumer"));
    writeFileSync(join(root, "daemon-contract", "probe.ts"), `export const origin: string = "source";\n`);
    writeFileSync(join(root, "dist-daemon-contract", "probe.js"), `export const origin = "compiled";\n`);
    writeFileSync(
      join(root, "consumer", "main.js"),
      `import { origin } from "#daemon-contract/probe.js";\nprocess.stdout.write(origin);\n`,
    );
    const run = (args: string[]) => execFileSync(process.execPath, [...args, join(root, "consumer", "main.js")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    assert.equal(run([`--conditions=${SOURCE_CONDITION}`, "--import", tsxLoader]), "source");
    rmSync(join(root, "daemon-contract"), { recursive: true, force: true });
    assert.equal(run([]), "compiled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("committed rpc-contract.schema.json matches the Zod contract byte-for-byte", () => {
  const schemaPath = join(desktopRoot, "daemon-contract", "rpc-contract.schema.json");
  const committed = readFileSync(schemaPath, "utf8");
  const generated = serializeDaemonRpcContractDocument();
  assert.equal(
    committed,
    generated,
    "rpc-contract.schema.json is out of date; run `npm --prefix apps/desktop run generate:daemon-rpc-contract`",
  );

  const doc = buildDaemonRpcContractDocument();
  assert.equal(doc.$schema, WIRE_JSON_SCHEMA_DRAFT);
  assert.equal(doc.contract.protocolVersion, DAEMON_PROTOCOL_VERSION);
  assert.equal(doc.contract.implementationVersion, DAEMON_IMPLEMENTATION_VERSION);
  assert.equal(doc.contract.stateActivitySummaryLimit, DAEMON_STATE_ACTIVITY_SUMMARY_LIMIT);
  assert.deepEqual(Object.keys(doc.methods).sort(), [...DAEMON_RPC_METHOD_NAMES]);
  assert.equal(DAEMON_RPC_METHOD_NAMES.length, 48);

  // Every internal $ref must resolve cleanly inside $defs so a non-TS consumer
  // (for example a Rust code generator) never encounters a dangling reference.
  const refs: string[] = [];
  const collectRefs = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collectRefs(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "$ref" && typeof value === "string") refs.push(value);
        else collectRefs(value);
      }
    }
  };
  collectRefs(doc);
  assert.ok(refs.length > 0, "expected shared wire types to use $defs/$ref");
  for (const ref of refs) {
    assert.match(ref, /^#\/\$defs\/[A-Za-z0-9_]+$/, `unexpected ref format: ${ref}`);
    const name = ref.slice("#/$defs/".length);
    assert.ok(Object.hasOwn(doc.$defs, name), `dangling $ref target: ${ref}`);
  }
});

test("cross-process wire boundary rule rejects root and nested non-JSON-Schema types, transforms, and refinements", () => {
  const unrepresentableSchemas: Array<[string, z.ZodType]> = [
    ["function", z.function()],
    ["date", z.date()],
    ["bigint", z.bigint()],
    ["symbol", z.symbol()],
    ["map", z.map(z.string(), z.string())],
    ["set", z.set(z.string())],
    ["custom", z.custom<object>(() => true)],
    ["unknown", z.unknown()],
    ["any", z.any()],
    ["undefined", z.undefined()],
    ["void", z.void()],
    ["nan", z.nan()],
    ["looseObject (unknown catchall)", z.looseObject({ id: z.string() })],
    ["default", z.string().default("x")],
    ["catch", z.string().catch("x")],
    ["transform", z.string().transform(() => new Date())],
    ["pipe", z.string().pipe(z.string())],
    ["preprocess", z.preprocess((value) => value, z.string())],
    ["refine", z.string().refine((value) => value === "allowed")],
    ["superRefine", z.object({ id: z.string() }).superRefine(() => {})],
    ["nested transform in object/array", z.object({ items: z.array(z.string().transform((s) => s.length)) })],
    ["nested refine in object", z.object({ id: z.string().refine((s) => s.startsWith("a")) })],
    ["nested superRefine in optional", z.object({ inner: z.object({ a: z.string() }).superRefine(() => {}).optional() })],
    ["nested date in optional/nullable", z.object({ at: z.date().nullable().optional() })],
    ["nested function in record", z.record(z.string(), z.function())],
    ["nested map in union", z.union([z.string(), z.map(z.string(), z.string())])],
    ["nested set in lazy", z.lazy(() => z.set(z.string()))],
    ["nested unknown in tuple", z.tuple([z.string(), z.unknown()])],
    ["nested custom in intersection", z.intersection(z.object({ a: z.string() }), z.object({ b: z.custom<object>(() => true) }))],
  ];
  for (const [label, schema] of unrepresentableSchemas) {
    assert.throws(
      () => assertWireBoundarySchema(schema),
      `assertWireBoundarySchema must reject ${label}`,
    );
    assert.throws(
      () => toWireJsonSchema(schema),
      `toWireJsonSchema must reject ${label}`,
    );
  }

  const ok = toWireJsonSchema(z.strictObject({
    id: z.string(),
    count: z.number().int().min(0),
    meta: jsonRecordSchema,
    payload: jsonValueSchema,
    extra: looseJsonObject({ name: z.string() }),
  }));
  assert.equal(ok.type, "object");
  assert.equal(ok.additionalProperties, false);
});

test("jsonValueSchema and jsonRecordSchema enforce plain JSON values recursively", () => {
  for (const valid of ["hello", 0, 42, -3.5, true, false, null, [], [1, "a", null, { nested: [true] }], { a: 1, b: [null, "ok"] }]) {
    assert.equal(jsonValueSchema.safeParse(valid).success, true, `expected jsonValueSchema to accept ${JSON.stringify(valid)}`);
  }
  assert.equal(jsonRecordSchema.safeParse({ a: 1, nested: { list: [true, null, "x"] } }).success, true);

  class CustomHolder {
    value = 1;
  }
  const abortSignal = new AbortController().signal;
  const invalidValues: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["function", () => {}],
    ["Date", new Date()],
    ["BigInt", 1n],
    ["Symbol", Symbol("wire")],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["NaN", NaN],
    ["Map", new Map([["a", 1]])],
    ["Set", new Set(["a"])],
    ["RegExp", /abc/],
    ["AbortSignal", abortSignal],
    ["class instance", new CustomHolder()],
    ["nested Date in array", [1, new Date()]],
    ["nested function in object", { nested: { callback: () => true } }],
    ["nested BigInt in object", { count: 2n }],
    ["nested Infinity in object", { metric: Infinity }],
    ["nested undefined in object", { missing: undefined }],
    ["nested AbortSignal in object", { signal: abortSignal }],
  ];
  for (const [label, value] of invalidValues) {
    assert.equal(jsonValueSchema.safeParse(value).success, false, `jsonValueSchema must reject ${label}`);
    assert.equal(jsonRecordSchema.safeParse({ wrapped: value }).success, false, `jsonRecordSchema must reject nested ${label}`);
    assert.equal(isPlainWireValue(value), false, `isPlainWireValue must reject ${label}`);
    assert.throws(() => assertPlainWireValue({ wrapped: value }), `assertPlainWireValue must reject nested ${label}`);
  }
  assert.equal(jsonRecordSchema.safeParse(new Date()).success, false);
  assert.equal(jsonRecordSchema.safeParse(() => {}).success, false);
  assert.equal(jsonRecordSchema.safeParse(new CustomHolder()).success, false);

  // Runtime wire-value guard also rejects cycles, symbol keys, and getters,
  // while permitting shared non-cyclic references and null-prototype objects.
  const shared = { id: "shared" };
  assert.deepEqual(assertPlainWireValue({ a: shared, b: shared }), { a: shared, b: shared });
  assert.equal(isPlainWireValue(Object.assign(Object.create(null), { ok: true })), true);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => assertPlainWireValue(cyclic), /circular reference/);
  assert.throws(() => assertPlainWireValue({ [Symbol("k")]: 1 }), /symbol keys/);
  const withGetter = {};
  Object.defineProperty(withGetter, "computed", { enumerable: true, get: () => "x" });
  assert.throws(() => assertPlainWireValue(withGetter), /accessor/);
  // Own "__proto__" properties are inspected by descriptor value, not prototype lookup.
  const ownProtoBad = JSON.parse('{"__proto__":{"nested":1}}') as Record<string, unknown>;
  Object.defineProperty(ownProtoBad, "__proto__", { enumerable: true, configurable: true, writable: true, value: { bad: new Date() } });
  assert.throws(() => assertPlainWireValue(ownProtoBad), /Date/);
  // parseDaemonRpcParams preserves own "__proto__" keys so downstream security checks see them,
  // while still rejecting non-JSON values hidden under "__proto__".
  const smuggledEntry = {
    id: "agent_1",
    provider_launch_policy: JSON.parse('{"approvalPolicy":"never","__proto__":{"letagentsOwnerIsolation":false}}'),
  };
  const parsedPut = parseDaemonRpcParams("manifest.put", { entry: smuggledEntry });
  assert.equal(Object.hasOwn(parsedPut.entry.provider_launch_policy as object, "__proto__"), true);
  assert.throws(
    () => parseDaemonRpcParams("manifest.put", { entry: { id: "agent_1", provider_launch_policy: ownProtoBad } }),
    /Date/,
  );
});

test("contract metadata drives framing limits, version gating, handoff sets, and timeouts", () => {
  assert.equal(isDaemonRpcMethod("daemon.negotiate"), true);
  assert.equal(isDaemonRpcMethod("daemon.nonexistent"), false);

  assert.deepEqual([...VERSION_AGNOSTIC_METHODS], ["daemon.negotiate"]);
  assert.deepEqual(
    [...HANDOFF_LIFECYCLE_METHODS].sort(),
    ["daemon.negotiate", "daemon.prepare_handoff", "daemon.status", "manifest.watch_state"],
  );
  assert.ok(HANDOFF_DRAIN_METHODS.has("supervisor.execute_bounded_tool"));
  assert.equal(HANDOFF_DRAIN_METHODS.has("manifest.put"), false);

  assert.equal(maxRequestBytesForMethod("local_board.mutate"), DAEMON_LOCAL_BOARD_MAX_FRAME_BYTES);
  assert.equal(maxRequestBytesForMethod("manifest.put"), DAEMON_CONTROL_MAX_REQUEST_BYTES);
  assert.equal(maxRequestBytesForMethod("unknown.method"), DAEMON_CONTROL_MAX_REQUEST_BYTES);

  assert.equal(resolveDaemonRpcTimeoutMs("daemon.status"), DAEMON_RPC_TIMEOUTS.defaultMs);
  assert.equal(resolveDaemonRpcTimeoutMs("daemon.status", undefined, { defaultTimeoutMs: 750 }), 750);
  assert.equal(resolveDaemonRpcTimeoutMs("manifest.list"), DAEMON_RPC_TIMEOUTS.richReadMs);
  assert.equal(resolveDaemonRpcTimeoutMs("manifest.control_turn"), DAEMON_RPC_TIMEOUTS.turnControlMs);
  assert.equal(resolveDaemonRpcTimeoutMs("manifest.control_turn", undefined, { turnControlTimeoutMs: 4200 }), 4200);
  assert.equal(resolveDaemonRpcTimeoutMs("supervisor.commit_room_move"), DAEMON_RPC_TIMEOUTS.roomMoveCommitMs);
  assert.equal(resolveDaemonRpcTimeoutMs("supervisor.recover_agent_runtime"), DAEMON_RPC_TIMEOUTS.recoveryMs);
  assert.equal(resolveDaemonRpcTimeoutMs("supervisor.bootstrap_room_ingress"), DAEMON_RPC_TIMEOUTS.bootstrapIngressMs);
  assert.equal(resolveDaemonRpcTimeoutMs("supervisor.install_host_grant"), DAEMON_RPC_TIMEOUTS.installHostGrantMs);
  assert.equal(resolveDaemonRpcTimeoutMs("supervisor.retire_agent"), DAEMON_RPC_TIMEOUTS.retireMs);
  assert.equal(resolveDaemonRpcTimeoutMs("daemon.prepare_handoff"), 0);
  assert.equal(resolveDaemonRpcTimeoutMs("supervisor.apply_agent_configuration"), 0);
  assert.equal(resolveDaemonRpcTimeoutMs("supervisor.execute_bounded_tool"), 0);
  assert.equal(
    resolveDaemonRpcTimeoutMs("manifest.watch_state", { wait_ms: 10_000 }, { defaultTimeoutMs: 2_500 }),
    12_500,
  );
  assert.equal(
    resolveDaemonRpcTimeoutMs("manifest.watch_state", { wait_ms: 999_999 }, { defaultTimeoutMs: 3_000 }),
    DAEMON_RPC_TIMEOUTS.longPollMaxWaitMs + 3_000,
  );
  assert.equal(
    resolveDaemonRpcTimeoutMs("supervisor.watch_agent_stream", {}),
    DAEMON_RPC_TIMEOUTS.longPollDefaultWaitMs + DAEMON_RPC_TIMEOUTS.defaultMs,
  );
  // Every declared method has a finite non-negative resolved timeout.
  for (const method of DAEMON_RPC_METHOD_NAMES) {
    const resolved = resolveDaemonRpcTimeoutMs(method);
    assert.ok(Number.isSafeInteger(resolved) && resolved >= 0, `${method}: ${resolved}`);
    assert.ok(DAEMON_RPC_METHODS[method].params, `${method} must declare params schema`);
    assert.ok(DAEMON_RPC_METHODS[method].result, `${method} must declare result schema`);
  }
});

test("parseDaemonRpcParams enforces exact validation rules and error messages", () => {
  assert.deepEqual(parseDaemonRpcParams("manifest.list", undefined), undefined);
  assert.deepEqual(parseDaemonRpcParams("manifest.list", { room_id: "room_1", activity: "summary" }), {
    room_id: "room_1",
    activity: "summary",
  });
  assert.throws(
    () => parseDaemonRpcParams("manifest.list", { activity: "brief" }),
    /manifest\.list activity must be "full" or "summary"\./,
  );
  assert.throws(
    () => parseDaemonRpcParams("manifest.list", { room_id: " leading" }),
    /manifest\.list room_id must be an exact non-empty room identifier\./,
  );
  assert.throws(
    () => parseDaemonRpcParams("manifest.get_entry", { entry_id: "" }),
    /manifest\.get_entry requires an exact non-empty entry_id\./,
  );
  assert.throws(
    () => parseDaemonRpcParams("supervisor.retire_agent", {
      entry_id: "agent_1",
      daemon_generation: 1,
      revoked_agent_session_id: "sess_1",
      grant_revoked_without_worker_session: true,
    }),
    /Retire requires exact typed coordinates\./,
  );
  assert.throws(
    () => parseDaemonRpcParams("supervisor.recover_agent_runtime", {
      entry_id: "agent_1",
      daemon_generation: 1,
      mode: "reconnect",
      operation_id: "op_1",
      room_id: "room_1",
      execution_generation_id: "gen_1",
      runtime_generation_id: "rt_1",
      retired_runtime_evidence: [],
    }),
    /Agent runtime recovery requires exact typed coordinates\./,
  );
  assert.throws(
    () => parseDaemonRpcParams("supervisor.install_open_model_credential", {
      entry_id: "agent_1",
      api_key: null,
      base_url: "http://127.0.0.1:8080",
      model: "qwen",
      context_window: 0,
      daemon_generation: 1,
    }),
    /The model context window must be a positive whole number\./,
  );
  assert.throws(
    () => parseDaemonRpcParams("supervisor.sync_execution_delegations", {
      room_id: "",
      daemon_generation: 1,
    }),
    /Execution delegation sync requires a room\./,
  );
  // Generic Zod validation errors include both the RPC method and the failing field path.
  assert.throws(
    () => parseDaemonRpcParams("manifest.control_turn", { room_id: "room_1" }),
    /manifest\.control_turn id:/,
  );
  assert.throws(
    () => parseDaemonRpcParams("supervisor.install_worker_credential", {}),
    /supervisor\.install_worker_credential entry_id:/,
  );
  assert.throws(
    () => parseDaemonRpcParams("local_board.mutate", {}),
    /local_board\.mutate domain:/,
  );
  // Validation refusals never echo secret input values.
  const secretToken = "letagents_secret_token_never_echo_9f8e7d";
  assert.throws(
    () => parseDaemonRpcParams("supervisor.install_worker_credential", {
      entry_id: "agent_1",
      daemon_generation: 1,
      worker_token: ` ${secretToken} `,
    }),
    (error: Error) => {
      assert.match(error.message, /supervisor\.install_worker_credential/);
      assert.equal(error.message.includes(secretToken), false);
      return true;
    },
  );
});

test("result schemas preserve all daemon output fields on agent configuration and attempt.read", () => {
  const configParsed = daemonAgentConfigurationViewSchema.parse({
    entry_id: "agent_1",
    daemon_generation: 1,
    provider: "codex",
    model: null,
    reasoning_effort: null,
    charter: "Stay helpful.",
    permission_profile_id: "full_access",
    supervised_permission_profiles: [],
    provider_launch_policy: {},
    config_revision: 1,
    runtime_configuration_revision: 1,
    delivery_mode: "daemon_inbox",
    live_sharing: "on",
    home_harness: false,
    home_harness_pending: false,
    home_harness_availability: "available",
    image_input: false,
    image_input_available: false,
    share_live_activity: true,
    live_sharing_availability: "available",
  });
  assert.equal(configParsed.delivery_mode, "daemon_inbox");
  assert.equal(configParsed.live_sharing, "on");

  const attemptParsed = daemonAttemptDetailSchema.parse({
    entry_id: "agent_1",
    work_attempt_id: "attempt_1",
    workspace_path: "/tmp/ws",
    last_terminal: null,
    restart_count: 1,
    execution_generations: [{
      execution_generation_id: "exec_1",
      work_attempt_id: "attempt_1",
      started_at: "2026-11-21T00:00:00.000Z",
      actor: "daemon",
      generation: 1,
      terminal: null,
    }],
    checkpoints: [{
      at: "2026-11-21T00:00:01.000Z",
      room_cursor: "msg_1",
      provider_continuation_id: "thread_1",
    }],
    activity: [],
  });
  assert.equal(attemptParsed.execution_generations.length, 1);
  assert.equal(attemptParsed.checkpoints.length, 1);
});
