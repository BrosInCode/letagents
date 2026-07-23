import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const shell = source("../src/components/desktop/content/DesktopRoomShell.vue");
const activity = source("../src/components/desktop/content/RoomActivityTabView.vue");
const host = source("../src/components/desktop/content/agent-inspector/AgentInspectorHost.vue");
const actions = source("../src/components/desktop/content/agent-inspector/AgentInspectorLifecycleActions.vue");
const surface = source("../src/components/desktop/content/agent-inspector/AgentInspectorSurface.vue");
const statusSurface = source("../src/components/desktop/content/agent-inspector/AgentInspectorStatusSurface.vue");
const participantSurface = source("../src/components/desktop/content/agent-inspector/AgentInspectorParticipantSurface.vue");
const composer = source("../src/components/desktop/content/room-chat/RoomComposer.vue");
const chat = source("../src/components/desktop/content/RoomChatView.vue");
const styles = source("../src/components/desktop/content/agent-inspector/agent-inspector.css");
test("the Inspector is the single selected-agent detail owner after cutover", () => {
  assert.match(shell, /<AgentInspectorHost\s*[\s\S]*v-if="selectedAgentDetailTarget"/);
  assert.doesNotMatch(shell, /agentInspectorFoundationEnabled|DesktopAgentDetailModal|projectAgentInspectorsWhenEnabled/);
  assert.doesNotMatch(activity, /agentInspectorFoundationEnabled|legacyTruthful/);
  assert.equal(existsSync(fileURLToPath(new URL("../src/components/desktop/content/DesktopAgentDetailModal.vue", import.meta.url))), false);
  assert.equal(existsSync(fileURLToPath(new URL("../src/domain/agent-inspector-feature.ts", import.meta.url))), false);
  assert.match(shell, /projectAgentInspectors\(/);
  assert.match(activity, /agentProjections: AgentInspectorProjection\[\]/);
});

test("the Inspector has one exclusive surface for durable, external, loading, error, and ambiguous selections", () => {
  assert.match(host, /AgentInspectorParticipantSurface/);
  assert.match(host, /projectAgentInspectorParticipant\(\s*props\.selection,\s*props\.managedSessions,\s*props\.roomIdentifier\s*\)/);
  assert.match(host, /surfaceComponentType/);
  assert.match(host, /selection\.kind === "resolving"/);
  assert.match(host, /unavailableReason === "load_error"/);
  assert.match(host, /selection\.kind === "external"/);
  assert.match(participantSurface, /Room participant/);
  assert.doesNotMatch(participantSurface, /useManagedAgentSessionsContext/);
  assert.match(participantSurface, /desktopIpc\.workers\.stopManagedAgent/);
  assert.doesNotMatch(participantSurface, /aria-live/);
  assert.doesNotMatch(activity, /v-if="selectedTruthfulAgent" class="desktop-activity-detail"/);
  assert.doesNotMatch(activity, /selectedLegacyTruthfulAgent|selectedTruthfulAgent/);
});

test("Activity opens the exact shared projection only after an explicit click", () => {
  assert.match(activity, /@click="selectInspectorAgent\(agent\)"/);
  assert.match(activity, /supervisedAgentInspectorRequest\(agent\.entry/);
  assert.match(activity, /autoSelectLive: false/);
  assert.match(activity, /watch\(inspectorTruthfulAgents[\s\S]{0,300}selectedTruthfulId\.value = null/);
  assert.match(shell, /:agent-projections="agentInspectorProjections"/);
});

test("Mention uses the canonical composer insertion path and exact agent key", () => {
  assert.match(composer, /function focusWithMention\(mentionText: string\)/);
  assert.match(composer, /defineExpose\(\{ focusWithMention \}\)/);
  assert.match(chat, /function focusComposerWithMention\(mentionText: string\)/);
  assert.match(chat, /defineExpose\(\{ openThread, focusComposerWithMention \}\)/);
  assert.match(shell, /candidate\.agentKey === projection\.agentKey/);
  assert.match(shell, /roomMentionCandidates\(\[participant\]/);
  assert.match(shell, /focusComposerWithMention\(mention\.insertText\)/);
  assert.doesNotMatch(shell, /focusComposerWithDraft\(`@\$\{projection\.displayName\}/);
});

test("wide and compact modes have distinct, accessible spatial behavior", () => {
  assert.match(host, /agent-inspector-host-wide/);
  assert.match(host, /<Teleport v-if="compact" to="body">/);
  assert.match(host, /"presentation-change": \[compact: boolean\]/);
  assert.match(shell, /selectedAgentDetailTarget && !agentInspectorCompact/);
  assert.match(shell, /@presentation-change="agentInspectorCompact = \$event"/);
  assert.match(host, /setShellContentInert/);
  assert.doesNotMatch(host, /getElementById\("app"\)/);
  assert.match(host, /restoreFocusElement = document\.activeElement/);
  assert.match(host, /document\.addEventListener\("keydown", handleHostKeydown, true\)/);
  assert.match(host, /surfaceComponent\.value\?\.focusInitial\(\)/);
  assert.match(host, /previous\[1\] !== isCompact/);
  assert.match(host, /\}, \{ immediate: true \}\);/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) minmax\(360px, 420px\)/);
  assert.match(styles, /\.agent-inspector-surface\[data-compact="true"\] \{\s*position: fixed/);
  assert.doesNotMatch(styles, /transition:\s*all|ease-in/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.match(styles, /prefers-reduced-transparency/);
  assert.match(styles, /prefers-contrast/);
  assert.match(styles, /data-compact="true"\] \.agent-inspector-actions > button/);
  assert.doesNotMatch(styles, /#71717a|var\(--text-tertiary/);
});

test("Escape ownership and replacement focus stay scoped to the inspector", () => {
  assert.match(host, /!compact\.value \|\| event\.key !== "Escape"/);
  assert.match(surface, /!props\.compact && event\.key === "Escape"/);
  assert.match(statusSurface, /!props\.compact && event\.key === "Escape"/);
  assert.match(host, /watch\(surfaceKind[\s\S]{0,180}surfaceComponent\.value\?\.containsFocus\(\)/);
  assert.match(host, /if \(!props\.open \|\| !inspectorOwnedFocus\) return/);
  assert.match(host, /nextTick\(\(\) => surfaceComponent\.value\?\.focusInitial\(\)\)/);
  assert.match(surface, /defineExpose\(\{ focusInitial, containsFocus \}\)/);
  assert.match(statusSurface, /defineExpose\(\{ focusInitial, containsFocus \}\)/);
  assert.match(participantSurface, /!props\.compact && event\.key === "Escape"/);
  assert.match(participantSurface, /defineExpose\(\{ focusInitial, containsFocus \}\)/);
});

test("poll completion cannot remain refreshing after activity arrives", () => {
  assert.doesNotMatch(shell, /onActivity[\s\S]{0,500}supervisorEntriesMutationVersion \+= 1/);
  assert.match(shell, /latest room-scoped poll completed successfully[\s\S]{0,400}supervisorEntriesState\.value = "ready"/);
});

test("action state and compact controls remain entry-scoped and unclipped", () => {
  assert.match(shell, /function openAgentDetailRequest[\s\S]{0,220}agentInspectorActionState\.value = null/);
  assert.match(shell, /:action-state="selectedAgentInspectorActionState"/);
  assert.match(surface, /:compact="compact"/);
  assert.match(actions, /orderedCompactActions\.value\.slice\(0, 2\)/);
  assert.match(actions, /secondaryActions/);
  assert.match(styles, /\.agent-inspector-actions \{[^}]*flex-wrap: wrap/);
});

test("small inspector labels use the accessible secondary text token", () => {
  assert.doesNotMatch(styles, /#71717a|var\(--text-tertiary/);
  assert.match(styles, /var\(--text-secondary, #a1a1aa\)/);
  const luminance = (hex: string) => {
    const channels = hex.match(/[a-f\d]{2}/gi)!.map((part) => Number.parseInt(part, 16) / 255);
    return channels.reduce((sum, channel, index) => {
      const linear = channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
    }, 0);
  };
  const ratio = (luminance("a1a1aa") + 0.05) / (luminance("111112") + 0.05);
  assert.ok(ratio >= 4.5, `expected 4.5:1, received ${ratio.toFixed(2)}:1`);
});

test("Inspector controls keep a 44px minimum interaction target", () => {
  assert.match(styles, /\.agent-inspector-surface button \{ min-height: 44px; \}/);
  assert.match(styles, /\.agent-inspector-tabs button \{[^}]*min-height: 44px/);
  assert.match(styles, /\.agent-inspector-field input, \.agent-inspector-field select, \.agent-inspector-field textarea \{[^}]*min-height: 44px/);
});
