import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

import {
  CURSOR_WINDOWS_UNSANDBOXED_NOTICE,
  cursorWindowsSandboxNotice,
} from "../src/domain/supervised-agents-support";
import { CURSOR_WINDOWS_UNSANDBOXED_NOTICE as MAIN_NOTICE } from "../../electron/main/agents/cursor-permission-profile";

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

it("says Cursor runs without an operating-system sandbox only when Cursor is chosen on Windows", () => {
  assert.equal(
    cursorWindowsSandboxNotice("cursor", "win32"),
    "On Windows, Cursor runs without an operating-system sandbox. LetAgents still limits it to this room's folder and permissions.",
  );
  assert.equal(cursorWindowsSandboxNotice("cursor", "Win32"), CURSOR_WINDOWS_UNSANDBOXED_NOTICE);
  assert.equal(cursorWindowsSandboxNotice("cursor", "MacIntel"), null);
  assert.equal(cursorWindowsSandboxNotice("codex", "win32"), null);
  assert.equal(cursorWindowsSandboxNotice(null, "win32"), null);
  // Main tells the agent and the ready detail the same words.
  assert.equal(MAIN_NOTICE, CURSOR_WINDOWS_UNSANDBOXED_NOTICE);
});

it("shows the line where Cursor is chosen: the add-agent sheet and the composer's agent chip", () => {
  assert.match(source("components/desktop/content/add-agent/useAddAgentPresentation.ts"), /cursorWindowsSandboxNotice\("cursor"\)/);
  const composer = source("components/desktop/content/room-chat/RoomComposer.vue");
  assert.match(composer, /cursorWindowsSandboxNotice\(agentChip\.value\?\.providerId\)/);
  assert.match(composer, /data-testid="desktop-composer-agent-cursor-windows"/);
});
