<template>
  <FirstRunSplashView v-if="showFirstRunSplash" />

  <main v-else-if="showFirstRunGate" class="desktop-onboarding-shell" data-testid="desktop-first-run-onboarding">
    <FirstRunOnboardingView
      :stage="firstRunStage"
      :mcp-state="visibleMcpInstallState"
      :selected-mcp-target-ids="selectedMcpTargetIds"
      :mcp-wizard-step="mcpWizardStep"
      :auth-status="authStatus"
      :busy="mcpInstallBusy || authBusy || loading"
      :auth-busy="authBusy || loading"
      :can-install="setupApiAvailable"
      :feedback="firstRunFeedback"
      :room-selected="firstRunRoomSelected"
      :created-invite-code="firstRunInviteCode"
      :selected-room-name="firstRunRoomSelected ? (rootRoomSnapshot?.room?.displayName || repoName) : null"
      :selected-room-identifier="firstRunRoomSelected ? (rootRoomSnapshot?.roomIdentifier || null) : null"
      :selected-room-access-status="firstRunRoomSelected ? (rootRoomSnapshot?.access.status || null) : null"
      :room-needs-github-access="firstRunRoomSelected && rootRoomSnapshot?.access.status === 'auth_required' && !authStatus?.authenticated"
      @select-target="selectMcpTarget"
      @select-all-targets="selectAllMcpTargets"
      @clear-target-selection="clearMcpTargetSelection"
      @continue-mcp="continueMcpOnboarding"
      @start-setup="startFirstRunSetup"
      @install-targets="installSelectedMcpTargets"
      @continue-to-github="completeMcpOnboarding"
      @start-auth="startAuthFlow"
      @open-verification="openVerification"
      @poll-auth="pollAuthFlow"
      @cancel-auth="cancelAuthFlow"
      @sign-out="signOut"
      @continue-to-room="continueToRoomConfirmation"
      @connect-room-auth="startFirstRunRoomAuth"
      @pick-repo="pickRepoRoom"
      @create-room="createFirstRunInviteRoom"
      @join-room-code="joinRoomCode"
      @back="goBackFirstRun"
      @finish="finishFirstRunOnboarding"
    />
  </main>

  <main
    v-else-if="showSignedOutGate"
    class="desktop-onboarding-shell desktop-signed-out-shell"
    data-testid="desktop-signed-out-gate"
  >
    <DesktopSignedOutView
      :auth-status="authStatus"
      :busy="authBusy || loading"
      :feedback="authFeedback"
      @start-auth="startSignedOutAuthFlow"
      @open-verification="openVerification"
      @poll-auth="pollAuthFlow"
    />
  </main>

  <main
    v-else
    class="desktop-shell"
    :data-sidebar-mode="isSettingsSurface ? 'hidden' : sidebarMode"
    :data-sidebar-resizing="isSidebarResizing"
    :style="desktopShellStyle"
    data-testid="desktop-shell"
  >
    <Transition name="desktop-sidebar">
      <div
        v-show="!isSettingsSurface && sidebarMode !== 'hidden'"
        class="desktop-sidebar-frame"
        :aria-hidden="isSettingsSurface || sidebarMode === 'hidden'"
        :inert="isSettingsSurface || sidebarMode === 'hidden'"
      >
        <DesktopSidebar
          :active-entry="activeEntry"
          :primary-room="currentParentRoom"
          :project-entries="sidebarProjectEntries"
          :reveal-request="sidebarRevealRequest"
          :settings-entry="settingsEntry"
          :rental-request-count="rentalRequestCount"
          :needs-you-count="needsYouCount"
          :messages-unread="messagesUnread"
          :pinned-collapsed="pinnedCollapsed"
          :rooms-collapsed="roomsCollapsed"
          :collapsed-projects="collapsedProjects"
          :selection-active="sidebarSelectionActive"
          :selected-entry-ids="sidebarSelectedEntryIds"
          :batch-action-busy="sidebarBatchActionBusy"
          :update-status="updateStatus"
          :auth-status="authStatus"
          :auth-busy="authBusy || loading"
          @cycle-sidebar="cycleSidebar"
          @new-room="selectNewRoomEntry"
          @open-rent="openRentMarketplace"
          @open-needs-you="openNeedsYou"
          @open-messages="openMessages"
          @open-updates="openUpdatesSurface"
          @open-settings="openSettingsSurface"
          @connect-account="openAccountAuthFlow"
          @sign-out="signOut"
          @archive-room="archiveSidebarRoom"
          @archive-focus-room="archiveSidebarFocusRoom"
          @conclude-focus-room="openSidebarFocusRoomConclusion"
          @mark-room-read="entry => markRoomEntryRead(entry, true)"
          @mark-room-unread="entry => roomUnread.mark(entry.roomIdentifier, latestMessageIdForEntry(entry) || '')"
          @pin-room="togglePinSidebarRoom"
          @rename-room="renameSidebarRoom"
          @start-selection="startSidebarRoomSelection"
          @cancel-selection="cancelSidebarRoomSelection"
          @toggle-entry-selection="toggleSidebarRoomSelection"
          @set-entry-selection="setSidebarRoomSelection"
          @batch-action="handleSidebarBatchAction"
          @select-entry="handleSidebarEntrySelected"
          @set-projects-collapsed="setAllProjectsCollapsed"
          @reorder-parent-room="handleSidebarParentRoomReorder"
          @reorder-child-room="handleSidebarChildRoomReorder"
          @toggle-project="toggleProject"
          @toggle-pinned-collapsed="togglePinnedCollapsed"
          @toggle-rooms-collapsed="toggleRoomsCollapsed"
        />
      </div>
    </Transition>
    <div
      v-if="showSidebarResizeHandle"
      class="sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      :aria-valuemin="sidebarMinWidth"
      :aria-valuemax="sidebarMaxWidth"
      :aria-valuenow="sidebarWidth"
      tabindex="0"
      data-testid="sidebar-resize-handle"
      @pointerdown="startSidebarResize"
      @keydown="handleSidebarResizeKeydown"
    ></div>
    <section class="app-main" :data-room-entry="activeEntry.type === 'room'" :data-messages-entry="activeEntry.type === 'messages'" data-testid="desktop-main">
      <DesktopTopbar
        v-if="activeEntry.type !== 'room' && activeEntry.type !== 'marketplace' && activeEntry.type !== 'messages' && !isSettingsSurface"
        :active-entry="activeEntry"
        :sidebar-mode="sidebarMode"
        :loading="loading"
        @cycle-sidebar="cycleSidebar"
        @show-system="openSettingsSurface"
        @refresh="refresh"
      />

      <PrivateMessages v-if="authStatus?.authenticated && authStatus.account" v-show="activeEntry.type === 'messages'" :key="authStatus.account.id" :api="desktopIpc.conversations" :account-id="authStatus.account.id" :active="activeEntry.type === 'messages'" :open-conversation-id="openConversationId" :open-conversation-nonce="openConversationNonce" @unread="messagesUnread = $event">
        <template v-if="activeEntry.type === 'messages' && sidebarMode === 'hidden'" #navigation>
          <button class="ghost-button sidebar-reveal-button" type="button" aria-label="Show sidebar" title="Show sidebar" data-testid="sidebar-reveal-button" @click="cycleSidebar">
            <svg class="sidebar-toggle-icon" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4.5 3.5h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" />
              <path d="M12.5 3.5v13" />
              <path d="m7.5 7.5 2.5 2.5-2.5 2.5" />
            </svg>
          </button>
        </template>
      </PrivateMessages>
      <AuthOnboardingView
        v-if="activeEntry.type === 'room' && selectedNeedsAccess"
        :sidebar-mode="sidebarMode"
        :access="selectedAccess"
        :auth-status="authStatus"
        :busy="authBusy || loading"
        :feedback="authFeedback"
        :snapshot-pending="authSnapshotPending"
        :room-label="selectedRoomInfo.displayName || selectedRoomInfo.name"
        @start-auth="startAuthFlow"
        @open-verification="openVerification"
        @poll-auth="pollAuthFlow"
        @refresh-room="refresh"
        @sign-out="signOut"
        @cycle-sidebar="cycleSidebar"
      />

      <KeepAlive :max="1">
        <DesktopRoomShell
          :viewer-login="authStatus?.authenticated ? authStatus.account?.login : null"
          v-if="activeEntry.type === 'room' && !selectedNeedsAccess"
          :key="selectedRoomRenderKey"
          :sidebar-mode="sidebarMode"
          :room-loading="selectedSnapshotLoading"
          :room="selectedRoomWithProjectContext"
          :storage="selectedRoomStorage"
          :focus-rooms="selectedFocusRooms"
          :tasks="selectedSnapshot?.tasks || []"
          :participants="selectedSnapshot?.participants || []"
          :participant-hidden-count="selectedSnapshot?.participantHiddenCount || 0"
          :presence="selectedSnapshot?.presence || []"
          :reasoning-sessions="selectedSnapshot?.reasoningSessions || []"
          :live-activity-sessions="selectedSnapshot?.liveActivitySessions || []"
          :recent-activity="selectedSnapshot?.recentActivity || []"
          :room-artifacts="selectedSnapshot?.roomArtifacts || []"
          :room-agent-work="roomAgentWork"
          :room-agent-work-status="roomAgentWorkStatus"
          :room-agent-work-truncated="roomAgentWorkTruncated"
          :board-settings="selectedSnapshot?.boardSettings || null"
          :messages="selectedSnapshot?.messages || []"
          :github-events="selectedSnapshot?.githubEvents || null"
          :source-states="selectedSnapshot?.sourceStates || null"
          :repo-status="repoStatusValue"
          :git-room-matches-active-repo="selectedGitRoomMatchesActiveRepo"
          :durable-project-root-path="selectedRoomProjectRootPath"
          :project-room="selectedRoomIsProject"
          :workers="workers"
          :open-add-agent-requested="openAddAgentAfterRepoPick"
          :notification-reveal-message-id="notificationRevealMessageId"
          :notification-reveal-nonce="notificationRevealNonce"
          :attention-intent="attentionIntent"
          @attention-opened="attentionIntent = null"
          :initial-chat-scroll-position="chatScrollPositionForRoom(selectedRoomInfo.identifier)"
          :on-focus-room-concluded="handleRoomDetailsFocusRoomConcluded"
          @chat-scroll-position="rememberChatScrollPosition"
          @message-sent="handleOwnMessageSent"
          @room-renamed="handleRoomRenamed"
          @task-updated="upsertSelectedTask"
          @refresh-room="handleRoomShellRefresh"
          @message-reveal-unavailable="handleRoomMessageRevealUnavailable"
          :attention="roomAttention"
          @open-inbox="openNeedsYou(selectedRoomInfo.identifier)"
          @open-messages-with="openMessagesWithPerson"
          @open-focus-room="openFocusRoomFromRoomsTab"
          @request-focus-room-conclusion="openRoomDetailsFocusRoomConclusion"
          @cycle-sidebar="cycleSidebar"
          @connect-project="connectActiveRoomProject"
          @choose-worktree="openWorktreeForAgent"
          @open-repo-root="openWorkspaceGitRoom"
          @add-agent-open-request-consumed="openAddAgentAfterRepoPick = false"
        />
      </KeepAlive>

      <SettingsView
        v-if="activeEntry.type === 'system'"
        :account-rooms="settingsAccountRooms"
        :app-info="appInfo"
        :app-agent-actions="appAgentActions"
        :app-agent-busy="appAgentBusy"
        :app-agent-feedback="appAgentFeedback"
        :app-agent-settings="appAgentSettingsStatus"
        :auth-status="authStatus"
        :busy="loading || authBusy"
        :chat-storage-busy="chatStorageBusy"
        :chat-storage-feedback="chatStorageFeedback"
        :chat-storage-settings="chatStorageSettings"
        :chat-storage-available="chatStorageAvailable"
        :feedback="settingsFeedback"
        :initial-pane="settingsPaneForActiveEntry"
        :mcp-install-busy="mcpInstallBusy || loading"
        :mcp-install-feedback="mcpInstallFeedback"
        :mcp-install-state="visibleMcpInstallState"
        :mcp-wizard-step="mcpWizardStep"
        :repo-status="repoStatusValue"
        :room-action-busy-key="settingsRoomActionBusyKey"
        :selected-mcp-target-ids="selectedMcpTargetIds"
        :selected-room-identifier="selectedRoomIdentifier"
        :setup-api-available="setupApiAvailable"
        :workers="workers"
        :update-status="updateStatus"
        @back-mcp="goBackMcpOnboarding"
        @back-to-app="returnFromSettings"
        @clear-mcp-target-selection="clearMcpTargetSelection"
        @continue-mcp="continueMcpOnboarding"
        @delete-room="deleteAccountRoom"
        @finish-mcp="completeMcpOnboarding"
        @install-mcp-targets="installSelectedMcpTargets"
        @check-update="checkDesktopUpdate"
        @install-update="installDesktopUpdate"
        @leave-room="leaveAccountRoom"
        @open-room="openAccountRoomFromSettings"
        @open-agent="openServiceAgent"
        @restore-room="restoreAccountRoom"
        @select-all-mcp-targets="selectAllMcpTargets"
        @select-mcp-target="selectMcpTarget"
        @save-app-agent-settings="saveAppAgentSettings"
        @set-chat-storage-mode="setChatStorageMode"
        @sync-local-chat="syncLocalChat"
        @toggle-pin-room="toggleAccountRoomPin"
        @refresh="refreshSettingsSurface"
        @sign-out="signOut"
        @start-auth="openAccountAuthFlow"
      />

      <InboxView v-else-if="activeEntry.type === 'inbox'" :key="authStatus?.account?.id ?? 'local'" :rooms="inboxRooms" @update:rooms="chooseInboxRooms" v-model:section="inboxSection" :storage-key="inboxStorageKey" :data="needsYouData" :attention="agentAttentionItems" :loading="needsYouLoading" :error="needsYouError" :rentals="inboxRentals" :rental-error="inboxRentalError" @refresh="refreshNeedsYou" @open-room="openNeedsYouRoom" @open-rental="openRentalRequestInbox" @threads-loaded="mergeInboxThreads" />

      <RentMarketplaceView
        v-else-if="activeEntry.type === 'marketplace'"
        :rooms="settingsAccountRooms"
        :initial-role="rentMarketplaceRole"
      />

    </section>

    <DesktopAppAgent
      v-if="appAgentSettingsStatus?.enabled === true && activeEntry.type !== 'messages'"
      :active-room-display-name="selectedRoomInfo.displayName || activeEntry.title"
      :active-room-identifier="selectedRoomIdentifier || selectedRootRoomIdentifier"
      :active-room-pinned="activeEntry.type === 'room' && activeEntry.pinned"
      :active-room-git-room="selectedRoomInfo.gitRoom"
      :busy="appAgentBusy"
      :result="appAgentResult"
      :settings-status="appAgentSettingsStatus"
      @clear-result="appAgentResult = null"
      @open-settings="openAppAgentSettings"
      @run="runAppAgent"
    />

    <Transition name="new-room-modal">
      <DesktopNewRoomModal
        v-if="newRoomModalOpen"
        v-model:join-code="newRoomJoinCode"
        v-model:room-name="newRoomName"
        v-model:storage="newRoomStorage"
        :step="newRoomStep"
        :busy="newRoomBusy"
        :can-dismiss="newRoomCanDismiss"
        :active-action="newRoomActiveAction"
        :feedback="newRoomFeedback"
        :feedback-state="newRoomFeedbackState"
        v-model:project-path="newRoomProjectPath"
        v-model:project-name="newRoomProjectName"
        v-model:project-parent="newRoomProjectParent"
        :project-creation-error="newRoomProjectCreationError"
        :project-selection="newRoomProjectSelection"
        :project-path-error="newRoomProjectPathError"
        :recent-project-folders="newRoomRecentProjectFolders"
        :success="newRoomSuccess"
        :status-message="newRoomStatusMessage"
        :join-error="newRoomJoinError"
        :can-submit-join="canSubmitJoin"
        :can-submit-standalone="canSubmitStandalone"
        @back="backFromSubstep"
        @choose-join="chooseJoinIntent"
        @choose-project="chooseProjectIntent"
        @choose-new-project="chooseNewProjectIntent"
        @choose-standalone="chooseStandaloneIntent"
        @close="closeNewRoomModal"
        @confirm-project="confirmProjectRoomFromModal"
        @copy-code="copyInviteCode"
        @create-standalone="createStandaloneRoom"
        @create-project="createProjectRoomFromModal"
        @pick-project-parent="pickNewProjectParent"
        @dismiss-success="dismissSuccess"
        @open-project="openProjectRoomFromModal"
        @open-project-path="openProjectRoomFromPath"
        @open-success="openSuccessRoom"
        @join="joinRoomCodeFromModal"
        @retry="retryLastAction"
      />
    </Transition>

    <SidebarFocusRoomConclusionDialog
      :open="Boolean(sidebarFocusRoomConclusionTarget)"
      :entry="sidebarFocusRoomConclusionTarget"
      :busy="sidebarFocusRoomConclusionBusy"
      :error="sidebarFocusRoomConclusionError"
      :fallback-focus-entry-id="sidebarFocusRoomConclusionReturnFocusId"
      @close="closeSidebarFocusRoomConclusion"
      @submit="submitSidebarFocusRoomConclusion"
      @after-leave="handleSidebarFocusRoomConclusionAfterLeave"
    />

    <SidebarRoomBatchActionDialog
      :open="Boolean(sidebarBatchDialogAction)"
      :action="sidebarBatchDialogAction"
      :entries="sidebarBatchDialogTargets"
      :busy="Boolean(sidebarBatchActionBusy)"
      :error="sidebarBatchDialogError"
      @close="closeSidebarBatchDialog"
      @confirm="confirmSidebarBatchAction"
      @after-leave="handleSidebarBatchDialogAfterLeave"
    />

    <DesktopDeviceAuthDialog
      :open="authDialogOpen"
      :auth-status="authStatus"
      :busy="authBusy"
      :feedback="authFeedback"
      @close="authDialogOpen = false"
      @start-auth="startAuthFlow"
      @open-verification="openVerification"
      @poll-auth="pollAuthFlow"
    />

    <div
      class="desktop-action-toasts"
      role="status"
      :aria-live="actionToasts.some((toast) => toast.state === 'error') ? 'assertive' : 'polite'"
      data-testid="desktop-action-toasts"
    >
      <button
        v-for="toast in actionToasts"
        :key="toast.id"
        type="button"
        class="desktop-action-toast"
        :data-state="toast.state"
        @click="dismissActionToast(toast.id)"
      >
        {{ toast.message }}
      </button>
    </div>
  </main>
