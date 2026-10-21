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
          @open-my-work="openMyWork"
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
          @open-ask-agent="askAgentOpen = true"
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

      <MyWorkView
        v-else-if="activeEntry.type === 'my-work'"
        :key="authStatus?.account?.id ?? 'local'"
        :tasks-changed-at="accountActivity.tasksChangedAt.value"
        :connected="accountActivity.connected.value"
        @open-card="openMyWorkCard"
        @open-thread="openMyWorkThread"
      />

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

    <AskAgentDialog
      :open="askAgentOpen"
      :room-identifier="selectedRoomWithProjectContext?.identifier ?? null"
      :rooms="settingsAccountRooms"
      @close="askAgentOpen = false"
      @created="void app.refreshAccountRooms?.()"
    />
    <GiveAgentDialog :token="giveAgentToken" @close="giveAgentToken = null" />

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
import { roomUnread } from "./composables/roomUnread";
import PrivateMessages from "../../../../shared/ui/PrivateMessages.vue";
import { defineAsyncComponent } from "vue";
import DesktopSidebar from "./components/desktop/sidebar/DesktopSidebar.vue";
import SidebarFocusRoomConclusionDialog from "./components/desktop/sidebar/SidebarFocusRoomConclusionDialog.vue";
import SidebarRoomBatchActionDialog from "./components/desktop/sidebar/SidebarRoomBatchActionDialog.vue";
import DesktopTopbar from "./components/desktop/content/DesktopTopbar.vue";
import DesktopRoomShell from "./components/desktop/content/DesktopRoomShell.vue";
import DesktopNewRoomModal from "./components/desktop/content/DesktopNewRoomModal.vue";
import AskAgentDialog from "./components/desktop/content/asks/AskAgentDialog.vue";
import GiveAgentDialog from "./components/desktop/content/asks/GiveAgentDialog.vue";
import { useAppAgentAsks } from "./composables/app/useAppAgentAsks";
import DesktopDeviceAuthDialog from "./components/desktop/content/DesktopDeviceAuthDialog.vue";
import DesktopAppAgent from "./components/desktop/app-agent/DesktopAppAgent.vue";
import AuthOnboardingView from "./components/desktop/content/AuthOnboardingView.vue";
import DesktopSignedOutView from "./components/desktop/content/DesktopSignedOutView.vue";
import SettingsView from "./components/desktop/content/SettingsView.vue";
import FirstRunOnboardingView from "./components/desktop/setup/FirstRunOnboardingView.vue";
import FirstRunSplashView from "./components/desktop/setup/FirstRunSplashView.vue";
import { settingsEntry } from "./domain/desktop-navigation";
import InboxView from "./components/desktop/content/InboxView.vue";
import MyWorkView from "./components/desktop/content/MyWorkView.vue";
import { desktopIpc } from "./ipc/index.js";
import type { AppContext } from "./composables/app/context";
import { useAppState } from "./composables/app/useAppState";
import { useAppInboxActions, useAppInboxState, useAppRoomAttention } from "./composables/app/useAppInbox";
import { useAppRentalActions, useAppRentalEvents } from "./composables/app/useAppRentals";
import { useAppSidebarLayout } from "./composables/app/useAppSidebarLayout";
import { useAppProjectRepo, useAppProjectRepoWatchers } from "./composables/app/useAppProjectRepo";
import { useAppSidebarMessages, useAppAccountActivityFeed, useAppReadMarkers, useAppHistoryWatchers } from "./composables/app/useAppSidebarMessages";
import { useAppSidebarSelection, useAppSidebarEntries } from "./composables/app/useAppSidebarSelection";
import { useAppFocusRoomConclusion } from "./composables/app/useAppFocusRoomConclusion";
import { useAppSessionActions, useAppAccountScope, useAppAuthFlow, useAppAccountSwitch, useAppAuthWatchers } from "./composables/app/useAppSession";
import { useAppSettingsActions, useAppSetupOnboarding } from "./composables/app/useAppSettings";
import { useAppArchivedRooms, useAppArchivedRoomWatcher } from "./composables/app/useAppArchivedRooms";
import { useAppRoomShellActions, useAppChatScrollWatchers } from "./composables/app/useAppRoomShell";
import { useAppNavigation, useAppRoomContext, useAppSelectionWatchers } from "./composables/app/useAppNavigation";
import { useAppRoomData, useAppRoomManagement, useAppRoomStreamWatchers } from "./composables/app/useAppRoomData";
import { useAppLifecycle } from "./composables/app/useAppLifecycle";

