import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("evaluation distinguishes synthetic provider errors, unsafe classifications and unmeasured dry runs", async () => {
  let requests = 0;
  let malformed = true;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(malformed ? {} : { answers: {
      acknowledgment_only: { noul: 1 }, substantive_or_ambiguous: { noul: 0 },
    } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const dir = await mkdtemp(path.join(tmpdir(), "room-ack-eval-"));
  const reportPath = path.join(dir, "report.json");
  async function run(dry = false, customArgs?: string[]) {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/room-acknowledgment-eval.ts",
      ...(customArgs ?? ["--runs", "1", "--json", reportPath, ...(dry ? ["--dry-run"] : [])])], {
      cwd: new URL("../../../", import.meta.url),
      env: { ...process.env, TYPESAFE_API_KEY: "fixture-secret", TYPESAFE_BASE_URL: `http://127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("exit", resolve);
    });
    assert.ok(!output.includes("fixture-secret"));
    return { code, report: JSON.parse(await readFile(reportPath, "utf8")) };
  }
  try {
    const dry = await run(true);
    assert.equal(dry.code, 0);
    assert.equal(requests, 0);
    assert.equal(dry.report.measured, 0);
    for (const args of [["--json"], ["--json", "--runs", "1"], ["--unknown"],
      ["--runs", "1", "--runs", "2"], ["--runs", "0"], ["--runs", "1.5"]]) {
      assert.equal((await run(false, args)).code, 2);
      assert.equal(requests, 0);
    }
    const invalid = await run();
    assert.equal(invalid.code, 3);
    assert.ok(requests > 0);
    assert.equal(invalid.report.measured, 0);
    assert.ok(invalid.report.failures > 0);
    malformed = false;
    const unsafe = await run();
    assert.equal(unsafe.code, 1);
    assert.ok(unsafe.report.unsafeReleases > 0);
    assert.equal(unsafe.report.failures, 0);
    assert.equal(unsafe.report.results.find((r: { id: string }) => r.id === "attachment").status, "ineligible");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