</template>

<script setup lang="ts">
import type { ChatScrollPosition } from "./domain/chat-scroll";
import { roomUnread } from "./composables/roomUnread";
import PrivateMessages from "../../../../shared/ui/PrivateMessages.vue";
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, watch } from "vue";
import type {
  DesktopAppAgentRunInput,
  DesktopAppAgentRunResult,
  DesktopAppAgentSaveSettingsInput,
  DesktopChatStorageSettings,
  DesktopRoomSnapshot,
  RepoStatus,
} from "../../electron/ipc-types";
import DesktopSidebar from "./components/desktop/sidebar/DesktopSidebar.vue";
import SidebarFocusRoomConclusionDialog from "./components/desktop/sidebar/SidebarFocusRoomConclusionDialog.vue";
import SidebarRoomBatchActionDialog from "./components/desktop/sidebar/SidebarRoomBatchActionDialog.vue";
import DesktopTopbar from "./components/desktop/content/DesktopTopbar.vue";
import { preserveRoomRepoStatistics } from "./domain/repo-status";
import DesktopRoomShell from "./components/desktop/content/DesktopRoomShell.vue";
import DesktopNewRoomModal from "./components/desktop/content/DesktopNewRoomModal.vue";
import DesktopDeviceAuthDialog from "./components/desktop/content/DesktopDeviceAuthDialog.vue";
import DesktopAppAgent from "./components/desktop/app-agent/DesktopAppAgent.vue";
import AuthOnboardingView from "./components/desktop/content/AuthOnboardingView.vue";
import DesktopSignedOutView from "./components/desktop/content/DesktopSignedOutView.vue";
import { isAuthSnapshotPending } from "./components/desktop/content/auth-onboarding";
import SettingsView from "./components/desktop/content/SettingsView.vue";
import FirstRunOnboardingView from "./components/desktop/setup/FirstRunOnboardingView.vue";
import FirstRunSplashView from "./components/desktop/setup/FirstRunSplashView.vue";
import { activeRepoRoomContext, resolveActiveProjectRootPath } from "./domain/room-project-context";
import { useDesktopAccountRoomSettings } from "./composables/useDesktopAccountRoomSettings";
import { useDesktopAppData } from "./composables/useDesktopAppData";
import { useDesktopNewRoomModal } from "./composables/useDesktopNewRoomModal";
import { useDesktopRoomLiveSync } from "./composables/useDesktopRoomLiveSync";
import { useDesktopSetupOnboarding } from "./composables/useDesktopSetupOnboarding";
import { loadRentalProviderDashboard, useRentalProviderEvents } from "./composables/useRentalProviderEvents";
import { chatScrollPositionKey, shouldRememberChatScrollPosition } from "./domain/chat-scroll";
import { appAgentEntry, rentMarketplaceEntry, settingsEntry } from "./domain/desktop-navigation";
import { safeUserVisibleErrorDetail } from "./domain/user-visible-error";
import { normalizeRoomIdentifier, rememberRecentRootRooms } from "./domain/sidebar-rooms";
import { promoteSidebarProject, replaceSidebarProjectId, rememberSidebarRoomOrder } from "./domain/sidebar-room-order";
import {
  appAgentArchivedRoomIdentifiers,
  appAgentRefreshTargets,
} from "./domain/app-agent";
import { openManagedAgentWorktree } from "./domain/managed-agent-worktrees";
import { ACCOUNT_ROOMS_REFRESH_WHILE_STREAMING_MS } from "./domain/account-activity";
import type { AttentionNavigationIntent } from "./components/desktop/content/room-shell/types";
import InboxView from "./components/desktop/content/InboxView.vue";
import { desktopIpc } from "./ipc/index.js";
import { roomAliasSet, roomMatchesAliases } from "./domain/app-room-aliases";
import type { AppContext } from "./composables/app/context";
import { useAppState } from "./composables/app/useAppState";
import { useAppInboxActions, useAppInboxState, useAppRoomAttention } from "./composables/app/useAppInbox";
import { useAppSidebarLayout } from "./composables/app/useAppSidebarLayout";
import { useAppSidebarMessages, useAppAccountActivityFeed, useAppReadMarkers, useAppHistoryWatchers } from "./composables/app/useAppSidebarMessages";
import { useAppSidebarSelection, useAppSidebarEntries } from "./composables/app/useAppSidebarSelection";
import { useAppFocusRoomConclusion } from "./composables/app/useAppFocusRoomConclusion";
import { useAppSessionActions, useAppAccountScope, useAppAuthFlow, useAppAccountSwitch, useAppAuthWatchers } from "./composables/app/useAppSession";
import { useAppNavigation, useAppRoomContext, useAppSelectionWatchers } from "./composables/app/useAppNavigation";

