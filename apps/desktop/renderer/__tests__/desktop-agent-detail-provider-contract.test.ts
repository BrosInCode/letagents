import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const detailModalSource = readFileSync(fileURLToPath(new URL(
  "../src/components/desktop/content/DesktopAgentDetailModal.vue",
  import.meta.url,
)), "utf8");

test("agent inspector renders the shared provider artwork and accessible exact-bound labels", () => {
  assert.match(detailModalSource, /data-testid="desktop-agent-detail-provider-identity"/);
  assert.match(detailModalSource, /<ProviderBadge :label="providerIdentity\.label" \/>/);
  assert.match(detailModalSource, /:aria-label="`Provider: \$\{providerIdentity\.accessibleLabel\}`"/);
  assert.match(detailModalSource, /data-testid="desktop-agent-detail-managed-provider"/);
  assert.match(detailModalSource, /target\.kind !== "supervised"/);
  assert.match(detailModalSource, /entry\.id === target\.supervisorEntryId/);
  assert.match(detailModalSource, /resolveAgentInspectorManagedSessions\(eligible, props\.target\)/);
  assert.match(detailModalSource, /managedAgentProviderIdentityForEntry\(matchingSupervisorEntries\.value\[0\]\)/);
  assert.match(detailModalSource, /target\.kind === 'external' && showExternalFallback/);
  assert.doesNotMatch(detailModalSource, /managedAgentDetailSelection\(/);
  assert.doesNotMatch(detailModalSource, /providerIdentity[^\n]*displayName/);
});