const RentMarketplaceView = defineAsyncComponent(
  () => import("./components/desktop/content/RentMarketplaceView.vue"),
);

// App.vue holds the template and this wiring. The context fills in the original
// order: state, then the function composables (only function definitions, like
// the hoisted declarations they came from), then each watcher and composable
// slice exactly where its code used to run.
const app = {} as AppContext;
const {
  loading, appInfo, updateStatus, workers, rootRoomSnapshot, selectedSnapshot, authStatus,
  authDialogOpen, sidebarMinWidth, sidebarMaxWidth, selectedRootRoomIdentifier,
  newRoomRecentProjectFolders, sidebarWidth, sidebarRevealRequest, isSidebarResizing,
  settingsAccountRooms, rentalRequestCount, inboxRentals, inboxRentalError, messagesUnread,
  openConversationId, openConversationNonce, inboxSection, attentionIntent, rentMarketplaceRole,
  openAddAgentAfterRepoPick, notificationRevealMessageId, notificationRevealNonce,
  chatStorageSettings, chatStorageAvailable, chatStorageBusy, chatStorageFeedback,
  appAgentSettingsStatus, appAgentActions, appAgentBusy, appAgentResult, appAgentFeedback,
  selectedMcpTargetIds, mcpInstallBusy, mcpInstallFeedback, mcpWizardStep, firstRunStage,
  sidebarFocusRoomConclusionTarget, sidebarFocusRoomConclusionReturnFocusId,
  sidebarFocusRoomConclusionError, sidebarSelectionActive, sidebarSelectedEntryIds,
  sidebarBatchActionBusy, sidebarBatchDialogAction, sidebarBatchDialogTargets,
  sidebarBatchDialogError,
} = Object.assign(app, useAppState());
const {
  openMessages, openMessagesWithPerson, openNeedsYouRoom, openNeedsYou, refreshNeedsYou,
  openMyWork, openMyWorkCard, openMyWorkThread,
} = Object.assign(app, useAppInboxActions(app));
const {
  openRentMarketplace, openRentalRequestInbox,
} = Object.assign(app, useAppRentalActions(app));
const {
  isSettingsSurface, showSidebarResizeHandle, desktopShellStyle, cycleSidebar,
  settingsPaneForActiveEntry, openSettingsSurface, openUpdatesSurface, startSidebarResize,
  handleSidebarResizeKeydown, setAllProjectsCollapsed, handleSidebarParentRoomReorder,
  handleSidebarChildRoomReorder,
} = Object.assign(app, useAppSidebarLayout(app));
const {
  openWorkspaceGitRoom, connectActiveRoomProject, openWorktreeForAgent,
} = Object.assign(app, useAppProjectRepo(app));
const {
  latestMessageIdForEntry, markRoomEntryRead,
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
  startSignedOutAuthFlow, openAccountAuthFlow, startFirstRunRoomAuth,
} = Object.assign(app, useAppSessionActions(app));
const {
  saveAppAgentSettings, refreshSettingsSurface, checkDesktopUpdate, installDesktopUpdate,
  openAppAgentSettings, runAppAgent, setChatStorageMode, syncLocalChat,
} = Object.assign(app, useAppSettingsActions(app));
const {
  openServiceAgent,
} = Object.assign(app, useAppArchivedRooms(app));
const {
  handleOwnMessageSent, handleRoomShellRefresh, handleRoomMessageRevealUnavailable,
  rememberChatScrollPosition, chatScrollPositionForRoom,
} = Object.assign(app, useAppRoomShellActions(app));

Object.assign(app, useAppAccountScope(app));

const { accountActivity } = Object.assign(app, useAppAccountActivityFeed(app));

const {
  needsYouData, needsYouLoading, needsYouError, mergeInboxThreads, agentAttentionItems,
  needsYouCount, inboxStorageKey, inboxRooms, chooseInboxRooms,
} = Object.assign(app, useAppInboxState(app));

