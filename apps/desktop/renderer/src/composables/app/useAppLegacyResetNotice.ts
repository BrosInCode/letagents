import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { DesktopSupervisorLegacyStateReset } from "../../../../electron/ipc-types";
import {
  formatLegacyStateResetNotice,
  readDismissedLegacyResetBackup,
  rememberDismissedLegacyResetBackup,
  shouldShowLegacyStateResetNotice,
} from "../../domain/legacy-state-reset-notice";
import { desktopIpc } from "../../ipc/index.js";

/** Surfaces one dismissible app-level notice after a one-time legacy daemon state reset. */
export function useAppLegacyResetNotice(active: Readonly<Ref<boolean>>) {
  const storage = typeof window !== "undefined" ? window.localStorage : null;
  const legacyStateReset = ref<DesktopSupervisorLegacyStateReset | null>(null);
  const dismissedBackupName = ref<string | null>(readDismissedLegacyResetBackup(storage));
  let loaded = false;
  let disposed = false;

  watch(active, (isActive) => {
    if (!isActive || loaded) return;
    loaded = true;
    void Promise.resolve(desktopIpc.supervisor?.getStatus?.())
      .then((status) => {
        if (disposed) return;
        legacyStateReset.value = status?.legacyStateReset ?? null;
      })
      .catch(() => {
        if (!disposed) loaded = false;
      });
  }, { immediate: true });

  onBeforeUnmount(() => {
    disposed = true;
  });

  const legacyStateResetMessage = computed(() => {
    const reset = legacyStateReset.value;
    if (!reset || !shouldShowLegacyStateResetNotice(reset, dismissedBackupName.value)) return null;
    return formatLegacyStateResetNotice(reset);
  });

  function dismissLegacyStateResetNotice(): void {
    const backupName = legacyStateReset.value?.backupName;
    if (!backupName) return;
    dismissedBackupName.value = backupName;
    rememberDismissedLegacyResetBackup(storage, backupName);
  }

  return { legacyStateResetMessage, dismissLegacyStateResetNotice };
}
