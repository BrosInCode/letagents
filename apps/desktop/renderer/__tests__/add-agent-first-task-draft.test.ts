import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  defaultSupervisedCharter,
  useAddAgentConfiguration,
} from "../src/components/desktop/content/add-agent/useAddAgentConfiguration";

const controllerSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/add-agent/useAddAgentController.ts",
  import.meta.url,
)), "utf8");

const managerCharter = "You are this room's board manager. Accept proposed tasks and keep the board moving.";

test("a launched first task does not pre-fill the next agent's form", () => {
  const configuration = useAddAgentConfiguration();
  assert.equal(configuration.supervisedCharter.value, defaultSupervisedCharter);

  configuration.supervisedCharter.value = managerCharter;
  configuration.consumeSupervisedCharter(managerCharter);
  assert.equal(configuration.supervisedCharter.value, defaultSupervisedCharter);

  // Surrounding whitespace was trimmed from the request; it is the same task.
  configuration.supervisedCharter.value = `  ${managerCharter}\n`;
  configuration.consumeSupervisedCharter(managerCharter);
  assert.equal(configuration.supervisedCharter.value, defaultSupervisedCharter);
});

test("a first task typed after the click survives the launch it did not start", () => {
  const configuration = useAddAgentConfiguration();
  configuration.supervisedCharter.value = "Review PR #4 and report back.";
  configuration.consumeSupervisedCharter(managerCharter);
  assert.equal(configuration.supervisedCharter.value, "Review PR #4 and report back.");
});

test("the first task is consumed only once the agent is durably saved", () => {
  const body = controllerSource.slice(
    controllerSource.indexOf("async function startManagedAgent("),
    controllerSource.indexOf("  return { roomLabel,"),
  );
  const created = body.indexOf("const entry = await createSupervisedAgentFromSnapshot(");
  const noEntry = body.indexOf("if (!entry) {", created);
  const consumed = body.indexOf("configuration.consumeSupervisedCharter(requestCharter);");
  const staleRequest = body.indexOf("if (!setupActions.isCurrentRequest(requestVersion)) {", noEntry);
  assert.ok(created > 0 && noEntry > created, "the durable create result is checked first");
  assert.ok(consumed > noEntry, "a failed or fenced create keeps the typed task");
  // A provider switch or close during the create still saved an agent with this
  // task, so it is consumed before the stale-request exit as well.
  assert.ok(consumed < staleRequest, "consumed before the stale-request exit");
  assert.equal(body.split("consumeSupervisedCharter(").length - 1, 1);
});
