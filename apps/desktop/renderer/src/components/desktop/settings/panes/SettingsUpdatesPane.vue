<template>
  <section class="settings-panel settings-updates-panel" data-testid="settings-updates-panel">
    <article
      class="settings-update-card"
      :data-tone="presentation.tone"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div class="settings-update-icon" aria-hidden="true">
        <Download v-if="updateStatus?.phase === 'downloading'" />
        <RefreshCw v-else-if="updateStatus?.phase === 'checking'" />
        <CircleCheck v-else-if="updateStatus?.phase === 'ready' || updateStatus?.phase === 'up-to-date'" />
        <TriangleAlert v-else-if="updateStatus?.phase === 'error'" />
        <Sparkles v-else />
      </div>
      <div class="settings-update-copy">
        <p>Desktop updates</p>
        <h2>{{ presentation.title }}</h2>
        <span>{{ presentation.detail }}</span>
      </div>
      <div class="settings-update-actions">
        <button
          v-if="updateStatus?.canInstall"
          class="primary-button settings-action-button"
          type="button"
          data-testid="install-desktop-update"
          @click="$emit('install')"
        >
          Restart &amp; update
        </button>
        <button
          v-if="updateStatus && updateStatus.phase !== 'unsupported'"
          class="ghost-button settings-action-button"
          type="button"
          :disabled="!updateStatus?.canCheck"
          data-testid="check-desktop-update"
          @click="$emit('check')"
        >
          {{ updateStatus?.phase === "checking" ? "Checking..." : "Check now" }}
        </button>
      </div>
    </article>

    <div class="settings-control-list">
      <SettingsRow
        title="Installed version"
        :description="`LetAgents ${updateStatus?.currentVersion || appInfo?.appVersion || 'version unavailable'}`"
      >
        <template #action>
          <span
            class="state-pill"
            :data-state="updateStatus?.phase === 'unsupported' ? 'away' : 'connected'"
          >
            {{ updateStatus?.phase === "unsupported" ? "development build" : "signed releases" }}
          </span>
        </template>
      </SettingsRow>
      <SettingsRow
        title="Background checks"
        description="Checks at startup and every six hours. Updates download without interrupting your work."
      />
      <SettingsRow
        title="Agent-safe restart"
        description="Before installation, LetAgents stops new agent mutations and retires only the supervisor daemon. Provider processes stay alive so the new app can reconnect to their exact sessions."
      />
    </div>

    <p v-if="lastCheckedLabel" class="settings-privacy-note">
      Last checked {{ lastCheckedLabel }}.
    </p>
  </section>
</template>

<script setup lang="ts">
import { CircleCheck, Download, RefreshCw, Sparkles, TriangleAlert } from "@lucide/vue";
import { computed } from "vue";
import type { DesktopAppInfo, DesktopUpdateStatus } from "../../../../../../electron/ipc-types";
import { desktopUpdatePresentation } from "../../../../domain/desktop-update-status";
import SettingsRow from "../SettingsRow.vue";

const props = defineProps<{
  appInfo: DesktopAppInfo | null;
  updateStatus: DesktopUpdateStatus | null;
}>();

defineEmits<{
  check: [];
  install: [];
}>();

const presentation = computed(() => desktopUpdatePresentation(props.updateStatus));
const lastCheckedLabel = computed(() => {
  if (!props.updateStatus?.lastCheckedAt) return null;
  const checkedAt = new Date(props.updateStatus.lastCheckedAt);
  if (Number.isNaN(checkedAt.valueOf())) return null;
  return checkedAt.toLocaleString();
});
</script>
