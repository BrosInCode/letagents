import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { supervisedAgentsOnly } from "./platform.js";

import { createElectronTestEnv } from "./harness.js";

const { tempDir } = createElectronTestEnv({
  prefix: "letagents-codex-app-server-",
  paths: [],
});

const {
  codexAppServerLaunchArgs,
  firstRedactedCodexAppServerOutputLine,
  launchCodexAppServer,
  redactCodexAppServerOutput,
  resolveCodexAppServerUrl,
  sensitiveCodexAppServerConfigValues,
  sensitiveCodexAppServerEnvValues,
  waitForLaunchedCodexAppServer,
} = await import("../main/agents/codex-app-server.js");

type CodexAppServerLaunchForTest = ReturnType<typeof launchCodexAppServer>;
type CodexAppServerExitForTest = Awaited<CodexAppServerLaunchForTest["exited"]>;

async function waitForCodexLaunchExitForTest(
  launch: CodexAppServerLaunchForTest,
): Promise<CodexAppServerExitForTest> {
  const keepAlive = setInterval(() => {}, 50);
  try {
    return await launch.exited;
  } finally {
    clearInterval(keepAlive);
  }
}

test("Codex app-server launcher captures spawn errors for the supervisor", async () => {
  const launch = launchCodexAppServer(
    "ws://127.0.0.1:1",
    "letagents-codex-missing-bin-for-test",
  );
  const exit = await waitForCodexLaunchExitForTest(launch);

  assert.equal(exit.type, "error");
  if (exit.type !== "error") {
    assert.fail("Expected a spawn error from the missing Codex binary.");
  }
  assert.match(exit.error.message, /letagents-codex-missing-bin-for-test|ENOENT|spawn/i);
});

test("Codex app-server launcher uses the managed worktree as its process cwd", { skip: supervisedAgentsOnly }, async () => {
  const bin = join(tempDir, "codex-reporting-app-server-cwd");
  writeFileSync(
    bin,
    "#!/usr/bin/env node\nprocess.stdout.write(process.cwd());\n",
    { mode: 0o755 },
  );

  const launch = launchCodexAppServer("ws://127.0.0.1:1", bin, {
    trustedProjectPath: tempDir,
    // A native macOS SSH socket shares /private/ with the worktree path;
    // credential-prefix redaction would hide that part of this cwd fixture.
    env: { SSH_AUTH_SOCK: "" },
  });
  const exit = await waitForCodexLaunchExitForTest(launch);

  assert.equal(exit.type, "exit");
  assert.equal(exit.output?.stdout, realpathSync(tempDir));
});

test("Codex app-server launcher captures early process output without leaking env secrets", { skip: supervisedAgentsOnly }, async () => {
  const bin = join(tempDir, "codex-failing-app-server");
  const secret = "provider-secret-for-test";
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const secret = process.env.OPENAI_API_KEY || '';",
      "process.stderr.write('fatal app-server key ');",
      "process.stderr.write(secret.slice(0, 7));",
      "setTimeout(() => {",
      "  process.stderr.write(secret.slice(7) + '\\n');",
      "  process.exit(1);",
      "}, 10);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const launch = launchCodexAppServer("ws://127.0.0.1:1", bin, {
    env: { OPENAI_API_KEY: secret },
  });
  const exit = await waitForCodexLaunchExitForTest(launch);

  assert.equal(exit.type, "exit");
  assert.match(exit.output?.stderr ?? "", /fatal app-server key \[redacted\]/);
  assert.doesNotMatch(exit.output?.stderr ?? "", new RegExp(secret));
});

