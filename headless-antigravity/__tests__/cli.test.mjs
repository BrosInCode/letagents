import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import {
  isTruthyEnv,
  normalizeTargetMode,
  parseArgs,
} from "../cli/args.mjs";
import {
  listCascades,
  listModels,
  runDirectResponse,
} from "../cli/commands.mjs";
import { runCascadeMode } from "../cli/cascade-runner.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

function createFakeLanguageServer(options = {}) {
  const {
    cascadeId = "cascade-1",
    directResponse = "4",
    reply = "done",
    trajectories = {
      trajectorySummaries: {
        [cascadeId]: { status: "CASCADE_RUN_STATUS_WAITING_FOR_USER" },
      },
    },
  } = options;
  const requests = [];

  const server = http.createServer((req, res) => {
    let rawBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      rawBody += chunk;
    });
    req.on("end", () => {
      const method = req.url.split("/").pop();
      const body = rawBody ? JSON.parse(rawBody) : null;
      requests.push({ method, body, headers: req.headers });

      const responses = {
        GetAllCascadeTrajectories: trajectories,
        GetCascadeModelConfigs: {
          clientModelConfigs: [{ modelOrAlias: { model: "MODEL_TEST" } }],
        },
        GetModelResponse: { response: directResponse },
        StartCascade: { cascadeId },
        SignalExecutableIdle: {},
        SendUserCascadeMessage: {},
        GetCascadeTrajectory: {
          status: "CASCADE_RUN_STATUS_RUNNING",
          numTotalSteps: 1,
        },
        GetCascadeTrajectorySteps: {
          steps: [{ plannerResponse: { response: reply } }],
        },
      };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responses[method] ?? {}));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requests,
      });
    });
  });
}

async function captureConsole(work) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await work();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { logs, errors };
}

test("parseArgs and target helpers preserve CLI flag behavior", () => {
  const parsed = parseArgs([
    "--direct",
    "--json",
    "--workspace-ls",
    "--legacy-stream",
    "hello",
    "world",
  ]);

  assert.equal(parsed.direct, true);
  assert.equal(parsed.jsonOut, true);
  assert.equal(parsed.targetMode, "workspace");
  assert.equal(parsed.legacyReactive, true);
  assert.equal(parsed.prompt, "hello world");
  assert.equal(normalizeTargetMode(" CORE "), "core");
  assert.equal(normalizeTargetMode("unknown"), "auto");
  assert.equal(isTruthyEnv("1"), true);
  assert.equal(isTruthyEnv("true"), true);
  assert.equal(isTruthyEnv("yes"), false);
});

test("command helpers keep the list and direct RPC contracts", async () => {
  const { baseUrl, requests } = await createFakeLanguageServer();

  const { logs } = await captureConsole(async () => {
    await listCascades({ baseUrl, csrf: "csrf-token" });
    await listModels({ targetKind: "core", baseUrl, csrf: "csrf-token" });
    await runDirectResponse({
      baseUrl,
      csrf: "csrf-token",
      prompt: "2+2",
      modelId: "MODEL_TEST",
      jsonOut: false,
    });
  });

  assert.deepEqual(
    requests.map((request) => request.method),
    ["GetAllCascadeTrajectories", "GetCascadeModelConfigs", "GetModelResponse"],
  );
  assert.equal(JSON.parse(logs[0]).pickedActive, "cascade-1");
  assert.deepEqual(requests[2].body, {
    prompt: "2+2",
    model: "MODEL_TEST",
  });
  assert.equal(logs.at(-1), "4");
});