const RentMarketplaceView = defineAsyncComponent(
  () => import("./components/desktop/content/RentMarketplaceView.vue"),
);

// App.vue holds the template and this wiring. The context fills in the original
// order: state, then the function composables (only function definitions, like
// the hoisted declarations they came from), then each watcher and composable
// slice exactly where its code used to run.
const app = {} as AppContext;
const {
  loading, appInfo, updateStatus, repoStatus, workers, rootRoomSnapshot, selectedSnapshot,
  authStatus, sessionGeneration, authDialogOpen, recentRootRoomsStorageKey,
  legacyRepositoryRootBindingsStorageKey, sidebarRoomOrderStorageKey, sidebarMinWidth,
  sidebarMaxWidth, SIDEBAR_METADATA_REFRESH_INTERVAL_MS, selectedRootRoomIdentifier,
  recentRootRooms, newRoomRecentProjectFolders, legacyRepositoryRootBindings, projectBindings,
  sidebarWidth, sidebarRoomOrder, sidebarRevealRequest, isSidebarResizing, sidebarLatestMessages,
  chatScrollPositionsByRoom, loadingChatScrollRoomIdentifiers, accountRooms, settingsAccountRooms,
  sidebarMetadataRefresh, rentalRequestCount, inboxRentals, inboxRentalError, messagesUnread,
  openConversationId, openConversationNonce, inboxSection, attentionIntent, rentMarketplaceRole,
  openAddAgentAfterRepoPick, notificationRevealMessageId, notificationRevealNonce,
  chatStorageSettings, chatStorageAvailable, chatStorageBusy, chatStorageFeedback,
  appAgentSettingsStatus, appAgentActions, appAgentBusy, appAgentResult, appAgentFeedback,
  diagnostics, mcpInstallState, selectedMcpTargetIds, mcpInstallBusy, mcpInstallFeedback,
  setupLoadError, mcpWizardStep, firstRunStage, sidebarFocusRoomConclusionTarget,
  sidebarFocusRoomConclusionReturnFocusId, sidebarFocusRoomConclusionError, sidebarSelectionActive,
  sidebarSelectedEntryIds, sidebarBatchActionBusy, sidebarBatchDialogAction,
  sidebarBatchDialogTargets, sidebarBatchDialogError,
} = Object.assign(app, useAppState());
const {
  openMessages, openMessagesWithPerson, openNeedsYouRoom, openNeedsYou, refreshNeedsYou,
} = Object.assign(app, useAppInboxActions(app));
const {
  isSettingsSurface, showSidebarResizeHandle, desktopShellStyle, cycleSidebar,
  settingsPaneForActiveEntry, openSettingsSurface, openUpdatesSurface, startSidebarResize,
  handleSidebarResizeKeydown, setAllProjectsCollapsed, handleSidebarParentRoomReorder,
  handleSidebarChildRoomReorder,
} = Object.assign(app, useAppSidebarLayout(app));
const {
  refreshSidebarRoomMetadata, refreshSidebarLatestMessages, roomHistoryMode,
  sidebarRoomIdentifiers, latestMessageIdForEntry, markActiveRoomRead, markRoomEntryRead,
} = Object.assign(app, useAppSidebarMessages(app));
const {
  handleSidebarEntrySelected, startSidebarRoomSelection, cancelSidebarRoomSelection,
  toggleSidebarRoomSelection, setSidebarRoomSelection, openFocusRoomFromRoomsTab,
  handleSidebarBatchAction, closeSidebarBatchDialog, confirmSidebarBatchAction,
  handleSidebarBatchDialogAfterLeave,
} = Object.assign(app, useAppSidebarSelection(app));
const {
  handleRoomDetailsFocusRoomConcluded, sidebarFocusRoomConclusionBusy,
  openSidebarFocusRoomConclusion, openRoomDetailsFocusRoomConclusion,
  closeSidebarFocusRoomConclusion, submitSidebarFocusRoomConclusion,
  handleSidebarFocusRoomConclusionAfterLeave,
} = Object.assign(app, useAppFocusRoomConclusion(app));
const {
  refreshForegroundData, handleVisibilityChange, handleWindowFocus, handleWindowBlur,
  handleDesktopRoomStreamEvent, startSignedOutAuthFlow, openAccountAuthFlow, startFirstRunRoomAuth,
  handleNotificationActivation,
} = Object.assign(app, useAppSessionActions(app));
// Functions still in App.vue are hoisted, so they join the context first.
Object.assign(app, {
  activeProjectRootPath, refreshProjectBindings, restartRepoStatusWatch, refreshRentalRequestCount,
  leaveArchivedRoomIfActive, openRoomFromAppAgent, forgetLoadingChatScrollRooms,
  activeChatScrollRoomIdentifier,
});

