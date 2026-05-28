import { ref, watch, type Ref } from "vue";
import type {
  DesktopGitHubIntegrationStatus,
  DesktopRoomInfo,
} from "../../../../../../electron/ipc-types";
import {
  desktopBridgeUpgradeMessage,
  getRoomBridge,
} from "./bridge";

export function useDesktopRoomGitHub(options: {
  room: Readonly<Ref<DesktopRoomInfo>>;
  onRoomRenamed(room: DesktopRoomInfo): void;
  refreshRoom(): void;
}) {
  const renameBusy = ref(false);
  const renameError = ref<string | null>(null);
  const githubStatus = ref<DesktopGitHubIntegrationStatus | null>(null);
  const githubLoading = ref(false);
  const githubBusy = ref(false);
  const githubError = ref<string | null>(null);

  watch(
    () => options.room.value.identifier,
    () => {
      void refreshGitHubIntegration();
    },
    { immediate: true },
  );

  async function renameRoom(displayName: string): Promise<void> {
    renameBusy.value = true;
    renameError.value = null;
    try {
      const roomBridge = getRoomBridge();
      if (typeof roomBridge?.rename !== "function") {
        renameError.value = desktopBridgeUpgradeMessage();
        return;
      }
      const updated = await roomBridge.rename(options.room.value.identifier, displayName);
      options.onRoomRenamed(updated);
      options.refreshRoom();
    } catch (error) {
      renameError.value = error instanceof Error ? error.message : "Room could not be renamed.";
    } finally {
      renameBusy.value = false;
    }
  }

  async function refreshGitHubIntegration(): Promise<void> {
    githubLoading.value = true;
    githubError.value = null;
    try {
      const roomBridge = getRoomBridge();
      if (typeof roomBridge?.getGitHubIntegrationStatus !== "function") {
        githubStatus.value = null;
        githubError.value = desktopBridgeUpgradeMessage();
        return;
      }
      githubStatus.value = await roomBridge.getGitHubIntegrationStatus(options.room.value.identifier);
    } catch (error) {
      githubStatus.value = null;
      githubError.value = error instanceof Error ? error.message : "GitHub status could not be checked.";
    } finally {
      githubLoading.value = false;
    }
  }

  async function installGitHubIntegration(): Promise<void> {
    githubBusy.value = true;
    githubError.value = null;
    try {
      const roomBridge = getRoomBridge();
      if (typeof roomBridge?.openGitHubInstall !== "function") {
        githubError.value = desktopBridgeUpgradeMessage();
        return;
      }
      const result = await roomBridge.openGitHubInstall(options.room.value.identifier);
      if (!result.opened) githubError.value = result.message;
    } catch (error) {
      githubError.value = error instanceof Error ? error.message : "GitHub could not be opened.";
    } finally {
      githubBusy.value = false;
    }
  }

  return {
    renameBusy,
    renameError,
    githubStatus,
    githubLoading,
    githubBusy,
    githubError,
    renameRoom,
    refreshGitHubIntegration,
    installGitHubIntegration,
  };
}
