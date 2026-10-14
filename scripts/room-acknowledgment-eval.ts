/**
 * Sequential, synthetic-only Jev trial. Never changes Room routing.
 * node --import tsx scripts/room-acknowledgment-eval.ts --runs 3 --json /tmp/ack-results.json
 * Reads TYPESAFE_API_KEY or AI_GATEWAY_API_KEY from the environment, never prints it.
 * Exit 1: unsafe or missed classification; 2: setup; 3: incomplete provider measurement.
 */
import { readFile, writeFile } from "node:fs/promises";
import { readJevEndpoint, requestJevEvaluation } from "../src/api/messages/jev-conversation-routing.js";
import { assessAcknowledgment, buildAcknowledgmentRequest, type AcknowledgmentInput } from "../src/api/messages/jev-acknowledgment.js";

const args = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const name = args[i]!;
  if (!["--runs", "--json", "--dry-run"].includes(name) || options.has(name)) {
    console.error("Unknown or duplicate option. Use --runs N, --json PATH, or --dry-run."); process.exit(2);
  }
  if (name === "--dry-run") { options.set(name, "true"); continue; }
  const value = args[++i];
  if (!value?.trim() || value.startsWith("--")) {
    console.error("--runs and --json each require a value."); process.exit(2);
  }
  options.set(name, value);
}
const runs = Number(options.get("--runs") ?? "3");
const output = options.get("--json") ?? "";
const dry = options.has("--dry-run");
if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
  console.error("--runs must be an integer from 1 to 10"); process.exit(2);
}
const config = readJevEndpoint();
if (!config && !dry) {
  console.error("Configure TYPESAFE_API_KEY or AI_GATEWAY_API_KEY in this process environment. No requests were sent.");
  process.exit(2);
}
const cases: Array<{ id: string; expect: "independent_acknowledgment" | "keep_turn_order"; input: AcknowledgmentInput }> =
  JSON.parse(await readFile(new URL("./room-acknowledgment-eval.cases.json", import.meta.url), "utf8"));
const results = [];
let failures = 0;
let mismatches = 0;
for (const item of cases) {
  const request = buildAcknowledgmentRequest(item.input);
  for (let run = 1; run <= (request && !dry ? runs : 1); run++) {
    if (!request || dry) {
      results.push({ id: item.id, run, expected: item.expect, status: request ? "not_measured" : "ineligible",
        decision: request ? null : "keep_turn_order" });
      continue;
    }
    try {
      const response = await requestJevEvaluation(config!, request);
      const answer = assessAcknowledgment(response.body);
      if (!answer.valid) failures++;
      else if (answer.decision !== item.expect) mismatches++;
      results.push({ id: item.id, run, expected: item.expect, status: answer.valid ? "measured" : "invalid_response",
        ...answer, latencyMs: response.latencyMs });
    } catch {
      // No provider error body or request data in output: both may contain secrets.
      failures++;
      results.push({ id: item.id, run, expected: item.expect, status: "provider_error", decision: null });
    }
    console.log(`${item.id} run ${run}: ${results.at(-1)!.status}`);
  }
}
const report = { model: config?.model ?? null, dryRun: dry, runs, failures, mismatches,
  unsafeReleases: results.filter(r => r.expected === "keep_turn_order" && r.decision === "independent_acknowledgment").length,
  measured: results.filter(r => r.status === "measured").length,
  limitation: "Synthetic samples only. No routing changes. A pass does not establish real-world reliability.", results };
if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ dryRun: dry, cases: cases.length, measured: report.measured, failures, mismatches, unsafeReleases: report.unsafeReleases }));
process.exitCode = failures ? 3 : mismatches ? 1 : 0;
