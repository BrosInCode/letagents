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
  assert.match(detailModalSource, /managedAgentDetailSelection\(/);
  assert.match(detailModalSource, /matchingManagedSessions = computed\(\(\) => detailSelection\.value\.managedSessions\)/);
  assert.match(detailModalSource, /matchingSupervisorEntries = computed\(\(\) => detailSelection\.value\.supervisorEntries\)/);
  assert.match(detailModalSource, /providerIdentity = computed\(\(\) => detailSelection\.value\.providerIdentity\)/);
  assert.match(detailModalSource, /v-else-if="detailSelection\.showExternalFallback"/);
  assert.doesNotMatch(detailModalSource, /providerIdentity[^\n]*displayName/);
});
