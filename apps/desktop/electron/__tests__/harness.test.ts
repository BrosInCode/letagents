import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { createElectronTestEnv } from "./harness.js";

test("createElectronTestEnv installs standard paths and resetState writes JSON", () => {
  const env = createElectronTestEnv({
    prefix: "letagents-harness-unit-",
    paths: ["state", "chatStorage", "localChatDb", "localProfile"],
    autoCleanup: false,
  });

  try {
    assert.ok(env.statePath);
    assert.ok(env.chatStorageSettingsPath);
    assert.ok(env.localChatDbPath);
    assert.ok(env.localProfilePath);
    assert.equal(process.env.LETAGENTS_STATE_PATH, env.statePath);
    assert.equal(process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH, env.chatStorageSettingsPath);
    assert.equal(process.env.LETAGENTS_LOCAL_CHAT_DB, env.localChatDbPath);
    assert.equal(process.env.LETAGENTS_LOCAL_PROFILE_PATH, env.localProfilePath);

    env.resetState({ room_sessions: {} });
    assert.equal(
      readFileSync(env.statePath!, "utf-8"),
      `${JSON.stringify({ room_sessions: {} }, null, 2)}\n`,
    );
  } finally {
    env.cleanup();
  }

  assert.equal(process.env.LETAGENTS_STATE_PATH, undefined);
  assert.equal(existsSync(env.tempDir), false);
});

test("createElectronTestEnv supports extra env files and cleanup keys", () => {
  const env = createElectronTestEnv({
    prefix: "letagents-harness-extra-",
    paths: ["state"],
    extraEnvFiles: {
      LETAGENTS_AGENT_ATTACHMENTS_DIR: "agent-attachments",
    },
    extraCleanupEnvKeys: ["LETAGENTS_CURSOR_SOURCE_HOME"],
    autoCleanup: false,
  });

  try {
    assert.match(process.env.LETAGENTS_AGENT_ATTACHMENTS_DIR || "", /agent-attachments$/);
    process.env.LETAGENTS_CURSOR_SOURCE_HOME = `${env.tempDir}/cursor-source`;
  } finally {
    env.cleanup();
  }

  assert.equal(process.env.LETAGENTS_AGENT_ATTACHMENTS_DIR, undefined);
  assert.equal(process.env.LETAGENTS_CURSOR_SOURCE_HOME, undefined);
  assert.equal(process.env.LETAGENTS_STATE_PATH, undefined);
});