Object.assign(app, useAppAccountScope(app));

const {
  accountActivity,
} = Object.assign(app, useAppAccountActivityFeed(app));

const {
  needsYouData, needsYouLoading, needsYouError, mergeInboxThreads, agentAttentionItems,
  needsYouCount, inboxStorageKey, inboxRooms, chooseInboxRooms,
} = Object.assign(app, useAppInboxState(app));

let needsYouInterval: number | null = null;

const {
  activeEntry, collapsedProjects, currentParentRoom, openRoomSnapshot, pinnedCollapsed, pinnedRoom,
  projectEntries, reconcileActiveEntry, rememberRootRoomSnapshot, repoName,
  resolveSelectedRoomIdentifier, roomsCollapsed, returnFromSettings, selectedAccess,
  selectedFocusRooms, selectedNeedsAccess, selectedRoomIdentifier, selectedRoomInfo, sidebarMode,
  toggleProject, togglePinnedCollapsed, toggleRoomsCollapsed,
} = Object.assign(app, useAppNavigation(app));

const {
  roomAttention,
} = Object.assign(app, useAppRoomAttention(app));

let unsubscribeRoomStream: (() => void) | null = null;

let unsubscribeOpenSettings: (() => void) | null = null;

let unsubscribeOpenUpdates: (() => void) | null = null;

let unsubscribeUpdateStatus: (() => void) | null = null;

let unsubscribeNotificationReceived: (() => void) | null = null;

let unsubscribeNotificationActivation: (() => void) | null = null;

let unsubscribeRepoStatusChanged: (() => void) | null = null;

let accountRoomsRefreshInterval: number | null = null;

let repoStatusRefreshInFlight = false;

let repoStatusWatchRootPath: string | null = null;

let repoStatusWatchRequestId = 0;

const {
  actionToasts, dismissActionToast, pushActionToast, selectedRoomWithProjectContext,
  selectedGitRoomMatchesActiveRepo, selectedRoomProjectRootPath, selectedRoomIsProject,
} = Object.assign(app, useAppRoomContext(app));

Object.assign(app, useAppReadMarkers(app));

const {
  refreshUnreadCounts, sidebarProjectEntries, selectedRoomRenderKey, selectedRoomStorage,
} = Object.assign(app, useAppSidebarEntries(app));

async function refreshActiveRepoStatus(): Promise<void> {
  if (showFirstRunGate.value || !authStatus.value?.authenticated || repoStatusRefreshInFlight) return;
  const rootPath = activeProjectRootPath();
  if (!rootPath) return;
  repoStatusRefreshInFlight = true;
  const generation = sessionGeneration.value;
  try {
    const nextRepoStatus = await desktopIpc.repos.getStatus(rootPath).catch(() => null);
    if (generation === sessionGeneration.value && authStatus.value?.authenticated && nextRepoStatus) {
      repoStatus.value = nextRepoStatus;
    }
  } finally {
    repoStatusRefreshInFlight = false;
  }
}

function activeProjectRootPath(): string | null {
  // Derive the project context from the sidebar group that actually contains the
  // active room, NOT the last-opened global root snapshot (which can be a stale,
  // unrelated non-repo room). This is what keeps a focus room attached to its
  // real repo project. Fall back to the global root only when the active entry is
  // in no repo-backed group.
  const context = activeRepoRoomContext(activeEntry.value?.id, projectEntries.value);
  // Presence-based, not nullish: if the active room IS in a group, that group is
  // authoritative even when it's a non-repo group (null identifier/gitRoom) — a
  // grouped non-repo room must not inherit a stale repo snapshot. Fall back to the
  // global root only when the active entry is in no group at all.
  return resolveActiveProjectRootPath({
    activeRootIdentifier: context
      ? context.roomIdentifier
      : selectedRootRoomIdentifier.value ?? rootRoomSnapshot.value?.roomIdentifier,
    activeRootGitRoom: context
      ? context.gitRoom
      : rootRoomSnapshot.value?.room?.gitRoom ?? null,
    projectBindings: projectBindings.value,
  });
}

async function refreshProjectBindings(): Promise<void> {
  if (!desktopIpc.repos?.listProjectBindings) return;
  const generation = sessionGeneration.value;
  const nextBindings = await desktopIpc.repos.listProjectBindings().catch(() => projectBindings.value);
  if (generation !== sessionGeneration.value) return;
  projectBindings.value = nextBindings;
}

async function initializeProjectBindings(): Promise<void> {
  const generation = sessionGeneration.value;
  if (!desktopIpc.repos?.migrateProjectBindings) {
    await refreshProjectBindings();
    return;
  }
  const candidates = [
    ...Object.entries(legacyRepositoryRootBindings).map(([roomIdentifier, rootPath]) => ({
      legacyKey: roomIdentifier,
      context: { roomIdentifier },
      rootPath,
    })),
    ...recentRootRooms.value.flatMap((room) => room.rootPath ? [{
      context: { roomIdentifier: room.identifier },
      rootPath: room.rootPath,
    }] : []),
  ];
  try {
    const migration = await desktopIpc.repos.migrateProjectBindings(candidates);
    if (generation !== sessionGeneration.value) return;
    projectBindings.value = migration.bindings;
    const retryBindings = Object.fromEntries(
      migration.retryLegacyKeys.flatMap((key) => {
        const rootPath = legacyRepositoryRootBindings[key];
        return rootPath ? [[key, rootPath]] : [];
      }),
    );
    if (Object.keys(retryBindings).length) {
      window.localStorage.setItem(
        legacyRepositoryRootBindingsStorageKey,
        JSON.stringify(retryBindings),
      );
    } else {
      window.localStorage.removeItem(legacyRepositoryRootBindingsStorageKey);
    }
  } catch {
    if (generation !== sessionGeneration.value) return;
    await refreshProjectBindings();
  }
}

async function restartRepoStatusWatch(rootPath: string | null): Promise<void> {
  if (!desktopIpc.repos?.startStatusWatch) return;
  const nextRootPath = rootPath?.trim() || null;
  if (repoStatusWatchRootPath === nextRootPath) return;
  const requestId = ++repoStatusWatchRequestId;
  repoStatusWatchRootPath = nextRootPath;
  await desktopIpc.repos.stopStatusWatch?.().catch(() => undefined);
  if (requestId !== repoStatusWatchRequestId || repoStatusWatchRootPath !== nextRootPath) return;
  if (!nextRootPath) return;
  const nextStatus = await desktopIpc.repos.startStatusWatch(nextRootPath).catch(() => null);
  if (requestId === repoStatusWatchRequestId && nextStatus && activeProjectRootPath() === nextRootPath) {
    repoStatus.value = nextStatus;
  }
}

function handleRepoStatusChanged(nextStatus: RepoStatus): void {
  const rootPath = activeProjectRootPath();
  if (rootPath && nextStatus.rootPath !== rootPath) return;
  repoStatus.value = nextStatus;
}

function openRentMarketplace(): void {
  rentMarketplaceRole.value = "renter";
  activeEntry.value = rentMarketplaceEntry;
}

function openRentalRequestInbox(): void {
  rentMarketplaceRole.value = "provider";
  activeEntry.value = rentMarketplaceEntry;
}

async function refreshRentalRequestCount(): Promise<void> {
  if (!authStatus.value?.authenticated || authSessionLocked.value) {
    rentalRequestCount.value = 0; inboxRentals.value = []; inboxRentalError.value = '';
    return;
  }
  if (!desktopIpc.rental?.getProviderDashboard) return;
  const generation = sessionGeneration.value;
  const accountId = authStatus.value?.account?.id;
  try {
    const dashboard = await loadRentalProviderDashboard();
    if (generation !== sessionGeneration.value || accountId !== authStatus.value?.account?.id || !authStatus.value?.authenticated) return;
    inboxRentals.value = Array.isArray(dashboard.pendingRequests) ? dashboard.pendingRequests : [];
    rentalRequestCount.value = inboxRentals.value.length; inboxRentalError.value = '';
  } catch {
    if (generation !== sessionGeneration.value || accountId !== authStatus.value?.account?.id) return;
    rentalRequestCount.value = 0; inboxRentals.value = []; inboxRentalError.value = 'Rental requests could not be checked.';
  }
}

