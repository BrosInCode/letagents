import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { parse } from "yaml";
import { prepareEvaluator } from "./prepare-room-ack-eval.mjs";

function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes; });
    child.stderr.on("data", bytes => { output += bytes; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, output }));
  });
}

test("standalone package needs no dependencies or keys for dry-run; preserves measured failures without logging secrets", async () => {
  const temp = await mkdtemp(join(tmpdir(), "room-ack-package-test-"));
  const destination = join(temp, "evaluator");
  let server;
  try {
    await prepareEvaluator(destination);
    await assert.rejects(prepareEvaluator(destination), /EEXIST/, "cannot overwrite an existing folder");
    const script = join(destination, "scripts/room-acknowledgment-eval.js");
    const reportFile = join(temp, "result.json");
    const env = { PATH: process.env.PATH };
    const dry = await run(script, ["--dry-run", "--json", reportFile], env);
    assert.equal(dry.code, 0, dry.output);
    assert.equal(JSON.parse(await readFile(reportFile, "utf8")).measured, 0);
    const holdout = await run(script, ["--suite", "holdout", "--dry-run", "--json", reportFile], env);
    assert.equal(holdout.code, 0, holdout.output);
    const holdoutReport = JSON.parse(await readFile(reportFile, "utf8"));
    assert.equal(holdoutReport.suite, "holdout");
    assert.equal(holdoutReport.results.length, 36);
    assert.ok(holdoutReport.results.every(row => row.id.startsWith("holdout-")));
    assert.equal(holdoutReport.results.filter(row => row.status === "ineligible").length, 4);
    assert.equal(holdoutReport.results.filter(row => row.expected === "independent_acknowledgment").length, 12);
    assert.equal((await run(script, [], env)).code, 2, "missing credentials fail closed");

    let count = 0;
    let fail = false;
    server = createServer((req, res) => {
      count++;
      assert.equal(req.headers.authorization, "Bearer PRIVATE_TEST_SENTINEL");
      assert.equal(req.url, "/systemone");
      req.resume();
      res.writeHead(fail ? 429 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(fail ? { error: "PRIVATE_TEST_SENTINEL" } : { answers: {
        acknowledgment_only: { probability: 0 }, substantive_or_ambiguous: { probability: 1 },
      } }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    Object.assign(env, { TYPESAFE_API_KEY: "PRIVATE_TEST_SENTINEL", TYPESAFE_BASE_URL: `http://127.0.0.1:${server.address().port}` });
    const measured = await run(script, ["--runs", "1", "--json", reportFile], env);
    assert.equal(measured.code, 1, measured.output);
    const report = JSON.parse(await readFile(reportFile, "utf8"));
    assert.ok(report.mismatches > 0);
    assert.equal(report.measured, count);
    assert.ok(count <= 36);
    assert.equal(report.unsafeReleases, 0);
    assert.doesNotMatch(measured.output + JSON.stringify(report), /PRIVATE_TEST_SENTINEL/);
    fail = true;
    const failed = await run(script, ["--runs", "1", "--json", reportFile], env);
    assert.equal(failed.code, 3, failed.output);
    assert.doesNotMatch(failed.output + await readFile(reportFile, "utf8"), /PRIVATE_TEST_SENTINEL/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test("manual evaluation cannot run CI publishing/deployment jobs or forward application credentials", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.equal(workflow.on.workflow_dispatch.inputs.purpose.default, "checks");
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.purpose.options, ["checks", "room-ack-evaluation"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.ack_suite.options, ["baseline", "holdout"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.ack_suite.default, "baseline");
  const checks = "inputs.purpose != 'room-ack-evaluation'";
  const gate = "${{ always() && inputs.purpose != 'room-ack-evaluation' }}";
  const staging = "github.ref == 'refs/heads/staging' && inputs.purpose != 'room-ack-evaluation'";
  const conditions = {
    "dependency-audit": checks,
    "build-checks": checks,
    "desktop-tests": checks,
    build: gate,
    "integration-db-tests": checks,
    "mcp-tests-windows": checks,
    "desktop-tests-windows": checks,
    "process-tree-windows": checks,
    "integration-tests": gate,
    "npm-publish": staging,
    docker: staging,
    deploy: staging,
  };
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...Object.keys(conditions), "room-ack-evaluation"].sort());
  for (const [name, condition] of Object.entries(conditions)) {
    assert.equal(workflow.jobs[name].if, condition, name);
  }
  // The Windows test jobs are checks like the ubuntu ones: they are off on
  // the manual evaluation, read the repository only and are given no secret.
  for (const name of ["mcp-tests-windows", "desktop-tests-windows", "process-tree-windows"]) {
    const windows = workflow.jobs[name];
    assert.equal(windows["runs-on"], "windows-latest", name);
    assert.deepEqual(windows.permissions, { contents: "read" }, name);
    assert.doesNotMatch(JSON.stringify(windows), /secrets\./, name);
  }
  const job = workflow.jobs["room-ack-evaluation"];
  assert.equal(job.if, "github.event_name == 'workflow_dispatch' && inputs.purpose == 'room-ack-evaluation'");
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.steps[0].with.ref, "${{ github.sha }}");
  const remote = job.steps.find(step => step.uses?.startsWith("appleboy/ssh-action@"));
  assert.deepEqual(Object.keys(remote.env), ["ROOM_ACK_EVAL_PAYLOAD", "ROOM_ACK_EVAL_SUITE"]);
  assert.equal(remote.with.envs, "ROOM_ACK_EVAL_PAYLOAD,ROOM_ACK_EVAL_SUITE");
  assert.match(remote.with.script, /timeout -s KILL 480 node .* --runs 3 --json/);
  assert.match(remote.with.script, /trap cleanup EXIT/);
  assert.match(remote.with.script, /exit "\$status"/);
  assert.doesNotMatch(remote.with.script, /\.env|docker (?:restart|stop|run|compose)|git |\/app|printenv|inspect[^\n]*(?:Config|Env)/);
});

test("remote command retains provider failures, fails missing reports, and cleans temporary files", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const script = workflow.jobs["room-ack-evaluation"].steps.find(step => step.uses?.startsWith("appleboy/ssh-action@")).with.script;
  const temp = await mkdtemp(join(tmpdir(), "room-ack-shell-test-"));
  try {
    const bin = join(temp, "bin");
    await mkdir(bin);
    const payloadDir = join(temp, "payload");
    await mkdir(payloadDir);
    await writeFile(join(payloadDir, "fixture.txt"), "synthetic");
    const archive = spawnSync("tar", ["-czf", "-", "-C", payloadDir, "."]);
    assert.equal(archive.status, 0);
    const log = join(temp, "calls.jsonl");
    await writeFile(join(bin, "docker"), `#!${process.execPath}
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
      if (args[0] === 'inspect') console.log(args[2] === '{{.Id}}' ? 'fixed-container-id' : 'true');
      else if (args[0] === 'exec') {
        if (args[2] === 'timeout') process.exit(Number(process.env.EVAL_STATUS));
        if (args[2] === 'cat') {
          if (process.env.REPORT_MISSING === 'true') process.exit(1);
          console.log('{"synthetic":true}');
        }
      }
    `, { mode: 0o700 });
    await writeFile(join(bin, "sha256sum"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    for (const [evaluation, missing, expected] of [[0, false, 0], [1, false, 1], [2, true, 2], [3, false, 3], [0, true, 3], [137, true, 137]]) {
      await writeFile(log, "");
      const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: {
        PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, EVAL_STATUS: String(evaluation), REPORT_MISSING: String(missing),
        ROOM_ACK_EVAL_PAYLOAD: archive.stdout.toString("base64"), ROOM_ACK_EVAL_SUITE: "holdout",
      } });
      assert.equal(result.status, expected, result.stderr);
      const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
      const copied = calls.find(args => args[0] === "cp")[1];
      assert.match(copied, /^\/tmp\/letagents-ack-eval\.[A-Za-z0-9]+$/);
      assert.ok(calls.some(args => JSON.stringify(args) === JSON.stringify(["exec", "fixed-container-id", "rm", "-rf", copied])));
      await assert.rejects(access(copied), /ENOENT/, "host temporary directory was removed");
      const timeout = calls.find(args => args[2] === "timeout");
      assert.deepEqual(timeout.slice(0, 7), ["exec", "fixed-container-id", "timeout", "-s", "KILL", "480", "node"]);
      assert.deepEqual(timeout.slice(8, 12), ["--suite", "holdout", "--runs", "3"]);
    }
    const invalid = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: {
      PATH: `${bin}:${process.env.PATH}`, ROOM_ACK_EVAL_SUITE: "holdout; exit 0",
    } });
    assert.equal(invalid.status, 2, "only the fixed suite choices can reach the server command");
  } finally { await rm(temp, { recursive: true, force: true }); }
});
