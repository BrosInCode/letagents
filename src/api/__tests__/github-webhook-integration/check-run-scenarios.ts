import assert from "node:assert/strict";

import {
  createRepoRoom,
  postGitHubWebhook,
  webhookIntegrationTest,
} from "./harness.js";
import { buildCheckRunPayload } from "./payloads.js";

webhookIntegrationTest(
  "failed check_run auto-creates and reopens a deduplicated CI task through the real webhook route",
  async (context) => {
    const { getMessages, getTaskById, getTasks, port, updateTask } = context;
    const room = await createRepoRoom(context);

    const firstResult = await postGitHubWebhook({
      port,
      deliveryId: "delivery-check-run-failure-1",
      eventName: "check_run",
      payload: buildCheckRunPayload({
        id: 901,
        name: "ci / build",
        suiteId: 77,
      }),
    });

    assert.equal(firstResult.status, "processed");

    const firstTaskList = await getTasks(room.id);
    assert.equal(firstTaskList.tasks.length, 1);
    const [createdTask] = firstTaskList.tasks;
    assert.equal(createdTask?.title, "Fix CI: ci / build");
    assert.equal(createdTask?.status, "accepted");
    assert.equal(createdTask?.created_by, "letagents");
    assert.deepEqual(createdTask?.workflow_artifacts, [
      {
        provider: "github",
        kind: "check_run",
        number: 77,
        title: "ci / build",
        state: "failure",
      },
      {
        provider: "github",
        kind: "check_run",
        id: "901",
        title: "ci / build",
        url: "https://github.com/BrosInCode/letagents/actions/runs/901",
        state: "failure",
      },
    ]);

    const firstMessages = (await getMessages(room.id)).messages;
    assert.ok(firstMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes(createdTask.id) &&
      message.text.includes("accepted")
    ));
    assert.ok(firstMessages.some((message) =>
      message.sender === "github" &&
      message.text.includes(createdTask.id) &&
      message.text.includes("ci / build")
    ));

    await updateTask(room.id, createdTask.id, { status: "assigned", assignee: "OliveWolf" });
    await updateTask(room.id, createdTask.id, { status: "in_progress" });
    await updateTask(room.id, createdTask.id, { status: "done" });

    const secondResult = await postGitHubWebhook({
      port,
      deliveryId: "delivery-check-run-failure-2",
      eventName: "check_run",
      payload: buildCheckRunPayload({
        id: 902,
        name: "ci / build",
        suiteId: 77,
      }),
    });

    assert.equal(secondResult.status, "processed");

    const secondTaskList = await getTasks(room.id);
    assert.equal(secondTaskList.tasks.length, 1);

    const reopenedTask = await getTaskById(room.id, createdTask.id);
    assert.equal(reopenedTask?.status, "accepted");
    assert.equal(reopenedTask?.assignee, null);
    assert.ok(reopenedTask?.workflow_artifacts.some((artifact) =>
      artifact.kind === "check_run" && artifact.number === 77
    ));
    assert.ok(reopenedTask?.workflow_artifacts.some((artifact) =>
      artifact.kind === "check_run" &&
      artifact.id === "902" &&
      artifact.url === "https://github.com/BrosInCode/letagents/actions/runs/902"
    ));

    const finalMessages = (await getMessages(room.id)).messages;
    assert.ok(finalMessages.some((message) =>
      message.sender === "letagents" &&
      message.text.includes(createdTask.id) &&
      message.text.includes("accepted")
    ));
  }
);