useRentalProviderEvents(() => {
  void refreshRentalRequestCount();
});

async function openWorkspaceGitRoom(rootPathOverride?: string): Promise<boolean> {
  const rootPath = rootPathOverride || repoStatus.value?.rootPath || activeProjectRootPath();
  if (!rootPath) return false;
  loading.value = true;
  try {
    const selection = await desktopIpc.repos.openRoom(rootPath);
    if (selection.error || !selection.snapshot) {
      return false;
    }
    if (selection.repoStatus) {
      repoStatus.value = preserveRoomRepoStatistics(repoStatus.value, selection.repoStatus);
    }
    openRoomSnapshot(selection.snapshot, {
      aliasIdentifiers: [selection.roomIdentifier],
      rootPath: selection.repoPath || rootPath,
      kind: "project",
      meta: selection.repoStatus?.branch || null,
    });
    return true;
  } catch (error) {
    console.warn("Could not open the matching Git Room.", error);
    return false;
  } finally {
    loading.value = false;
  }
}

Object.assign(app, useAppHistoryWatchers(app));

const {
  clearLiveMetadataRefreshInterval,
  clearLiveMetadataRefreshTimer,
  clearSelectedRoomAgentWork,
  invalidateSelectedRoomAgentWork,
  refreshSelectedRoomLiveMetadata,
  roomAgentWork,
  roomAgentWorkStatus,
  roomAgentWorkTruncated,
  scheduleLiveMetadataRefresh,
  syncSelectedRoomStream: syncDesktopRoomStream,
} = useDesktopRoomLiveSync({
  accountId: computed(() => authStatus.value?.account?.id || null),
  rootRoomSnapshot,
  selectedRoomIdentifier,
  selectedSnapshot,
  sessionGeneration,
  workers,
});
Object.assign(app, { clearLiveMetadataRefreshInterval, clearLiveMetadataRefreshTimer, clearSelectedRoomAgentWork, invalidateSelectedRoomAgentWork, refreshSelectedRoomLiveMetadata });

const {
  clearSelectedSnapshotCache,
  handleMessageSent,
  handleRefreshRoom,
  handleRoomRenamed,
  handleRoomStreamEvent,
  invalidateSession,
  refresh,
  refreshAccountRooms,
  refreshSelectedSnapshot,
  repoStatusValue,
  selectedSnapshotLoading,
  syncSelectedRoomStream,
  upsertSelectedTask,
} = useDesktopAppData({
  accountRooms,
  activeEntry,
  appInfo,
  authStatus,
  currentParentRoom,
  diagnostics,
  loading,
  mcpInstallState,
  reconcileActiveEntry,
  rememberRootRoomSnapshot,
  recentRootRooms,
  repoStatus,
  resolveSelectedRoomIdentifier,
  rootRoomSnapshot,
  scheduleLiveMetadataRefresh,
  sessionGeneration,
  selectedMcpTargetIds,
  selectedRootRoomIdentifier,
  selectedSnapshot,
  settingsAccountRooms,
  syncRoomStream: syncDesktopRoomStream,
  workers,
});
Object.assign(app, { handleRoomStreamEvent, invalidateSession, refresh, refreshAccountRooms, refreshSelectedSnapshot, selectedSnapshotLoading, syncSelectedRoomStream });

const authSnapshotPending = computed(() =>
  isAuthSnapshotPending({
    rootLoading: loading.value,
    selectedLoading: selectedSnapshotLoading.value,
    hasSnapshot: Boolean(selectedSnapshot.value),
  }),
);

const {
  authBusy, authFeedback, authSessionLocked, cancelAuthFlow, clearAuthPollTimer, openVerification,
  pollAuthFlow, signOut, startAuthFlow,
} = Object.assign(app, useAppAuthFlow(app));

const {
  showSignedOutGate,
} = Object.assign(app, useAppAccountSwitch(app));

const {
  backFromSubstep,
  canSubmitJoin,
  canSubmitStandalone,
  chooseJoinIntent,
  chooseProjectIntent,
  chooseNewProjectIntent,
  chooseStandaloneIntent,
  closeNewRoomModal,
  confirmProjectRoomFromModal,
  copyInviteCode,
  createStandaloneRoom,
  createProjectRoomFromModal,
  dismissSuccess,
  joinRoomCodeFromModal,
  newRoomActiveAction,
  newRoomBusy,
  newRoomCanDismiss,
  newRoomFeedback,
  newRoomFeedbackState,
  newRoomJoinCode,
  newRoomJoinError,
  newRoomModalOpen,
  newRoomName,
  newRoomProjectPath,
  newRoomProjectName,
  newRoomProjectParent,
  newRoomProjectCreationError,
  newRoomProjectPathError,
  newRoomProjectSelection,
  newRoomStatusMessage,
  newRoomStep,
  newRoomStorage,
  newRoomSuccess,
  openProjectRoomFromModal,
  openProjectRoomFromPath,
  pickNewProjectParent,
  openSuccessRoom,
  retryLastAction,
  selectNewRoomEntry,
} = useDesktopNewRoomModal({
  openRoomSnapshot: (snapshot, options) => {
    openRoomSnapshot(snapshot, options);
    if (options?.kind !== "project") return;
    const entryId = activeEntry.value.id;
    const project = sidebarProjectEntries.value.find((candidate) =>
      [candidate.parent, ...candidate.branchRooms, ...candidate.focusRooms]
        .some((entry) => entry.id === entryId));
    if (project) {
      const order = promoteSidebarProject(sidebarProjectEntries.value, sidebarRoomOrder.value, project.id);
      if (order) {
        sidebarRoomOrder.value = order;
        rememberSidebarRoomOrder(window.localStorage, sidebarRoomOrderStorageKey, order);
      }
    }
    sidebarMode.value = "expanded";
    sidebarRevealRequest.value = {
      entryId,
      sequence: (sidebarRevealRequest.value?.sequence || 0) + 1,
    };
  },
  setRepoStatus: (status) => {
    if (status) repoStatus.value = preserveRoomRepoStatistics(repoStatus.value, status);
  },
  getDefaultStorageMode: () =>
    chatStorageSettings.value?.defaultMode === "local" || chatStorageSettings.value?.mode === "local"
      ? "local"
      : "cloud",
});

const {
  batchConcludeSidebarFocusRooms,
  batchHideSidebarRooms,
  batchSetSidebarRoomsPinned,
  archiveSidebarFocusRoom,
  archiveSidebarRoom,
  concludeSidebarFocusRoom,
  deleteAccountRoom,
  leaveAccountRoom,
  openAccountRoomFromSettings,
  refreshSettings,
  renameSidebarRoom,
  restoreAccountRoom,
  settingsFeedback,
  settingsRoomActionBusyKey,
  toggleAccountRoomPin,
  togglePinSidebarRoom,
} = useDesktopAccountRoomSettings({
  accountRooms,
  activeEntry,
  loading,
  recentRootRooms,
  recentRootRoomsStorageKey,
  rootRoomSnapshot,
  selectedRootRoomIdentifier,
  selectedSnapshot,
  settingsAccountRooms,
  settingsEntry,
  openRoomSnapshot: (snapshot, options) => openRoomSnapshot(snapshot, options),
  refresh: () => refresh(),
  refreshAccountRooms: () => refreshAccountRooms(),
  onRoomArchived: async (roomIdentifier, displayName) => {
    await leaveArchivedRoomIfActive(roomIdentifier, displayName);
  },
  onRoomRenamed: (room) => {
    if (normalizeRoomIdentifier(room.identifier) === normalizeRoomIdentifier(selectedRoomIdentifier.value)) {
      handleRoomRenamed(room);
    }
  },
  notify: (message, state) => pushActionToast(message, state),
});
Object.assign(app, { batchConcludeSidebarFocusRooms, batchHideSidebarRooms, batchSetSidebarRoomsPinned, concludeSidebarFocusRoom, settingsRoomActionBusyKey });

const {
  clearMcpTargetSelection,
  completeMcpOnboarding,
  continueMcpOnboarding,
  continueToRoomConfirmation,
  createFirstRunInviteRoom,
  finishFirstRunOnboarding,
  firstRunInviteCode,
  firstRunRoomSelected,
  firstRunFeedback,
  goBackFirstRun,
  goBackMcpOnboarding,
  installSelectedMcpTargets,
  joinRoomCode,
  loadFirstRunSetup,
  pickRepoRoom,
  selectAllMcpTargets,
  selectMcpTarget,
  setupApiAvailable,
  showFirstRunGate,
  showFirstRunSplash,
  visibleMcpInstallState,
  startFirstRunSetup,
} = useDesktopSetupOnboarding({
  activeEntry,
  authFeedback,
  authStatus,
  firstRunStage,
  loading,
  mcpInstallBusy,
  mcpInstallFeedback,
  mcpInstallState,
  mcpWizardStep,
  openRoomSnapshot: (snapshot, options) => openRoomSnapshot(snapshot, options),
  pinnedRoom,
  refresh: () => refresh(),
  repoStatus,
  selectedMcpTargetIds,
  setupLoadError,
});
Object.assign(app, { showFirstRunGate });

