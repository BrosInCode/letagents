import assert from "node:assert/strict";
import test from "node:test";

import { LaunchProgress, launchFailureAction } from "../launch-progress.js";

const START = Date.parse("2026-10-26T10:00:00.000Z");

function tracker() {
  let now = START;
  const progress = new LaunchProgress(() => now);
  return { progress, advance(ms: number) { now += ms; } };
}

test("a launch reports the phase in progress, each finished phase's time and its end", () => {
  const { progress, advance } = tracker();
  let changes = 0;
  progress.begin("agent", () => { changes += 1; });
  assert.equal(progress.view("agent")!.current, "prepare");
  advance(300); progress.mark("agent", "prepare");
  advance(2_000); progress.mark("agent", "slot_wait");
  advance(10); progress.mark("agent", "admission");
  advance(1_200); progress.mark("agent", "process");
  assert.equal(progress.view("agent")!.current, "bootstrap", "a native ready signal hands over to the bootstrap");
  advance(900); progress.markProcessReturned("agent");
  advance(50); progress.mark("agent", "install");
  const view = progress.view("agent")!;
  assert.equal(view.state, "launched");
  assert.equal(view.current, null);
  assert.deepEqual(view.phases.map(({ phase, ms }) => [phase, ms]),
    [["prepare", 300], ["slot_wait", 2_000], ["admission", 10], ["process", 1_200], ["bootstrap", 900], ["install", 50]]);
  assert.equal(view.started_at, "2026-10-26T10:00:00.000Z");
  assert.equal(view.ended_at, new Date(START + 4_460).toISOString());
  assert.equal(changes, 7);
});

test("without a native ready signal the provider call is the whole process start, with no bootstrap", () => {
  const { progress, advance } = tracker();
  progress.begin("agent");
  for (const phase of ["prepare", "slot_wait", "admission"] as const) progress.mark("agent", phase);
  advance(800); progress.markProcessReturned("agent");
  assert.equal(progress.view("agent")!.current, "install");
  assert.deepEqual(progress.view("agent")!.phases.map(({ phase }) => phase), ["prepare", "slot_wait", "admission", "process", "install"]);
});

test("marks out of order are ignored, and nothing changes after the launch ended", () => {
  const { progress } = tracker();
  progress.begin("agent");
  progress.mark("agent", "install");
  progress.mark("agent", "slot_wait");
  assert.equal(progress.view("agent")!.current, "prepare");
  progress.fail("agent", new Error("boom"));
  progress.mark("agent", "prepare");
  assert.equal(progress.view("agent")!.state, "failed");
  assert.equal(progress.view("agent")!.phases.length, 1);
});

test("the first visible output after a finished launch is recorded once; earlier output is not the first turn's", () => {
  const { progress, advance } = tracker();
  progress.begin("agent");
  progress.observeOutput("agent", "item/agentMessage/delta");
  for (const phase of ["prepare", "slot_wait", "admission", "process", "bootstrap", "install"] as const) progress.mark("agent", phase);
  progress.observeOutput("agent", "turn/started");
  assert.equal(progress.view("agent")!.first_output_at, null, "a lifecycle event is not visible output");
  advance(1_500);
  progress.observeOutput("agent", "item/toolCall/updated");
  advance(500);
  progress.observeOutput("agent", "item/agentMessage/delta");
  assert.equal(progress.view("agent")!.first_output_at, new Date(START + 1_500).toISOString());
});

test("a failure keeps its phase and one recovery kind, never its text", () => {
  const { progress } = tracker();
  progress.begin("agent");
  progress.mark("agent", "prepare");
  progress.fail("agent", new Error("Invalid API key · Please run /login (token sk-ant-secret)"));
  const view = progress.view("agent")!;
  assert.deepEqual(view.failure, { phase: "slot_wait", action: "sign_in" });
  assert.equal(JSON.stringify(view).includes("sk-ant"), false);
});

test("a launch that returned without finishing or failing is forgotten; a finished one stays", () => {
  const { progress } = tracker();
  let changes = 0;
  progress.begin("agent", () => { changes += 1; });
  progress.settle("agent");
  assert.equal(progress.view("agent"), null);
  assert.equal(changes, 2, "forgetting it wakes the watch too");
  progress.begin("agent");
  progress.fail("agent", "x");
  progress.settle("agent");
  assert.equal(progress.view("agent")!.state, "failed");
});

test("the slot queue position is shown only while this launch waits for a slot", () => {
  const { progress } = tracker();
  progress.begin("agent");
  assert.equal(progress.view("agent", { active: 3, queued: ["other", "agent"] })!.slot_ahead, null);
  progress.mark("agent", "prepare");
  assert.equal(progress.view("agent", { active: 3, queued: ["other", "agent"] })!.slot_ahead, 4);
  assert.equal(progress.view("agent", { active: 2, queued: [] })!.slot_ahead, null, "not queued: it has its slot");
});

test("a listener failure never reaches the launch, and memory stays bounded", () => {
  const { progress } = tracker();
  progress.begin("agent", () => { throw new Error("sink"); });
  progress.mark("agent", "prepare");
  assert.equal(progress.view("agent")!.current, "slot_wait");
  for (let index = 0; index < 200; index += 1) progress.begin(`agent-${index}`);
  assert.equal(progress.view("agent"), null);
  assert.ok(progress.view("agent-199"));
});

test("launch errors map to one recovery kind", () => {
  assert.equal(launchFailureAction(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })), "install");
  assert.equal(launchFailureAction(new AggregateError([new Error("spawn /x/claude ENOENT")], "cleanup failed")), "install");
  assert.equal(launchFailureAction(new Error("wrapped", { cause: new Error("401 Unauthorized") })), "sign_in");
  assert.equal(launchFailureAction(new Error("Not logged in · Please run /login")), "sign_in");
  assert.equal(launchFailureAction(new Error("Provider launch did not attest the complete configuration snapshot.")), "retry");
  assert.equal(launchFailureAction(null), "retry");
});