const {
  activeEntry, collapsedProjects, currentParentRoom, pinnedCollapsed, repoName, roomsCollapsed,
  returnFromSettings, selectedAccess, selectedFocusRooms, selectedNeedsAccess,
  selectedRoomIdentifier, selectedRoomInfo, sidebarMode, toggleProject, togglePinnedCollapsed,
  toggleRoomsCollapsed,
} = Object.assign(app, useAppNavigation(app));

const {
  roomAttention,
} = Object.assign(app, useAppRoomAttention(app));

const {
  actionToasts, dismissActionToast, selectedRoomWithProjectContext,
  selectedGitRoomMatchesActiveRepo, selectedRoomProjectRootPath, selectedRoomIsProject,
} = Object.assign(app, useAppRoomContext(app));

Object.assign(app, useAppReadMarkers(app));

const {
  sidebarProjectEntries, selectedRoomRenderKey, selectedRoomStorage,
} = Object.assign(app, useAppSidebarEntries(app));

Object.assign(app, useAppRentalEvents(app));

Object.assign(app, useAppHistoryWatchers(app));

const {
  roomAgentWork, roomAgentWorkStatus, roomAgentWorkTruncated, handleRoomRenamed, refresh,
  repoStatusValue, selectedSnapshotLoading, upsertSelectedTask, authSnapshotPending,
} = Object.assign(app, useAppRoomData(app));

const {
  authBusy, authFeedback, cancelAuthFlow, openVerification, pollAuthFlow, signOut, startAuthFlow,
} = Object.assign(app, useAppAuthFlow(app));

const {
  showSignedOutGate,
} = Object.assign(app, useAppAccountSwitch(app));

const {
  backFromSubstep, canSubmitJoin, canSubmitStandalone, chooseJoinIntent, chooseProjectIntent,
  chooseNewProjectIntent, chooseStandaloneIntent, closeNewRoomModal, confirmProjectRoomFromModal,
  copyInviteCode, createStandaloneRoom, createProjectRoomFromModal, dismissSuccess,
  joinRoomCodeFromModal, newRoomActiveAction, newRoomBusy, newRoomCanDismiss, newRoomFeedback,
  newRoomFeedbackState, newRoomJoinCode, newRoomJoinError, newRoomModalOpen, newRoomName,
  newRoomProjectPath, newRoomProjectName, newRoomProjectParent, newRoomProjectCreationError,
  newRoomProjectPathError, newRoomProjectSelection, newRoomStatusMessage, newRoomStep,
  newRoomStorage, newRoomSuccess, openProjectRoomFromModal, openProjectRoomFromPath,
  pickNewProjectParent, openSuccessRoom, retryLastAction, selectNewRoomEntry,
  archiveSidebarFocusRoom, archiveSidebarRoom, deleteAccountRoom, leaveAccountRoom,
  openAccountRoomFromSettings, renameSidebarRoom, restoreAccountRoom, settingsFeedback,
  settingsRoomActionBusyKey, toggleAccountRoomPin, togglePinSidebarRoom,
} = Object.assign(app, useAppRoomManagement(app));

const {
  clearMcpTargetSelection, completeMcpOnboarding, continueMcpOnboarding,
  continueToRoomConfirmation, createFirstRunInviteRoom, finishFirstRunOnboarding,
  firstRunInviteCode, firstRunRoomSelected, firstRunFeedback, goBackFirstRun, goBackMcpOnboarding,
  installSelectedMcpTargets, joinRoomCode, pickRepoRoom, selectAllMcpTargets, selectMcpTarget,
  setupApiAvailable, showFirstRunGate, showFirstRunSplash, visibleMcpInstallState,
  startFirstRunSetup,
} = Object.assign(app, useAppSetupOnboarding(app));

Object.assign(app, useAppChatScrollWatchers(app));

Object.assign(app, useAppSelectionWatchers(app));

Object.assign(app, useAppProjectRepoWatchers(app));

Object.assign(app, useAppArchivedRoomWatcher(app));

Object.assign(app, useAppRoomStreamWatchers(app));

Object.assign(app, useAppAuthWatchers(app));

Object.assign(app, useAppLifecycle(app));

const { askAgentOpen, giveAgentToken } = useAppAgentAsks();
</script>