async function connectActiveRoomProject(): Promise<void> {
  const groupedContext = activeRepoRoomContext(activeEntry.value?.id, projectEntries.value);
  const context = groupedContext || {
    roomIdentifier: selectedRoomWithProjectContext.value.identifier,
    gitRoom: selectedRoomWithProjectContext.value.gitRoom,
  };
  if (!desktopIpc.repos?.connectProject) {
    pushActionToast("Restart LetAgents Desktop to connect this project.", "error");
    return;
  }
  const result = await desktopIpc.repos.connectProject(context).catch((error) => ({
    canceled: false,
    binding: null,
    repoStatus: null,
    error: error instanceof Error ? error.message : "LetAgents could not connect that project.",
  }));
  if (result.canceled) return;
  if (result.error || !result.binding) {
    pushActionToast(result.error || "LetAgents could not connect that project.", "error", 6_000);
    return;
  }
  await refreshProjectBindings();
  if (result.repoStatus) repoStatus.value = result.repoStatus;
  pushActionToast("This room is now connected to its local project.", "success");
}

async function openWorktreeForAgent(rootPath: string): Promise<void> {
  await openManagedAgentWorktree({
    rootPath,
    openWorkspaceGitRoom,
    setReopenAddAgent: (value) => {
      openAddAgentAfterRepoPick.value = value;
    },
  });
}

function getChatStorageBridge(): typeof desktopIpc.chatStorage | null {
  const bridge = desktopIpc.chatStorage;
  if (!bridge) {
    chatStorageAvailable.value = false;
    chatStorageFeedback.value = {
      state: "error",
      message: "Restart LetAgents Desktop to enable chat storage controls.",
    };
    return null;
  }
  chatStorageAvailable.value = true;
  return bridge;
}

async function loadChatStorageSettings(): Promise<void> {
  const bridge = getChatStorageBridge();
  if (!bridge) return;
  const generation = sessionGeneration.value;
  try {
    const settings = await bridge.getSettings();
    if (generation === sessionGeneration.value) chatStorageSettings.value = settings;
  } catch (error) {
    chatStorageFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "Chat storage settings could not be loaded.",
    };
  }
}

async function loadAppAgentSettingsStatus(): Promise<void> {
  try {
    appAgentSettingsStatus.value = await desktopIpc.appAgent.getSettingsStatus();
  } catch (error) {
    appAgentFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "App Agent settings could not be loaded.",
    };
  }
}

async function loadAppAgentActions(): Promise<void> {
  try {
    appAgentActions.value = await desktopIpc.appAgent.listActions();
  } catch (error) {
    appAgentFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "App Agent actions could not be loaded.",
    };
  }
}

async function saveAppAgentSettings(input: DesktopAppAgentSaveSettingsInput): Promise<void> {
  appAgentBusy.value = true;
  appAgentFeedback.value = null;
  try {
    appAgentSettingsStatus.value = await desktopIpc.appAgent.saveSettings(input);
    appAgentFeedback.value = {
      state: "success",
      message: "App Agent settings saved.",
    };
  } catch (error) {
    appAgentFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "App Agent settings could not be saved.",
    };
  } finally {
    appAgentBusy.value = false;
  }
}

async function refreshSettingsSurface(): Promise<void> {
  await Promise.all([
    refreshSettings(),
    loadAppAgentSettingsStatus(),
    loadAppAgentActions(),
    refreshDesktopUpdateStatus(),
  ]);
}

async function refreshDesktopUpdateStatus(): Promise<void> {
  if (!desktopIpc.updates?.getStatus) return;
  updateStatus.value = await desktopIpc.updates.getStatus();
}

async function checkDesktopUpdate(): Promise<void> {
  if (!desktopIpc.updates?.check) return;
  updateStatus.value = await desktopIpc.updates.check();
}

async function installDesktopUpdate(): Promise<void> {
  if (!desktopIpc.updates?.install) return;
  updateStatus.value = await desktopIpc.updates.install();
}

function openAppAgentSettings(): void {
  activeEntry.value = appAgentEntry;
}

async function runAppAgent(input: DesktopAppAgentRunInput): Promise<void> {
  appAgentBusy.value = true;
  appAgentResult.value = null;
  try {
    const runInput: DesktopAppAgentRunInput = {
      ...input,
      activeRoomDisplayName:
        input.activeRoomDisplayName || selectedRoomInfo.value.displayName || activeEntry.value.title,
      activeRoomIdentifier:
        input.activeRoomIdentifier || selectedRoomIdentifier.value || selectedRootRoomIdentifier.value,
      activeRoomPinned:
        input.activeRoomPinned === true || (activeEntry.value.type === "room" && activeEntry.value.pinned),
      activeRoomGitRoom:
        input.activeRoomGitRoom || selectedRoomInfo.value.gitRoom || null,
    };
    const result = await desktopIpc.appAgent.run(runInput);
    appAgentResult.value = result;
    if (result.settingsStatus) {
      appAgentSettingsStatus.value = result.settingsStatus;
    }
    const refreshTargets = appAgentRefreshTargets(result);
    if (refreshTargets.includes("rooms")) {
      await refreshAccountRooms();
    }
    const archivedActiveRoom =
      await leaveArchivedActiveRoomAfterAppAgent(result, runInput, {
        deferNavigation: Boolean(result.openRoomIdentifier),
      }) ||
      await leaveArchivedSelectedRoomFromSettingsList();
    if (result.openRoomIdentifier) {
      await openRoomFromAppAgent(result.openRoomIdentifier);
    }
    if (refreshTargets.includes("settings")) {
      await Promise.all([
        refreshSettingsSurface(),
        loadChatStorageSettings(),
      ]);
    }
    if (refreshTargets.includes("active_room") && !archivedActiveRoom) {
      await refreshSelectedSnapshot(rootRoomSnapshot.value);
    }
    if (refreshTargets.includes("foreground")) {
      refreshForegroundData();
    }
  } catch (error) {
    appAgentResult.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "The App Agent could not complete that request.",
    };
  } finally {
    appAgentBusy.value = false;
  }
}

async function leaveArchivedActiveRoomAfterAppAgent(
  result: DesktopAppAgentRunResult,
  input: DesktopAppAgentRunInput,
  options: { deferNavigation?: boolean } = {},
): Promise<boolean> {
  const archivedAliases = new Set(appAgentArchivedRoomIdentifiers(result));
  if (!archivedAliases.size) return false;
  forgetRecentRootRoomAliases(archivedAliases);

  const activeAliases = currentActiveRoomAliases(input);
  if (![...archivedAliases].some((alias) => activeAliases.has(alias))) {
    return false;
  }

  for (const alias of activeAliases) {
    archivedAliases.add(alias);
  }
  forgetRecentRootRoomAliases(archivedAliases);
  if (options.deferNavigation) {
    rootRoomSnapshot.value = null;
    clearSelectedSnapshotCache();
    selectedSnapshot.value = null;
    selectedRootRoomIdentifier.value = null;
    return true;
  }
  await leaveArchivedActiveRoom(archivedAliases);
  return true;
}

async function leaveArchivedRoomIfActive(
  roomIdentifier: string,
  displayName?: string | null,
): Promise<boolean> {
  const archivedAliases = roomAliasSet([roomIdentifier, displayName]);
  if (!archivedAliases.size) return false;
  forgetRecentRootRoomAliases(archivedAliases);
  const activeAliases = currentActiveRoomAliases();
  if (![...archivedAliases].some((alias) => activeAliases.has(alias))) {
    return false;
  }
  for (const alias of activeAliases) {
    archivedAliases.add(alias);
  }
  forgetRecentRootRoomAliases(archivedAliases);
  await leaveArchivedActiveRoom(archivedAliases);
  return true;
}

async function leaveArchivedSelectedRoomFromSettingsList(): Promise<boolean> {
  if (activeEntry.value.type !== "room") return false;
  const activeAliases = currentActiveRoomAliases();
  const archivedRoom = settingsAccountRooms.value.find(
    (room) => room.archived && roomMatchesAliases(room, activeAliases),
  ) || null;
  if (!archivedRoom) return false;

  const archivedAliases = roomAliasSet([
    archivedRoom.roomIdentifier,
    archivedRoom.displayName,
    archivedRoom.name,
  ]);
  for (const alias of activeAliases) {
    archivedAliases.add(alias);
  }
  forgetRecentRootRoomAliases(archivedAliases);
  await leaveArchivedActiveRoom(archivedAliases);
  return true;
}

async function leaveArchivedActiveRoom(archivedAliases: Set<string>): Promise<void> {
  const nextRoom = accountRooms.value.find(
    (room) => !room.archived && !roomMatchesAliases(room, archivedAliases),
  ) || null;
  if (nextRoom) {
    await openRoomFromAppAgent(nextRoom.roomIdentifier);
    return;
  }

  rootRoomSnapshot.value = null;
  clearSelectedSnapshotCache();
  selectedSnapshot.value = null;
  selectedRootRoomIdentifier.value = null;
  activeEntry.value = settingsEntry;
}

