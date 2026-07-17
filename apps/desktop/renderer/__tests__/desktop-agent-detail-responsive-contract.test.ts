import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const detailModalSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/DesktopAgentDetailModal.vue",
  import.meta.url,
)), "utf8");

const agentManagementStyles = readFileSync(fileURLToPath(new URL(
  "../src/styles/agent-management.css",
  import.meta.url,
)), "utf8");

const desktopWindowSource = readFileSync(fileURLToPath(new URL(
  "../../electron/main/window.ts",
  import.meta.url,
)), "utf8");

test("agent detail modal keeps one viewport-bounded scroll region", () => {
  assert.match(agentManagementStyles, /\.desktop-agent-detail-backdrop\s*\{[^}]*env\(safe-area-inset-top\)[^}]*env\(safe-area-inset-bottom\)/s);
  assert.match(agentManagementStyles, /\.desktop-agent-detail-modal\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)[^}]*max-height:\s*100%[^}]*overflow:\s*hidden/s);
  assert.match(agentManagementStyles, /\.desktop-agent-detail-body\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto[^}]*overscroll-behavior:\s*contain/s);

  const recentItemsRule = agentManagementStyles.match(/\.desktop-agent-detail-recent-items\s*\{([^}]*)\}/s)?.[1] || "";
  assert.doesNotMatch(recentItemsRule, /overflow:\s*(?:auto|scroll)/);
  assert.doesNotMatch(recentItemsRule, /max-height/);
});

test("narrow agent detail layouts preserve reachable controls and wrapping", () => {
  assert.match(agentManagementStyles, /@media \(max-width: 800px\)[\s\S]*\.desktop-agent-detail-body\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(agentManagementStyles, /@media \(max-width: 800px\)[\s\S]*min-width:\s*44px;\s*\n\s*min-height:\s*44px/);
  assert.match(agentManagementStyles, /@media \(max-width: 800px\)[\s\S]*\.desktop-agent-detail-session-inspection\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(agentManagementStyles, /@media \(max-width: 800px\)[\s\S]*\.desktop-agent-turn-control-heading\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(agentManagementStyles, /@media \(max-width: 800px\)[\s\S]*\.desktop-agent-detail-danger-zone\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(agentManagementStyles, /@media \(max-width: 800px\)[\s\S]*\.desktop-agent-detail-danger-actions\s*\{[^}]*width:\s*100%/s);
  assert.match(agentManagementStyles, /@media \(max-width: 800px\)[\s\S]*\.desktop-agent-detail-header h3,[\s\S]*-webkit-line-clamp:\s*2/s);
  assert.match(agentManagementStyles, /\.desktop-agent-detail-header h3\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(agentManagementStyles, /\.desktop-agent-detail-reasoning dd\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test("agent detail accessibility contracts survive responsive reflow", () => {
  assert.match(detailModalSource, /role="dialog"/);
  assert.match(detailModalSource, /aria-modal="true"/);
  assert.match(detailModalSource, /@keydown\.esc\.prevent="emit\('close'\)"/);
  assert.match(detailModalSource, /@keydown\.tab="handleDialogTab"/);
  assert.match(detailModalSource, /aria-label="Close agent detail dialog"/);
  assert.match(detailModalSource, /aria-label="Agent controls"/);
  assert.match(detailModalSource, /class="desktop-agent-detail-agent-actions"\s*role="group"\s*aria-label="Agent controls"/);
  assert.match(detailModalSource, /aria-label="Lifecycle controls"/);
  assert.match(detailModalSource, /data-testid="desktop-agent-detail-stop-agent-zone"/);
  assert.match(agentManagementStyles, /\.desktop-agent-detail-header button:focus-visible/);
  assert.match(agentManagementStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.desktop-agent-detail-status-pulse\[data-state="running"\]::after\s*\{[^}]*animation:\s*none/s);
});

test("Electron smoke exposes a narrow screenshot route for the destructive zone", () => {
  assert.match(desktopWindowSource, /LETAGENTS_DESKTOP_AGENT_DETAIL_SCREENSHOT/);
  assert.match(desktopWindowSource, /window\.resizeTo\(360, 480\)/);
  assert.match(desktopWindowSource, /agentDetailModalNarrowLayout/);
  assert.match(desktopWindowSource, /agentDetailStopZoneNarrowLayout/);
  assert.match(desktopWindowSource, /desktop-agent-detail-stop-agent-zone/);
  assert.match(desktopWindowSource, /deliberately long supervised agent identity/);
  assert.match(desktopWindowSource, /deliberately long provider failure/);
  assert.match(desktopWindowSource, /capturePage\(\)/);
});