test("Codex app-server launcher redacts inherited environment secrets", { skip: supervisedAgentsOnly }, async () => {
  const bin = join(tempDir, "codex-failing-app-server-inherited-env");
  const secret = "inherited-token-secret-for-test";
  const previousToken = process.env.LETAGENTS_TOKEN;
  process.env.LETAGENTS_TOKEN = secret;
  writeFileSync(
    bin,
    "#!/bin/sh\nprintf 'fatal inherited token %s\\n' \"$LETAGENTS_TOKEN\" >&2\nexit 1\n",
    { mode: 0o755 },
  );

  try {
    const launch = launchCodexAppServer("ws://127.0.0.1:1", bin);
    const exit = await waitForCodexLaunchExitForTest(launch);

    assert.equal(exit.type, "exit");
    assert.match(exit.output?.stderr ?? "", /fatal inherited token \[redacted\]/);
    assert.doesNotMatch(exit.output?.stderr ?? "", new RegExp(secret));
  } finally {
    if (previousToken === undefined) {
      delete process.env.LETAGENTS_TOKEN;
    } else {
      process.env.LETAGENTS_TOKEN = previousToken;
    }
  }
});

test("Codex app-server launcher strips ambient LetAgents credentials for bounded and custodial polling profiles", { skip: supervisedAgentsOnly }, async () => {
  const bin = join(tempDir, "codex-reporting-supervised-environment");
  const boundedReport = join(tempDir, "codex-supervised-environment.json");
  const ordinaryReport = join(tempDir, "codex-ordinary-environment.json");
  const pollingReport = join(tempDir, "codex-polling-environment.json");
  const ownerToken = "inherited-owner-token-for-bounded-launch";
  const workerBearer = "inherited-worker-bearer-for-bounded-launch";
  const previousOwner = process.env.LETAGENTS_TOKEN;
  const previousBearer = process.env.LETAGENTS_AGENT_SESSION_BEARER;
  process.env.LETAGENTS_TOKEN = ownerToken;
  process.env.LETAGENTS_AGENT_SESSION_BEARER = workerBearer;
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    "const { writeFileSync } = require('node:fs');",
    "writeFileSync(process.env.LAUNCH_ENV_REPORT, JSON.stringify({",
    "  owner: process.env.LETAGENTS_TOKEN ?? null,",
    "  bearer: process.env.LETAGENTS_AGENT_SESSION_BEARER ?? null,",
    "  bounded: process.env.LETAGENTS_SUPERVISED_BOUNDED_TURNS ?? null,",
    "  turn: process.env.LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID ?? null,",
    "  retained: process.env.LETAGENTS_ENV_CANARY ?? null,",
    "}));",
    "",
  ].join("\n"), { mode: 0o755 });

  try {
    const bounded = launchCodexAppServer("ws://127.0.0.1:1", bin, {
      env: {
        LAUNCH_ENV_REPORT: boundedReport,
        LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
        LETAGENTS_ENV_CANARY: "retained-in-bounded-mode",
      },
    });
    assert.equal((await waitForCodexLaunchExitForTest(bounded)).type, "exit");
    assert.deepEqual(JSON.parse(readFileSync(boundedReport, "utf8")), {
      owner: null,
      bearer: null,
      bounded: "1",
      turn: null,
      retained: "retained-in-bounded-mode",
    });

    const polling = launchCodexAppServer("ws://127.0.0.1:1", bin, {
      env: {
        LAUNCH_ENV_REPORT: pollingReport,
        LETAGENTS_EXECUTION_PROFILE: "supervised_mcp_polling",
        LETAGENTS_SUPERVISED_BOUNDED_TURNS: "1",
        LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID: "obsolete-native-turn",
        LETAGENTS_ENV_CANARY: "retained-in-polling-mode",
      },
    });
    assert.equal((await waitForCodexLaunchExitForTest(polling)).type, "exit");
    assert.deepEqual(JSON.parse(readFileSync(pollingReport, "utf8")), {
      owner: null, bearer: null, bounded: null, turn: null, retained: "retained-in-polling-mode",
    });

    const ordinary = launchCodexAppServer("ws://127.0.0.1:1", bin, {
      env: {
        LAUNCH_ENV_REPORT: ordinaryReport,
        LETAGENTS_ENV_CANARY: "retained-in-ordinary-mode",
      },
    });
    assert.equal((await waitForCodexLaunchExitForTest(ordinary)).type, "exit");
    assert.deepEqual(JSON.parse(readFileSync(ordinaryReport, "utf8")), {
      owner: ownerToken,
      bearer: workerBearer,
      bounded: null,
      turn: null,
      retained: "retained-in-ordinary-mode",
    });
  } finally {
    if (previousOwner === undefined) delete process.env.LETAGENTS_TOKEN;
    else process.env.LETAGENTS_TOKEN = previousOwner;
    if (previousBearer === undefined) delete process.env.LETAGENTS_AGENT_SESSION_BEARER;
    else process.env.LETAGENTS_AGENT_SESSION_BEARER = previousBearer;
  }
});