test("cascade runner keeps the new-cascade RPC sequence and payloads", async () => {
  const { baseUrl, requests } = await createFakeLanguageServer();

  const { logs } = await captureConsole(async () => {
    await runCascadeMode({
      env: { ANTIGRAVITY_MAX_POLLS: "1", ANTIGRAVITY_POLL_MS: "1" },
      baseUrl,
      targetProcess: { pid: "pid-1", csrf: "csrf-token" },
      targetKind: "core",
      workspaceUri: "file:///tmp/repo",
      prompt: "hello",
      modelId: "MODEL_TEST",
      jsonOut: false,
      noStream: true,
      legacyReactive: false,
      resolveCascade: false,
      scanAllLs: false,
      verbose: false,
      log: () => {},
    });
  });

  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "StartCascade",
      "SignalExecutableIdle",
      "SendUserCascadeMessage",
      "GetCascadeTrajectory",
      "GetCascadeTrajectorySteps",
    ],
  );
  assert.deepEqual(requests[0].body, { workspaceUris: ["file:///tmp/repo"] });
  assert.deepEqual(requests[1].body, { conversationId: "cascade-1" });
  assert.equal(requests[2].body.cascadeId, "cascade-1");
  assert.deepEqual(requests[2].body.items, [{ text: "hello" }]);
  assert.equal(
    requests[2].body.cascadeConfig.plannerConfig.requestedModel.modelId,
    "MODEL_TEST",
  );
  assert.equal(logs.at(-1), "done");
});

test("resolve-cascade reuses the active trajectory instead of starting one", async () => {
  const { baseUrl, requests } = await createFakeLanguageServer({
    cascadeId: "started-id",
    trajectories: {
      trajectorySummaries: {
        "reused-id": { status: "CASCADE_RUN_STATUS_WAITING_FOR_USER" },
      },
    },
  });

  const { logs } = await captureConsole(async () => {
    await runCascadeMode({
      env: { ANTIGRAVITY_MAX_POLLS: "1", ANTIGRAVITY_POLL_MS: "1" },
      baseUrl,
      targetProcess: { pid: "pid-1", csrf: "csrf-token" },
      targetKind: "core",
      workspaceUri: "file:///tmp/repo",
      prompt: "hello",
      modelId: "MODEL_TEST",
      jsonOut: false,
      noStream: true,
      legacyReactive: false,
      resolveCascade: true,
      scanAllLs: false,
      verbose: false,
      log: () => {},
    });
  });

  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "GetAllCascadeTrajectories",
      "SignalExecutableIdle",
      "SendUserCascadeMessage",
      "GetCascadeTrajectory",
      "GetCascadeTrajectorySteps",
    ],
  );
  assert.equal(requests[1].body.conversationId, "reused-id");
  assert.equal(requests[2].body.cascadeId, "reused-id");
  assert.equal(logs.at(-1), "done");
});

test("scan-all-ls rebinds the base URL and CSRF token before sending", async () => {
  const { baseUrl, requests } = await createFakeLanguageServer({
    cascadeId: "scan-id",
  });

  const { logs } = await captureConsole(async () => {
    await runCascadeMode({
      env: {
        ANTIGRAVITY_CASCADE_ID: "scan-id",
        ANTIGRAVITY_MAX_POLLS: "1",
        ANTIGRAVITY_POLL_MS: "1",
      },
      baseUrl: "http://127.0.0.1:1",
      targetProcess: { pid: "old-pid", csrf: "old-token" },
      targetKind: "core",
      workspaceUri: "file:///tmp/repo",
      prompt: "hello",
      modelId: "MODEL_TEST",
      jsonOut: false,
      noStream: true,
      legacyReactive: false,
      resolveCascade: false,
      scanAllLs: true,
      verbose: false,
      log: () => {},
      resolveAcrossLsInstances: async ({ wantCascadeId, workspaceUri }) => {
        assert.equal(wantCascadeId, "scan-id");
        assert.equal(workspaceUri, "file:///tmp/repo");
        return {
          baseUrl,
          csrf: "new-token",
          pid: "new-pid",
          kind: "core",
          cascadeId: "scan-id",
        };
      },
    });
  });

  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "SignalExecutableIdle",
      "SendUserCascadeMessage",
      "GetCascadeTrajectory",
      "GetCascadeTrajectorySteps",
    ],
  );
  assert.equal(
    requests.every(
      (request) => request.headers["x-codeium-csrf-token"] === "new-token",
    ),
    true,
  );
  assert.equal(requests[0].body.conversationId, "scan-id");
  assert.equal(logs.at(-1), "done");
});