function currentActiveRoomAliases(input?: Partial<DesktopAppAgentRunInput>): Set<string> {
  return roomAliasSet([
    input?.activeRoomIdentifier,
    input?.activeRoomDisplayName,
    selectedRoomIdentifier.value,
    selectedRootRoomIdentifier.value,
    selectedRoomInfo.value.identifier,
    selectedRoomInfo.value.displayName,
    selectedRoomInfo.value.name,
    selectedRoomInfo.value.code,
    selectedSnapshot.value?.roomIdentifier,
    selectedSnapshot.value?.access.roomIdentifier,
    selectedSnapshot.value?.access.code,
    selectedSnapshot.value?.room?.identifier,
    selectedSnapshot.value?.room?.displayName,
    selectedSnapshot.value?.room?.name,
    selectedSnapshot.value?.room?.code,
    rootRoomSnapshot.value?.roomIdentifier,
    rootRoomSnapshot.value?.access.roomIdentifier,
    rootRoomSnapshot.value?.access.code,
    rootRoomSnapshot.value?.room?.identifier,
    rootRoomSnapshot.value?.room?.displayName,
    rootRoomSnapshot.value?.room?.name,
    rootRoomSnapshot.value?.room?.code,
    activeEntry.value.type === "room" ? activeEntry.value.roomIdentifier : null,
    activeEntry.value.title,
  ]);
}

function forgetRecentRootRoomAliases(aliases: Set<string>): void {
  if (!aliases.size) return;
  const nextRecentRooms = recentRootRooms.value.filter(
    (room) =>
      !aliases.has(normalizeRoomIdentifier(room.identifier) || "") &&
      !aliases.has(normalizeRoomIdentifier(room.displayName) || ""),
  );
  if (nextRecentRooms.length === recentRootRooms.value.length) return;
  recentRootRooms.value = nextRecentRooms;
  rememberRecentRootRooms(recentRootRoomsStorageKey, nextRecentRooms);
}

async function openRoomFromAppAgent(roomIdentifier: string): Promise<void> {
  const normalizedIdentifier = normalizeRoomIdentifier(roomIdentifier);
  if (!normalizedIdentifier) return;
  const knownRoom = [...accountRooms.value, ...settingsAccountRooms.value]
    .find((room) => normalizeRoomIdentifier(room.roomIdentifier) === normalizedIdentifier);
  loading.value = true;
  try {
    const snapshot = await desktopIpc.room.getSnapshot(normalizedIdentifier);
    openRoomSnapshot(snapshot, {
      kind: "room",
      rootPath: null,
      meta: knownRoom?.role === "admin" ? "Admin" : "Account room",
    });
  } finally {
    loading.value = false;
  }
}

async function openServiceAgent(intent: AttentionNavigationIntent): Promise<void> {
  attentionIntent.value = null;
  notificationRevealMessageId.value = null;
  try {
    await openRoomFromAppAgent(intent.roomIdentifier);
    attentionIntent.value = intent;
  } catch (error) {
    pushActionToast(safeUserVisibleErrorDetail(error, "Could not open this agent’s room."), "error");
  }
}

async function refreshActiveRoomAfterChatStorageChange(): Promise<void> {
  await desktopIpc.room.stopStream();
  await refreshActiveRepoStatus();
  clearSelectedSnapshotCache();
  selectedSnapshot.value = null;
  const rootRoomIdentifier = selectedRootRoomIdentifier.value || rootRoomSnapshot.value?.roomIdentifier || null;
  if (rootRoomIdentifier) {
    const nextRootSnapshot = await desktopIpc.room.getSnapshot(rootRoomIdentifier);
    rootRoomSnapshot.value = nextRootSnapshot;
    selectedRootRoomIdentifier.value = nextRootSnapshot.roomIdentifier;
    rememberRootRoomSnapshot(nextRootSnapshot);
    await refreshSelectedSnapshot(nextRootSnapshot);
  }
  if (selectedRoomIdentifier.value) {
    await syncSelectedRoomStream(selectedRoomIdentifier.value);
  }
}

async function setChatStorageMode(mode: DesktopChatStorageSettings["mode"]): Promise<void> {
  chatStorageBusy.value = true;
  chatStorageFeedback.value = null;
  try {
    const bridge = getChatStorageBridge();
    if (!bridge) return;
    chatStorageSettings.value = await bridge.setMode(mode);
    chatStorageFeedback.value = {
      state: "success",
      message:
        mode === "local"
          ? "Local chat storage is on. New messages stay on this computer."
          : "Cloud chat storage is on. Local history remains local until you publish it.",
    };
    await refreshActiveRoomAfterChatStorageChange();
  } catch (error) {
    chatStorageFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "Chat storage mode could not be updated.",
    };
  } finally {
    chatStorageBusy.value = false;
  }
}

async function syncLocalChat(): Promise<void> {
  const roomIdentifier = selectedRoomIdentifier.value || selectedRootRoomIdentifier.value;
  const generation = sessionGeneration.value;
  if (!roomIdentifier) {
    chatStorageFeedback.value = {
      state: "error",
      message: "Open a room before publishing local chat.",
    };
    return;
  }
  chatStorageBusy.value = true;
  chatStorageFeedback.value = null;
  try {
    const bridge = getChatStorageBridge();
    if (!bridge) return;
    const result = await bridge.syncLocalRoom(roomIdentifier);
    if (generation !== sessionGeneration.value
      || (selectedRoomIdentifier.value || selectedRootRoomIdentifier.value) !== roomIdentifier) return;
    chatStorageFeedback.value = {
      state: result.skippedCount > 0 || result.skippedTaskCount > 0 ? "info" : "success",
      message:
        result.skippedCount > 0 || result.skippedTaskCount > 0
          ? `Published ${result.syncedCount} messages and ${result.syncedTaskCount} tasks. ${result.skippedCount + result.skippedTaskCount} items were skipped.`
          : `Published ${result.syncedCount} messages and ${result.syncedTaskCount} tasks.`,
    };
    if ((selectedRoomIdentifier.value || selectedRootRoomIdentifier.value) === roomIdentifier) {
      const snapshot = await desktopIpc.room.getSnapshot(roomIdentifier);
      if (generation !== sessionGeneration.value
        || (selectedRoomIdentifier.value || selectedRootRoomIdentifier.value) !== roomIdentifier) return;
      await handleRoomShellRefresh(snapshot);
    }
  } catch (error) {
    if (generation !== sessionGeneration.value
      || (selectedRoomIdentifier.value || selectedRootRoomIdentifier.value) !== roomIdentifier) return;
    chatStorageFeedback.value = {
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "Local chat could not be published.",
    };
  } finally {
    chatStorageBusy.value = false;
  }
}

function handleOwnMessageSent(message: Parameters<typeof handleMessageSent>[0]): void {
  handleMessageSent(message);
  markActiveRoomRead();
}

async function handleRoomShellRefresh(snapshot?: DesktopRoomSnapshot): Promise<void> {
  const generation = sessionGeneration.value;
  const selectedIdentifier = selectedSnapshot.value?.roomIdentifier;
  const rootIdentifier = selectedRootRoomIdentifier.value;
  const entryId = activeEntry.value.id;
  const localIdentifier = normalizeRoomIdentifier(snapshot?.storage?.localRoom?.roomIdentifier);
  const previousProject = localIdentifier && sidebarProjectEntries.value.find((project) =>
    [project.parent, ...project.branchRooms, ...project.focusRooms]
      .some((entry) => normalizeRoomIdentifier(entry.roomIdentifier) === localIdentifier));
  const identityChanged = snapshot?.roomIdentifier
    && snapshot.roomIdentifier !== selectedSnapshot.value?.roomIdentifier;
  const storageChanged = snapshot?.storage
    && snapshot.storage.effectiveMode !== roomHistoryMode(snapshot.roomIdentifier);
  if (storageChanged) {
    await loadChatStorageSettings();
    if (generation !== sessionGeneration.value
      || selectedIdentifier !== selectedSnapshot.value?.roomIdentifier
      || rootIdentifier !== selectedRootRoomIdentifier.value
      || entryId !== activeEntry.value.id) return;
    sidebarLatestMessages.value = {};
  }
  handleRefreshRoom(snapshot);
  if (!snapshot?.roomIdentifier) return;
  if (identityChanged && previousProject) {
    const nextProject = sidebarProjectEntries.value.find((project) =>
      [project.parent, ...project.branchRooms, ...project.focusRooms]
        .some((entry) => normalizeRoomIdentifier(entry.roomIdentifier) === normalizeRoomIdentifier(snapshot.roomIdentifier)));
    if (nextProject && previousProject.id !== nextProject.id) {
      sidebarRoomOrder.value = replaceSidebarProjectId(sidebarRoomOrder.value, previousProject.id, nextProject.id);
      rememberSidebarRoomOrder(window.localStorage, sidebarRoomOrderStorageKey, sidebarRoomOrder.value);
    }
  }
  void syncSelectedRoomStream(snapshot.roomIdentifier);
  if (identityChanged) {
    await refreshProjectBindings();
    await refreshSidebarRoomMetadata();
  }
  if (storageChanged) await refreshSidebarLatestMessages();
}