test("Codex app-server launcher redacts split inherited secrets after parent exit", { skip: supervisedAgentsOnly }, async () => {
  const bin = join(tempDir, "codex-failing-app-server-late-stderr");
  const secret = "late-inherited-token-secret-for-test";
  const previousToken = process.env.LETAGENTS_TOKEN;
  const lateTailScript = `setTimeout(() => { process.stderr.write(${JSON.stringify(secret.slice(7) + "\n")}); }, 100);`;
  process.env.LETAGENTS_TOKEN = secret;
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const { spawn } = require('node:child_process');",
      "const secret = process.env.LETAGENTS_TOKEN || '';",
      "process.stderr.write('fatal late token ' + secret.slice(0, 7));",
      "spawn(process.execPath, [",
      "  '-e',",
      `  ${JSON.stringify(lateTailScript)},`,
      "], { stdio: ['ignore', 'ignore', process.stderr] });",
      "process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const launch = launchCodexAppServer("ws://127.0.0.1:1", bin);
    const exit = await waitForCodexLaunchExitForTest(launch);

    assert.equal(exit.type, "exit");
    assert.match(exit.output?.stderr ?? "", /fatal late token \[redacted\]/);
    assert.doesNotMatch(exit.output?.stderr ?? "", new RegExp(secret));
    assert.doesNotMatch(exit.output?.stderr ?? "", /late-inherited-token/);
  } finally {
    if (previousToken === undefined) {
      delete process.env.LETAGENTS_TOKEN;
    } else {
      process.env.LETAGENTS_TOKEN = previousToken;
    }
  }
});

test("Codex app-server launcher suppresses partial output when stdio does not close", { skip: supervisedAgentsOnly }, async () => {
  const bin = join(tempDir, "codex-failing-app-server-held-stderr");
  const secret = "abcdefghijklmnopqrstuvwxyz1234567890";
  const previousToken = process.env.LETAGENTS_TOKEN;
  process.env.LETAGENTS_TOKEN = secret;
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const { spawn } = require('node:child_process');",
      "const secret = process.env.LETAGENTS_TOKEN || '';",
      "process.stderr.write('fatal held token ' + secret.slice(0, 12));",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 800);'], {",
      "  stdio: ['ignore', 'ignore', process.stderr],",
      "});",
      "process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const launch = launchCodexAppServer("ws://127.0.0.1:1", bin);
    const exit = await waitForCodexLaunchExitForTest(launch);

    assert.equal(exit.type, "exit");
    assert.equal(exit.output?.truncated, true);
    assert.equal(exit.output?.stderr, "");
    assert.doesNotMatch(JSON.stringify(exit.output), new RegExp(secret.slice(0, 12)));
  } finally {
    if (previousToken === undefined) {
      delete process.env.LETAGENTS_TOKEN;
    } else {
      process.env.LETAGENTS_TOKEN = previousToken;
    }
  }
});

test("Codex app-server launcher redacts sensitive endpoint config values", () => {
  const endpoint = "https://user:pass@example.com/v1?api_key=query-secret-for-test";
  const redactions = sensitiveCodexAppServerConfigValues([
    `model_providers.letagents_open_model.base_url=${JSON.stringify(endpoint)}`,
  ]);
  const output = redactCodexAppServerOutput(
    `failed with ${endpoint} user pass query-secret-for-test`,
    redactions,
  );

  assert.match(output, /failed with \[redacted\]/);
  assert.doesNotMatch(output, /user/);
  assert.doesNotMatch(output, /pass/);
  assert.doesNotMatch(output, /query-secret-for-test/);
});

