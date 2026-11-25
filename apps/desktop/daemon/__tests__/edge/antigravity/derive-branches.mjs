// Derives the two branch files of the `approval` plan from its recorded
// transcript. A manual developer tool, run after redact-capture.mjs; CI never
// runs it.
//
//   node derive-branches.mjs fixtures/approval
//
// The recording allowed the first permission request (write_file) and denied
// the second (run_command). The other two answers were not recorded, so their
// turns are built from frames of the same recording:
//
//   branch-permission-1-deny.ndjson   write_file is refused: the recorded refusal of
//                                     run_command (in_progress, then failed), for the
//                                     write_file call, with a refusal text marked as not
//                                     agy's, and the recorded end of the turn with no text.
//   branch-permission-2-allow.ndjson  run_command is allowed: its in_progress update, a
//                                     completed update shaped as the recorded completed
//                                     write_file, one agent_message_chunk with the
//                                     reply, and the recorded end of the turn.
//
// The reply text and the run_command output are not agy's words. Each branch
// says in its header that it is derived.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DERIVED_REFUSAL = "DERIVED, not agy's words: the write was denied. agy's refusal text for a write was not recorded.";
const DERIVED_REPLY = "Both steps ran: approval-a.txt was written and approval-b.txt was created.";

const planDir = process.argv[2];
if (!planDir) {
  process.stderr.write("agy derive: pass the plan folder\n");
  process.exit(64);
}
const lines = readFileSync(join(planDir, "launch-1.ndjson"), "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
const header = lines[0];
const updateOf = (entry) => entry?.frame?.params?.update;
const at = (label) => {
  const index = lines.findIndex((entry) => entry.label === label);
  if (index < 0) throw new Error(`agy derive: no entry labelled ${label}`);
  return index;
};
const toolUpdates = (callId, status) => lines.filter((entry) => updateOf(entry)?.sessionUpdate === "tool_call_update"
  && updateOf(entry).toolCallId === callId && updateOf(entry).status === status);

const first = lines[at("permission-1")].frame.params.toolCall;
const second = lines[at("permission-2")].frame.params.toolCall;
const promptId = lines[at("prompt")].frame.id;
const turnEnd = lines.find((entry) => entry.type === "emit_inbound" && entry.frame.id === promptId && entry.frame.result?.stopReason);
if (!turnEnd) throw new Error("agy derive: the recording has no end of the turn");
const [refusalStart] = toolUpdates(second.toolCallId, "in_progress");
const [refusal] = toolUpdates(second.toolCallId, "failed");
const [writeDone] = toolUpdates(first.toolCallId, "completed");
if (!refusalStart || !refusal || !writeDone) throw new Error("agy derive: the recording lacks a tool update the branches are made from");

const callFields = (call) => Object.fromEntries(["toolCallId", "name", "args", "kind", "title", "locations", "rawInput"]
  .filter((key) => call[key] !== undefined).map((key) => [key, call[key]]));
const update = (base, fields) => {
  const frame = structuredClone(base.frame);
  const next = { sessionUpdate: "tool_call_update", ...fields };
  frame.params.update = next;
  return { type: "emit_inbound", frame };
};
const start = (scenario, description) => ({
  ...header,
  scenario,
  capture: { ...header.capture, deriver: "apps/desktop/daemon/__tests__/edge/antigravity/derive-branches.mjs", description },
});
const exit = { type: "runtime_exit", requested: true, transportClosedBeforeExit: true, code: 0, signal: null };
const write = (name, entries) => writeFileSync(join(planDir, name), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

const refusalUpdate = updateOf(refusal);
write("branch-permission-1-deny.ndjson", [
  start("approval/branch-permission-1-deny", "DERIVED, not recorded: the turn after write_file is denied. Built from the shape of the recorded refusal of run_command (its text is replaced) and the recorded end of the turn; the token usage is the recorded turn's."),
  update(refusalStart, { ...callFields(first), status: "in_progress" }),
  update(refusal, {
    ...callFields(first),
    status: "failed",
    // agy's refusal text for a write was not recorded; the recorded one names the command.
    rawOutput: DERIVED_REFUSAL,
    ...(refusalUpdate.content ? { content: [{ type: "content", content: { type: "text", text: DERIVED_REFUSAL } }] } : {}),
  }),
  { type: "emit_inbound", label: "turn-end", frame: turnEnd.frame },
  exit,
]);

const message = structuredClone(refusalStart.frame);
message.params.update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: DERIVED_REPLY } };
write("branch-permission-2-allow.ndjson", [
  start("approval/branch-permission-2-allow", "DERIVED, not recorded: the turn after run_command is allowed. Its updates are shaped as the recorded write_file updates; the reply text is not agy's; the token usage is the recorded turn's."),
  update(refusalStart, { ...callFields(second), status: "in_progress" }),
  update(writeDone, { ...callFields(second), status: "completed", rawOutput: {} }),
  { type: "emit_inbound", label: "reply", frame: message },
  { type: "emit_inbound", label: "turn-end", frame: turnEnd.frame },
  exit,
]);
process.stdout.write("agy derive: wrote branch-permission-1-deny.ndjson and branch-permission-2-allow.ndjson\n");
