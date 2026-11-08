<template>
  <DesktopDialogShell
    :open="Boolean(view)"
    panel-class="company-invite-dialog"
    backdrop-class="desktop-task-modal-backdrop company-invite-backdrop"
    aria-labelledby="company-invite-title"
    :show-close="false"
    :close-disabled="busy"
    initial-focus="#company-invite-title"
    test-id="company-invite-dialog"
    @close="$emit('action', 'close')"
  >
    <CompanyInvitePanel v-if="view" :view="view" :busy="busy" :error="error" heading-id="company-invite-title" @action="$emit('action', $event)">
      <template #close>
        <button type="button" class="company-invite-close" aria-label="Close company link" :disabled="busy" @click="$emit('action', 'close')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
        </button>
      </template>
    </CompanyInvitePanel>
  </DesktopDialogShell>
</template>

<script setup lang="ts">
import DesktopDialogShell from "../content/DesktopDialogShell.vue";
import CompanyInvitePanel from "../../../../../../../shared/ui/company-invite/CompanyInvitePanel.vue";
import type { CompanyInviteAction, CompanyInviteView } from "../../../../../../../shared/ui/company-invite/types";

defineProps<{ view: CompanyInviteView | null; busy: boolean; error: string | null }>();
defineEmits<{ action: [action: CompanyInviteAction] }>();
</script>

<style>
.company-invite-dialog { display: flex; width: min(500px, 100%); min-width: 0; min-height: 0; max-height: calc(100dvh - 48px); border-radius: 17px; outline: none; box-shadow: 0 32px 100px #0006; }
.company-invite-close { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 32px; height: 32px; border: 0; border-radius: 7px; background: transparent; color: var(--invite-muted); }
@media (hover: hover) and (pointer: fine) { .company-invite-close:hover:not(:disabled) { background: var(--invite-hover); } }
@media (max-width: 480px) {
  .desktop-task-modal-backdrop.company-invite-backdrop { padding: 16px; }
  .company-invite-dialog { max-height: calc(100dvh - 32px); }
}
</style>