test("Codex app-server output line redacts inherited secrets for provider preflight", () => {
  const secret = "preflight-inherited-token-secret-for-test";
  const detail = firstRedactedCodexAppServerOutputLine(
    "",
    `app-server failed token ${secret}\n`,
    sensitiveCodexAppServerEnvValues({ LETAGENTS_TOKEN: secret }),
  );

  assert.equal(detail, "app-server failed token [redacted]");
  assert.doesNotMatch(detail ?? "", new RegExp(secret));
});

test("Codex app-server launcher passes its config overrides and no project trust for the managed worktree", () => {
  assert.deepEqual(codexAppServerLaunchArgs("ws://127.0.0.1:4500"), [
    "app-server",
    "--listen",
    "ws://127.0.0.1:4500",
  ]);
  // A project trust override would make Codex load the worktree's own .codex config.
  assert.deepEqual(codexAppServerLaunchArgs("ws://127.0.0.1:4500", {
    trustedProjectPath: "/tmp/room-worktree",
  }), [
    "app-server",
    "--listen",
    "ws://127.0.0.1:4500",
  ]);
  assert.deepEqual(codexAppServerLaunchArgs("ws://127.0.0.1:4500", {
    trustedProjectPath: "/tmp/room-worktree",
    configOverrides: ['model="gpt-5.2-codex-high"', 'model_reasoning_effort="xhigh"'],
  }), [
    "app-server",
    "-c",
    'model="gpt-5.2-codex-high"',
    "-c",
    'model_reasoning_effort="xhigh"',
    "--listen",
    "ws://127.0.0.1:4500",
  ]);
});

test("dedicated Codex app-server URLs do not reuse the shared configured server", async () => {
  const previous = process.env.LETAGENTS_CODEX_SERVER_URL;
  process.env.LETAGENTS_CODEX_SERVER_URL = "ws://127.0.0.1:4500";
  try {
    assert.equal(await resolveCodexAppServerUrl(null, { dedicated: false }), "ws://127.0.0.1:4500");
    const dedicatedUrl = await resolveCodexAppServerUrl(null, { dedicated: true });
    assert.match(dedicatedUrl, /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(dedicatedUrl, "ws://127.0.0.1:4500");
  } finally {
    if (previous === undefined) {
      delete process.env.LETAGENTS_CODEX_SERVER_URL;
    } else {
      process.env.LETAGENTS_CODEX_SERVER_URL = previous;
    }
  }
});

test("Codex app-server readiness wait fails on early launched-process errors", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    fetchCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    throw new Error("not ready yet");
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => waitForLaunchedCodexAppServer("ws://127.0.0.1:4500", {
        pid: 12345,
        exited: Promise.resolve({ type: "error", error: new Error("spawn ENOENT") }),
      }, 1_000),
      /Codex app-server exited before it became ready: spawn ENOENT/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalls, 1);
});

test("Codex app-server readiness wait includes captured early-exit diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    throw new Error("not ready yet");
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => waitForLaunchedCodexAppServer("ws://127.0.0.1:4500", {
        pid: 12345,
        exited: Promise.resolve({
          type: "exit",
          code: 1,
          signal: null,
          output: {
            stdout: "",
            stderr: "fatal app-server config",
            truncated: false,
          },
        }),
      }, 1_000),
      /Codex app-server exited before it became ready: code 1: stderr: fatal app-server config/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex app-server readiness wait prefers late child exit over generic timeout", async () => {
  const originalFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    throw new Error("not ready yet");
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => waitForLaunchedCodexAppServer("ws://127.0.0.1:4500", {
        pid: 12345,
        exited: new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              type: "exit",
              code: 1,
              signal: null,
              output: {
                stdout: "",
                stderr: "fatal after timeout",
                truncated: false,
              },
            });
          }, 300);
        }),
      }, 1),
      /Codex app-server exited before it became ready: code 1: stderr: fatal after timeout/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