function handleRoomMessageRevealUnavailable(_messageId: string, reason?: "not_found" | "too_far_back" | "unavailable"): void {
  if (reason === "not_found") {
    pushActionToast("That message is not available.", "info");
  } else if (reason === "too_far_back") {
    pushActionToast("That message is too far back to open here yet.", "info");
  } else {
    pushActionToast("That earlier message is not available in the loaded room history.", "info");
  }
}

function rememberChatScrollPosition(roomIdentifier: string, position: ChatScrollPosition): void {
  const storageKey = chatScrollPositionKey(roomIdentifier) || roomIdentifier;
  if (!shouldRememberChatScrollPosition({
    roomIdentifier,
    selectedRoomIdentifier: selectedRoomInfo.value.identifier,
    selectedSnapshotLoading: selectedSnapshotLoading.value,
    suppressedRoomIdentifiers: loadingChatScrollRoomIdentifiers.value,
  })) {
    return;
  }
  chatScrollPositionsByRoom.value = {
    ...chatScrollPositionsByRoom.value,
    [storageKey]: position,
  };
}

function chatScrollPositionForRoom(roomIdentifier: string): ChatScrollPosition | null {
  const storageKey = chatScrollPositionKey(roomIdentifier);
  if (storageKey && chatScrollPositionsByRoom.value[storageKey] !== undefined) {
    return chatScrollPositionsByRoom.value[storageKey];
  }
  return chatScrollPositionsByRoom.value[roomIdentifier] ?? null;
}

function rememberLoadingChatScrollRoom(roomIdentifier: string | null | undefined): void {
  const normalizedRoomIdentifier = normalizeRoomIdentifier(roomIdentifier);
  if (!normalizedRoomIdentifier || loadingChatScrollRoomIdentifiers.value.has(normalizedRoomIdentifier)) return;
  loadingChatScrollRoomIdentifiers.value = new Set([
    ...loadingChatScrollRoomIdentifiers.value,
    normalizedRoomIdentifier,
  ]);
}

function forgetLoadingChatScrollRooms(roomIdentifiers: Array<string | null | undefined>): void {
  const normalizedRoomIdentifiers = roomIdentifiers
    .map(normalizeRoomIdentifier)
    .filter((roomIdentifier): roomIdentifier is string => Boolean(roomIdentifier));
  if (!normalizedRoomIdentifiers.length) return;
  const nextRoomIdentifiers = new Set(loadingChatScrollRoomIdentifiers.value);
  for (const roomIdentifier of normalizedRoomIdentifiers) {
    nextRoomIdentifiers.delete(roomIdentifier);
  }
  if (nextRoomIdentifiers.size === loadingChatScrollRoomIdentifiers.value.size) return;
  loadingChatScrollRoomIdentifiers.value = nextRoomIdentifiers;
}

watch(
  [() => selectedSnapshotLoading.value, () => activeChatScrollRoomIdentifier()] as const,
  ([loading, roomIdentifier]) => {
    if (loading) rememberLoadingChatScrollRoom(roomIdentifier);
  },
  { flush: "sync" }
);

watch(
  [
    () => selectedSnapshotLoading.value,
    () => selectedSnapshot.value?.roomIdentifier || null,
    () => selectedSnapshot.value?.room?.identifier || null,
  ] as const,
  ([loading, roomIdentifier, roomInfoIdentifier]) => {
    if (loading) return;
    forgetLoadingChatScrollRooms([roomIdentifier, roomInfoIdentifier]);
  },
  { flush: "sync" }
);

function activeChatScrollRoomIdentifier(): string | null {
  if (activeEntry.value.type === "room") {
    return activeEntry.value.roomIdentifier || selectedRoomInfo.value.identifier || null;
  }
  return selectedRoomInfo.value.identifier || null;
}

Object.assign(app, useAppSelectionWatchers(app));

watch(
  () => activeProjectRootPath(),
  (rootPath) => {
    void restartRepoStatusWatch(rootPath);
  },
  { immediate: true }
);

// The list is only ever replaced, never edited in place, so an identity watch sees
// every change without walking each room.
watch(recentRootRooms, () => {
  void refreshProjectBindings();
});

watch(
  [
    () => settingsAccountRooms.value,
    () => selectedRootRoomIdentifier.value,
    () => rootRoomSnapshot.value?.roomIdentifier || null,
    // The room list keeps its identity when a poll finds no change, so opening
    // an already-archived room must re-run the check by itself.
    () => activeEntry.value.type === "room" ? [...currentActiveRoomAliases()].sort().join("|") : "",
  ],
  () => {
    void leaveArchivedSelectedRoomFromSettingsList();
  },
  // No `deep`: the settings room list is replaced on every refresh, not edited in place.
  { immediate: true }
);

watch(
  () => selectedRoomIdentifier.value,
  (roomIdentifier) => {
    void syncSelectedRoomStream(roomIdentifier);
  }
);

watch(
  () => selectedSnapshot.value?.messages.at(-1)?.id || null,
  () => {
    if (!selectedRoomIdentifier.value) return;
    void syncSelectedRoomStream(selectedRoomIdentifier.value);
    markActiveRoomRead();
  }
);

Object.assign(app, useAppAuthWatchers(app));

onMounted(() => {
  void refreshNeedsYou();
  needsYouInterval = window.setInterval(() => { if (!document.hidden) void refreshNeedsYou(); }, 60_000);
  unsubscribeRoomStream = desktopIpc.room?.onStreamEvent?.(handleDesktopRoomStreamEvent) || null;
  unsubscribeOpenSettings = desktopIpc.ui?.onOpenSettings(openSettingsSurface) || null;
  unsubscribeOpenUpdates = desktopIpc.ui?.onOpenUpdates?.(openUpdatesSurface) || null;
  void desktopIpc.maintenance?.getStatus().then(status => { if (status.held) openUpdatesSurface(); }).catch(() => undefined);
  unsubscribeUpdateStatus = desktopIpc.updates?.onStatusChanged?.((status) => {
    updateStatus.value = status;
  }) || null;
  unsubscribeNotificationReceived = desktopIpc.notifications?.onReceived?.(() => {
    void refreshSidebarRoomMetadata();
  }) || null;
  unsubscribeNotificationActivation = desktopIpc.notifications?.onActivated?.((target) => {
    void handleNotificationActivation(target);
  }) || null;
  void desktopIpc.notifications?.takePendingActivation?.().then((target) => {
    if (target) void handleNotificationActivation(target);
  });
  unsubscribeRepoStatusChanged = desktopIpc.repos?.onStatusChanged?.(handleRepoStatusChanged) || null;
  // Keep the fallback room-list refresh alive while hidden for badges.
  // A connected account activity stream still avoids routine room-list polling.
  accountRoomsRefreshInterval = window.setInterval(() => {
    void refreshUnreadCounts();
    // Retry leaving an archived active room: the room list keeps its identity
    // on an unchanged poll, so its watcher does not fire again by itself.
    void leaveArchivedSelectedRoomFromSettingsList();
    // While the activity stream is open it pushes messages and work as they
    // happen; the room list is then refreshed only rarely, to pick up rooms
    // that were renamed or created elsewhere.
    if (accountActivity.connected.value
      && Date.now() - sidebarMetadataRefresh.lastAt < ACCOUNT_ROOMS_REFRESH_WHILE_STREAMING_MS) {
      // Local workers do not appear in the cloud activity stream.
      if (sidebarRoomIdentifiers().some((id) => roomHistoryMode(id) === "local")) void refreshSidebarLatestMessages();
      return;
    }
    void refreshSidebarRoomMetadata();
  }, SIDEBAR_METADATA_REFRESH_INTERVAL_MS);
  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("blur", handleWindowBlur);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  void loadChatStorageSettings();
  void loadAppAgentSettingsStatus();
  void loadAppAgentActions();
  void loadFirstRunSetup(initializeProjectBindings());
  void refreshRentalRequestCount();
  void refreshDesktopUpdateStatus();
});

onBeforeUnmount(() => {
  if (needsYouInterval) window.clearInterval(needsYouInterval);
  clearAuthPollTimer();
  clearLiveMetadataRefreshTimer();
  clearLiveMetadataRefreshInterval();
  if (accountRoomsRefreshInterval) {
    window.clearInterval(accountRoomsRefreshInterval);
    accountRoomsRefreshInterval = null;
  }
  window.removeEventListener("focus", handleWindowFocus);
  window.removeEventListener("blur", handleWindowBlur);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  unsubscribeRoomStream?.();
  unsubscribeRoomStream = null;
  unsubscribeOpenSettings?.();
  unsubscribeOpenSettings = null;
  unsubscribeOpenUpdates?.();
  unsubscribeOpenUpdates = null;
  unsubscribeUpdateStatus?.();
  unsubscribeUpdateStatus = null;
  unsubscribeNotificationReceived?.();
  unsubscribeNotificationReceived = null;
  unsubscribeNotificationActivation?.();
  unsubscribeNotificationActivation = null;
  unsubscribeRepoStatusChanged?.();
  unsubscribeRepoStatusChanged = null;
  void desktopIpc.repos?.stopStatusWatch?.();
  void desktopIpc.room?.stopStream?.();
});
</script>
