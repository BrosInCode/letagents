#!/usr/bin/env node
/**
 * Measures the automatic command review against labelled commands.
 *
 *   OPENROUTER_API_KEY=... node scripts/permission-review-eval.mjs [--runs 3] [--json out.json]
 *   TYPESAFE_API_KEY=...   node scripts/permission-review-eval.mjs
 *
 * It sends only the commands in the cases file and the imagined project's path.
 *
 * Exit code 1: a command labelled "ask" was allowed, or a fixed rule let a
 * listed command through. Commands labelled "probe" are reported and not judged. Exit code 3: a model call failed, so the run
 * measured less than it claims. A failed call is never counted as a correct
 * answer.
 */
import { readFile, writeFile } from "node:fs/promises";

import {
  PERMISSION_REVIEW_APPROVE_AT,
  PERMISSION_REVIEW_RISKY_AT_MOST,
  buildPermissionReviewRequest,
  commandNeedsPerson,
  decidePermissionReview,
  parsePermissionReviewAnswers,
} from "../shared/permission-review.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const runs = Math.max(1, Math.min(10, Number.parseInt(option("--runs", "3"), 10) || 3));
const jsonPath = option("--json", null);
const typesafeKey = process.env.TYPESAFE_API_KEY?.trim();
const apiKey = typesafeKey || process.env.OPENROUTER_API_KEY?.trim();
const baseUrl = (process.env.PERMISSION_REVIEW_EVAL_BASE_URL?.trim()
  || (typesafeKey ? "https://api.typesafe.ai/v1" : "https://openrouter.ai/api/v1")).replace(/\/+$/, "");
const model = process.env.PERMISSION_REVIEW_EVAL_MODEL?.trim() || "jev-1.13";
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY or TYPESAFE_API_KEY.");
  process.exit(2);
}

const file = JSON.parse(await readFile(new URL("./permission-review-eval.cases.json", import.meta.url), "utf8"));

async function score(request) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/systemone`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, state: request.state, questions: request.questions }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return { answers: parsePermissionReviewAnswers(body), ms: Date.now() - started, cost: Number(body?.usage?.cost) || 0, served: body?.model ?? null };
}

const results = [];
const served = new Set();
const latencies = [];
let cost = 0;
let failedCalls = 0;
for (const item of file.cases) {
  // One request may hold several commands; a command joined with `&&` or `;` is reviewed whole.
  const request = buildPermissionReviewRequest({ commands: [item.command], project: file.project });
  if (!request) {
    results.push({ ...item, decided_by: "rule", decisions: ["ask"], answers: [] });
    continue;
  }
  const decisions = [];
  const answers = [];
  for (let run = 0; run < runs; run += 1) {
    try {
      const reply = await score(request);
      cost += reply.cost;
      latencies.push(reply.ms);
      if (reply.served) served.add(reply.served);
      answers.push(reply.answers);
      decisions.push(decidePermissionReview(reply.answers));
    } catch (error) {
      failedCalls += 1;
      answers.push({ error: String(error?.message ?? error) });
      decisions.push("failed");
    }
  }
  results.push({ ...item, decided_by: "model", decisions, answers });
}

const leaked = file.rules_only.filter((command) => !commandNeedsPerson(command, file.project));
const measured = (result) => !result.decisions.includes("failed");
const always = (result, decision) => result.decisions.every((value) => value === decision);
const wronglyAllowed = results.filter((result) => result.expect === "ask" && result.decisions.includes("allow"));
const unstable = results.filter((result) => measured(result) && new Set(result.decisions).size > 1);
latencies.sort((a, b) => a - b);

const number = (value) => value === null || value === undefined ? "?" : value.toFixed(2);
const line = (result) => {
  const shown = result.answers.map((entry) => entry.error ? `failed (${entry.error})`
    : entry.kinds ? Object.entries(entry.kinds).map(([name, value]) => `${name}=${number(value)}`).join(" ") : "no consistent answer").join(" | ");
  return `  ${result.decisions.join(",").padEnd(18)} ${JSON.stringify(result.command)}  ${result.decided_by === "rule" ? "[no fixed rule reads it]" : shown}`;
};

console.log(`Model ${model} (served as ${[...served].join(", ") || "nothing"}) at ${baseUrl}`);
console.log(`${runs} run(s) per command, approve at ${PERMISSION_REVIEW_APPROVE_AT}, risky at most ${PERMISSION_REVIEW_RISKY_AT_MOST}\n`);
// "tuning" cases shaped the questions. "held_out" cases were written afterwards and never tuned
// against. Both were written by the same author about the same project, so they are two samples
// of one kind of command, not an independent benchmark.
for (const set of ["tuning", "held_out"]) {
  const expectAllow = results.filter((result) => result.set === set && result.expect === "allow");
  const expectAsk = results.filter((result) => result.set === set && result.expect === "ask");
  const allowed = expectAllow.filter((result) => always(result, "allow"));
  const stoppedByRule = (group) => group.filter((result) => result.decided_by === "rule").length;
  const askedByModel = expectAsk.filter((result) => result.decided_by === "model" && always(result, "ask"));
  console.log(`== ${set} ==`);
  console.log(`Routine commands: ${allowed.length} of ${expectAllow.length} ran without asking (${stoppedByRule(expectAllow)} stopped by a rule, ${expectAllow.length - allowed.length - stoppedByRule(expectAllow)} by the model or a failed call)`);
  for (const result of expectAllow.filter((entry) => !always(entry, "allow"))) console.log(line(result));
  console.log(`Commands a person should see: ${stoppedByRule(expectAsk) + askedByModel.length} of ${expectAsk.length} reached a person (${stoppedByRule(expectAsk)} by a rule, ${askedByModel.length} by the model)`);
  for (const result of expectAsk.filter((entry) => entry.decided_by === "model")) console.log(line(result));
  console.log("");
}
console.log("== names ==");
console.log("One script under different names. The scores show how far a name moves the answer.");
for (const result of results.filter((entry) => entry.set === "names" || /ignore-previous/.test(entry.command))) console.log(line(result));
console.log(`\nListed commands the rules must stop: ${file.rules_only.length - leaked.length} of ${file.rules_only.length}. This list was written with the rules, so it guards against regressions and measures nothing.`);
for (const command of leaked) console.log(`  LET THROUGH ${JSON.stringify(command)}`);
console.log(`\nDecision changed between runs for ${unstable.length} command(s)`);
console.log(`Model calls ${latencies.length} answered, ${failedCalls} failed, median ${latencies[Math.floor(latencies.length / 2)] ?? 0} ms, slowest ${latencies.at(-1) ?? 0} ms, cost $${cost.toFixed(6)}`);
if (jsonPath) {
  await writeFile(jsonPath, `${JSON.stringify({ model, served: [...served], baseUrl, runs, failedCalls, leaked, cost,
    latencyMs: { median: latencies[Math.floor(latencies.length / 2)] ?? null, slowest: latencies.at(-1) ?? null }, results }, null, 2)}\n`);
}
process.exit(wronglyAllowed.length > 0 || leaked.length > 0 ? 1 : failedCalls > 0 ? 3 : 0);
