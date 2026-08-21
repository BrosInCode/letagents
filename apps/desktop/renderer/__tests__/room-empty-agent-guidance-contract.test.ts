import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const composer = source("../src/components/desktop/content/room-chat/RoomComposer.vue");
const viewport = source("../src/components/desktop/content/room-chat/RoomMessageViewport.vue");
const composerStyles = source("../src/styles/agent-management.css");
const emptyStyles = source("../src/styles/message-content/thread-search-empty.css");

test("the composer has one agent entry point and no duplicate empty-room banner", () => {
  assert.doesNotMatch(composer, /desktop-composer-agent-empty/);
  assert.equal(composer.match(/@click="\$emit\('open-add-agent'\)"/g)?.length, 1);
  assert.match(composer, /data-testid="desktop-composer-add-agent"/);
  assert.match(composer, /:data-needs-agent="Boolean\(roomIdentifier && !hasListeningAgent\)"/);
});

test("the empty room teaches the no-agent mental model and points to the real plus control", () => {
  assert.match(viewport, /:data-agent-guidance="showAgentGuidance \|\| undefined"/);
  assert.match(viewport, /Add an agent before you start/);
  assert.match(viewport, /Room messages don’t start agents on their own/);
  assert.match(viewport, /Use the \+ beside the message box/);
  assert.match(viewport, /participant\.kind === "agent" && participant\.activityState !== "offline"/);
});

test("empty-room guidance is quiet, responsive to reduced motion, and leaves the composer compact", () => {
  assert.doesNotMatch(emptyStyles, /\.room-empty-card \{[\s\S]{0,500}border:\s*1px dashed/);
  assert.match(emptyStyles, /\.room-empty-agent-mark/);
  assert.match(emptyStyles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(composerStyles, /desktop-composer-agent-cue/);
  assert.match(composerStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*desktop-composer-add-agent\[data-needs-agent="true"\]::after/);
});
