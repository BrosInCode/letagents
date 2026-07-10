<template>
  <section class="settings-shell" data-testid="settings-view">
    <SettingsSidebar
      :groups="settingsNavGroups"
      :active-pane="activePane"
      @back="$emit('back-to-app')"
      @select="selectPane"
    />

    <main class="settings-content" data-testid="settings-content">
      <header class="settings-content-header">
        <div>
          <p class="sidebar-label">{{ activePaneBreadcrumb }}</p>
          <h1>{{ activePaneTitle }}</h1>
          <p>{{ activePaneDescription }}</p>
        </div>
        <button
          class="ghost-button settings-header-button"
          type="button"
          :disabled="busy"
          data-testid="settings-refresh"
          @click="$emit('refresh')"
        >
          <RefreshCw aria-hidden="true" />
          <span>{{ busy ? "Refreshing" : "Refresh" }}</span>
        </button>
      </header>

      <section
        v-if="activePane === 'account:profile'"
        class="settings-panel settings-profile-panel"
        data-testid="settings-account-panel"
      >
        <article class="settings-profile-card" data-testid="settings-profile-identity">
          <h2>Room identity</h2>
          <div class="settings-profile-body">
            <img
              v-if="authStatus?.account?.avatarUrl"
              class="settings-profile-avatar"
              :src="authStatus.account.avatarUrl"
              alt=""
              referrerpolicy="no-referrer"
            />
            <span v-else class="settings-profile-avatar" aria-hidden="true">{{ accountInitials }}</span>
            <div class="settings-profile-copy">
              <strong>{{ accountTitle }}</strong>
              <span>{{ accountHandleLabel }}</span>
              <p
                class="settings-provider-pill"
                :data-state="authStatus?.authenticated ? 'connected' : 'offline'"
              >
                <svg aria-hidden="true" viewBox="0 0 16 16">
                  <path
                    fill="currentColor"
                    d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.56 7.56 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
                  />
                </svg>
                {{ providerConnectionLabel }}
              </p>
              <p class="settings-profile-note">{{ accountPurposeLabel }}</p>
            </div>
            <button
              v-if="authStatus?.authenticated"
              class="ghost-button settings-profile-action-button"
              type="button"
              :disabled="busy"
              data-testid="settings-sign-out"
              @click="$emit('sign-out')"
            >
              <LogOut aria-hidden="true" />
              <span>Sign out</span>
            </button>
            <button
              v-else
              class="primary-button settings-profile-action-button"
              type="button"
              :disabled="busy"
              data-testid="settings-connect-github"
              @click="$emit('start-auth')"
            >
              <LogIn aria-hidden="true" />
              <span>Connect GitHub</span>
            </button>
          </div>
        </article>
      </section>

      <section v-else-if="isStoragePane" class="settings-panel settings-storage-panel" data-testid="settings-storage-panel">
        <div class="settings-content-grid">
          <div class="settings-control-list">
            <SettingsRow
              v-if="activePane === 'storage:chat'"
              title="Default storage for new rooms"
              :description="chatStorageSubtitle"
              :badge="chatStorageModeLabel"
              :badge-state="chatStorageSettings?.mode === 'local' ? 'installed' : 'connected'"
            >
              <template #action>
                <div class="settings-storage-toggle" role="group" aria-label="Chat storage mode">
                  <button
                    class="settings-filter"
                    type="button"
                    :data-active="chatStorageSettings?.mode !== 'local'"
                    :disabled="chatStorageBusy || !chatStorageAvailable"
                    @click="$emit('set-chat-storage-mode', 'cloud')"
                  >
                    Cloud
                  </button>
                  <button
                    class="settings-filter"
                    type="button"
                    :data-active="chatStorageSettings?.mode === 'local'"
                    :disabled="chatStorageBusy || !chatStorageAvailable"
                    @click="$emit('set-chat-storage-mode', 'local')"
                  >
                    Local
                  </button>
                </div>
              </template>
            </SettingsRow>

            <SettingsRow
              v-if="activePane !== 'storage:sync'"
              title="Local database"
              description="Local room messages and tasks are stored on this computer."
            >
              <code>{{ chatStorageSettings?.databasePath || "Local database path unavailable" }}</code>
              <template #action>
                <button
                  class="ghost-button settings-action-button"
                  type="button"
                  :disabled="!chatStorageSettings?.databasePath"
                  @click="copyText(chatStorageSettings?.databasePath || '')"
                >
                  <Database aria-hidden="true" />
                  <span>{{ copiedText === chatStorageSettings?.databasePath ? "Copied" : "Copy path" }}</span>
                </button>
              </template>
            </SettingsRow>

            <SettingsRow
              v-if="activePane !== 'storage:sync'"
              title="Local files"
              description="Files attached in local rooms are copied here."
            >
              <code>{{ chatStorageSettings?.localFilesPath || "Local files path unavailable" }}</code>
              <template #action>
                <button
                  class="ghost-button settings-action-button"
                  type="button"
                  :disabled="!chatStorageSettings?.localFilesPath"
                  @click="copyText(chatStorageSettings?.localFilesPath || '')"
                >
                  <Copy aria-hidden="true" />
                  <span>{{ copiedText === chatStorageSettings?.localFilesPath ? "Copied" : "Copy path" }}</span>
                </button>
              </template>
            </SettingsRow>

            <SettingsRow
              v-if="activePane !== 'storage:database' && !selectedRoomIsLocalGitRoom"
              title="Publish this local room"
              description="Upload this room's local messages and tasks to LetAgents cloud. Nothing uploads until you click Publish."
              badge="manual"
              badge-state="away"
            >
              <template #action>
                <button
                  class="primary-button settings-action-button"
                  type="button"
                  :disabled="chatStorageBusy || !chatStorageAvailable || !selectedRoomIdentifier"
                  data-testid="settings-sync-local-chat"
                  @click="$emit('sync-local-chat')"
                >
                  <CloudUpload aria-hidden="true" />
                  <span>Publish to cloud</span>
                </button>
              </template>
            </SettingsRow>

            <SettingsRow
              v-if="activePane !== 'storage:database' && selectedRoomIsLocalGitRoom"
              title="Local Git Room"
              description="This room stays local until you attach a provider-backed repository."
              badge="local"
              badge-state="away"
            />

            <SettingsRow
              v-if="activePane === 'storage:sync'"
              title="Publish behavior"
              description="Local rooms never upload automatically. Publishing is always a manual room action."
              badge="manual"
              badge-state="connected"
            />

            <SettingsRow
              v-if="activePane === 'storage:database'"
              title="Storage settings file"
              description="This file records the app default and per-room storage overrides."
            >
              <code>{{ chatStorageSettings?.settingsPath || "Settings path unavailable" }}</code>
            </SettingsRow>

            <SettingsRow
              title="Attachments in local mode"
              description="Local room files are copied into the local files directory."
              :badge="chatStorageSettings?.mode === 'local' ? 'cloud disabled' : 'cloud enabled'"
              :badge-state="chatStorageSettings?.mode === 'local' ? 'starting' : 'connected'"
              :emphasis="chatStorageSettings?.mode === 'local' ? 'warning' : 'normal'"
            />
          </div>

          <aside class="settings-status-panel" data-testid="settings-storage-status">
            <div class="settings-status-header">
              <HardDrive aria-hidden="true" />
              <div>
                <p>Storage status</p>
                <strong>{{ chatStorageModeLabel }}</strong>
              </div>
            </div>
            <dl class="settings-status-list">
              <div>
                <dt>Active rooms</dt>
                <dd>{{ activeRoomCount }}</dd>
              </div>
              <div>
                <dt>Focus rooms</dt>
                <dd>{{ focusRoomCount }}</dd>
              </div>
              <div>
                <dt>Left</dt>
                <dd>{{ archivedRoomCount }}</dd>
              </div>
              <div>
                <dt>Last saved</dt>
                <dd>{{ chatStorageSavedLabel }}</dd>
              </div>
            </dl>
            <p class="settings-privacy-note">Rooms can override this default from room settings.</p>
          </aside>
        </div>

        <p
          v-if="chatStorageFeedback"
          class="settings-feedback"
          :data-state="chatStorageFeedback.state"
          data-testid="settings-chat-storage-feedback"
        >
          {{ chatStorageFeedback.message }}
        </p>
      </section>

      <section v-else-if="isRoomPane" class="settings-panel settings-rooms-panel" data-testid="settings-rooms-panel">
        <template v-if="selectedRoomDetail">
          <button class="settings-back-button settings-detail-back" type="button" @click="selectedRoomDetailIdentifier = null">
            <ArrowRight aria-hidden="true" />
            <span>Back to rooms</span>
          </button>

          <article class="settings-room-detail" data-testid="settings-room-detail">
            <header class="settings-room-detail-header">
              <button
                class="settings-pin-button"
                type="button"
                :disabled="isBusy(selectedRoomDetail)"
                :aria-label="selectedRoomDetail.pinned ? `Unpin ${selectedRoomDetail.displayName}` : `Pin ${selectedRoomDetail.displayName}`"
                :title="selectedRoomDetail.pinned ? 'Unpin room' : 'Pin room'"
                :data-active="selectedRoomDetail.pinned"
                @click="$emit('toggle-pin-room', selectedRoomDetail)"
              >
                <Pin aria-hidden="true" />
              </button>
              <div class="settings-room-copy">
                <div class="settings-room-title-line">
                  <h2>{{ selectedRoomDetail.displayName }}</h2>
                  <span v-if="selectedRoomDetail.archived" class="state-pill" data-state="offline">left</span>
                  <span v-else-if="selectedRoomDetail.pinned" class="state-pill" data-state="installed">pinned</span>
                </div>
                <p>{{ roomUrl(selectedRoomDetail) }}</p>
              </div>
              <div class="settings-room-actions">
                <button
                  class="ghost-button settings-compact-button"
                  type="button"
                  :disabled="isBusy(selectedRoomDetail)"
                  @click="copyRoomUrl(selectedRoomDetail)"
                >
                  {{ copiedRoomUrl === roomUrl(selectedRoomDetail) ? "Copied" : "Copy URL" }}
                </button>
                <button
                  v-if="!selectedRoomDetail.archived"
                  class="ghost-button settings-compact-button"
                  type="button"
                  :disabled="isBusy(selectedRoomDetail)"
                  @click="$emit('open-room', selectedRoomDetail)"
                >
                  Open room
                </button>
              </div>
            </header>

            <dl class="settings-room-detail-grid">
              <div>
                <dt>Role</dt>
                <dd>{{ roleSourceLabel(selectedRoomDetail) }}</dd>
              </div>
              <div>
                <dt>Last opened</dt>
                <dd>{{ lastOpenedLabel(selectedRoomDetail) }}</dd>
              </div>
              <div>
                <dt>Focus rooms</dt>
                <dd>{{ selectedRoomDetail.focusRooms.length }}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{{ selectedRoomDetail.canDelete ? "By you" : "Joined" }}</dd>
              </div>
            </dl>

            <section class="settings-room-detail-section">
              <h3>Focus rooms</h3>
              <div v-if="selectedRoomDetail.focusRooms.length" class="settings-focus-list">
                <span v-for="focusRoom in selectedRoomDetail.focusRooms" :key="focusRoom.roomIdentifier">
                  {{ focusRoom.displayName }}
                </span>
              </div>
              <p v-else class="settings-muted-note">No focus rooms yet.</p>
            </section>

            <footer class="settings-room-footer settings-room-detail-actions">
              <button
                v-if="selectedRoomDetail.archived"
                class="primary-button"
                type="button"
                :disabled="isBusy(selectedRoomDetail)"
                :data-testid="`settings-restore-room-${slugify(selectedRoomDetail.roomIdentifier)}`"
                @click="$emit('restore-room', selectedRoomDetail)"
              >
                {{ busyLabel(selectedRoomDetail, "restore", "Restore") }}
              </button>
              <button
                v-else-if="selectedRoomDetail.canLeave"
                class="ghost-button"
                type="button"
                :disabled="isBusy(selectedRoomDetail)"
                :data-testid="`settings-leave-room-${slugify(selectedRoomDetail.roomIdentifier)}`"
                @click="$emit('leave-room', selectedRoomDetail)"
              >
                {{ busyLabel(selectedRoomDetail, "leave", "Leave room") }}
              </button>
              <button
                v-if="selectedRoomDetail.canDelete"
                class="ghost-button settings-danger-button"
                type="button"
                :disabled="isBusy(selectedRoomDetail)"
                :data-testid="`settings-delete-room-${slugify(selectedRoomDetail.roomIdentifier)}`"
                @click="$emit('delete-room', selectedRoomDetail)"
              >
                {{ busyLabel(selectedRoomDetail, "delete", "Delete room permanently") }}
              </button>
              <span v-else-if="selectedRoomDetail.deleteReason" class="settings-muted-note" :title="selectedRoomDetail.deleteReason">
                Protected
              </span>
            </footer>
          </article>
        </template>

        <template v-else>
          <div class="settings-room-toolbar" data-testid="settings-room-toolbar">
            <label class="settings-search">
              <span>Search rooms</span>
              <input v-model="roomSearch" type="search" placeholder="Search room, URL, or source" />
            </label>
            <div v-if="activePane === 'rooms:defaults'" class="settings-filter-group" role="tablist" aria-label="Room filters">
              <button
                v-for="filter in roomFilters"
                :key="filter.id"
                class="settings-filter"
                type="button"
                :data-active="roomFilter === filter.id"
                :data-testid="`settings-filter-${filter.id}`"
                @click="roomFilter = filter.id"
              >
                {{ filter.label }}
              </button>
            </div>
            <span class="state-pill settings-room-count-pill" data-state="connected">{{ roomCountLabel }}</span>
          </div>

          <p
            v-if="feedback"
            class="settings-feedback"
            :data-state="feedback.state"
            data-testid="settings-feedback"
          >
            {{ feedback.message }}
          </p>

          <div class="surface-list settings-room-list" data-testid="settings-room-list">
            <article
              v-for="room in filteredRooms"
              :key="room.roomIdentifier"
              class="settings-room-row"
              role="button"
              tabindex="0"
              :data-archived="room.archived"
              :data-selected="room.roomIdentifier === selectedRoomDetailIdentifier"
              :data-testid="`settings-room-${slugify(room.roomIdentifier)}`"
              @click="showRoomDetail(room)"
              @keydown.enter.prevent="showRoomDetail(room)"
              @keydown.space.prevent="showRoomDetail(room)"
            >
              <button
                class="settings-pin-button"
                type="button"
                :disabled="isBusy(room)"
                :aria-label="room.pinned ? `Unpin ${room.displayName}` : `Pin ${room.displayName}`"
                :title="room.pinned ? 'Unpin room' : 'Pin room'"
                :data-active="room.pinned"
                @click.stop="$emit('toggle-pin-room', room)"
              >
                <Pin aria-hidden="true" />
              </button>
              <div class="settings-room-copy">
                <div class="settings-room-title-line">
                  <p class="surface-title">{{ room.displayName }}</p>
                  <span v-if="room.archived" class="state-pill" data-state="offline">left</span>
                  <span v-else-if="room.pinned" class="state-pill" data-state="installed">pinned</span>
                </div>
                <p class="surface-subtitle">{{ room.roomIdentifier }}</p>
              </div>
              <div class="settings-room-meta">
                <span>{{ roleSourceLabel(room) }}</span>
                <span>{{ lastOpenedLabel(room) }}</span>
                <span>{{ room.focusRooms.length }} focus {{ room.focusRooms.length === 1 ? "room" : "rooms" }}</span>
              </div>
              <div class="settings-room-actions">
                <button
                  class="ghost-button settings-compact-button"
                  type="button"
                  :disabled="isBusy(room)"
                  @click.stop="copyRoomUrl(room)"
                >
                  {{ copiedRoomUrl === roomUrl(room) ? "Copied" : "Copy URL" }}
                </button>
                <button
                  class="ghost-button settings-icon-button"
                  type="button"
                  :disabled="isBusy(room)"
                  :aria-label="`View ${room.displayName} details`"
                  title="View room details"
                  @click.stop="showRoomDetail(room)"
                >
                  <ArrowRight aria-hidden="true" />
                </button>
              </div>
            </article>

            <article v-if="!filteredRooms.length" class="surface-row single-line" data-testid="settings-rooms-empty">
              <p class="surface-title">{{ emptyRoomsLabel }}</p>
            </article>
          </div>
        </template>
      </section>

      <section v-else-if="activePane === 'system:setup'" class="settings-panel settings-setup-panel" data-testid="settings-setup-panel">
        <McpInstallOnboardingView
          :state="mcpInstallState"
          :selected-target-ids="selectedMcpTargetIds"
          :wizard-step="mcpWizardStep"
          :busy="mcpInstallBusy"
          :feedback="mcpInstallFeedback"
          :can-install="setupApiAvailable"
          @select-target="$emit('select-mcp-target', $event)"
          @select-all-targets="$emit('select-all-mcp-targets')"
          @clear-target-selection="$emit('clear-mcp-target-selection')"
          @continue="$emit('continue-mcp')"
          @back="$emit('back-mcp')"
          @install-targets="$emit('install-mcp-targets')"
          @finish="$emit('finish-mcp')"
        />
      </section>

      <section v-else-if="activePane === 'system:app-agent'" class="settings-panel" data-testid="settings-app-agent-panel">
        <div class="settings-control-list">
          <SettingsRow
            title="App Agent"
            :description="appAgentStatusDescription"
            :badge="appAgentStatusLabel"
            :badge-state="appAgentBadgeState"
          />

          <SettingsRow
            title="Planner model"
            description="The model interprets intent and selects typed App Agent actions. Side effects still run through the app registry."
          >
            <label class="settings-field">
              <span>Model slug</span>
              <input
                v-model="appAgentModelDraft"
                type="text"
                placeholder="anthropic/claude-3.5-sonnet"
                autocomplete="off"
                data-testid="settings-app-agent-model"
              />
            </label>
          </SettingsRow>

          <SettingsRow
            title="Model provider key"
            :description="appAgentKeyDescription"
            :badge="appAgentSettings?.hasApiKey ? 'stored' : 'missing'"
            :badge-state="appAgentSettings?.hasApiKey ? 'connected' : 'offline'"
          >
            <label class="settings-field">
              <span>API key</span>
              <input
                v-model="appAgentApiKeyDraft"
                type="password"
                :placeholder="appAgentSettings?.hasApiKey ? 'Leave blank to keep saved key' : 'Provider API key'"
                autocomplete="off"
                data-testid="settings-app-agent-api-key"
              />
            </label>
          </SettingsRow>

          <SettingsRow
            title="Settings file"
            description="The key is encrypted before it is written when Electron secure storage is available."
          >
            <code>{{ appAgentSettings?.settingsPath || "Settings path unavailable" }}</code>
            <template #action>
              <button
                class="primary-button settings-action-button"
                type="button"
                :disabled="appAgentBusy"
                data-testid="settings-app-agent-save"
                @click="saveAppAgentSettings"
              >
                <Save aria-hidden="true" />
                <span>{{ appAgentBusy ? "Saving" : "Save" }}</span>
              </button>
            </template>
          </SettingsRow>
        </div>

        <div class="app-agent-registry-panel" data-testid="settings-app-agent-actions">
          <header class="app-agent-registry-header">
            <div>
              <p class="settings-section-kicker">Capabilities</p>
              <h3>What App Agent can do</h3>
              <p>
                Read-only view of the app actions this assistant can review and
                run for you.
              </p>
            </div>
            <span class="state-pill" data-state="installed">{{ appAgentActionCountLabel }}</span>
          </header>

          <div class="app-agent-action-list">
            <article
              v-for="action in sortedAppAgentActions"
              :key="action.id"
              class="app-agent-action-row"
              :data-risk="action.risk"
              :data-testid="`settings-app-agent-action-${slugify(action.id)}`"
            >
              <div class="app-agent-action-main">
                <div class="app-agent-action-title-line">
                  <div class="app-agent-action-title-copy">
                    <strong>{{ actionDisplayName(action) }}</strong>
                    <span>{{ actionCapabilityName(action) }} · {{ actionCategoryLabel(action.category) }}</span>
                  </div>
                  <div class="app-agent-action-policies">
                    <span class="state-pill" :data-state="actionRiskState(action.risk)">
                      {{ actionRiskLabel(action.risk) }}
                    </span>
                    <span class="state-pill" :data-state="action.requiresConfirmation ? 'starting' : 'connected'">
                      {{ action.requiresConfirmation ? "Asks first" : "Runs directly" }}
                    </span>
                  </div>
                </div>
                <p>{{ actionDisplayDescription(action) }}</p>
                <div class="app-agent-action-footer">
                  <span>{{ actionRefreshTargetsLabel(action) }}</span>
                </div>
              </div>
            </article>

            <article v-if="!sortedAppAgentActions.length" class="surface-row single-line">
              <p class="surface-title">No App Agent actions are registered.</p>
            </article>
          </div>
        </div>

        <p
          v-if="appAgentFeedback"
          class="settings-feedback"
          :data-state="appAgentFeedback.state"
          data-testid="settings-app-agent-feedback"
        >
          {{ appAgentFeedback.message }}
        </p>
      </section>

      <section v-else-if="activePane === 'system:runtime'" class="settings-panel" data-testid="settings-runtime-panel">
        <div class="settings-control-list">
          <SettingsRow title="Desktop runtime" :description="apiEndpointLabel" badge="local" badge-state="connected">
            <code v-if="appInfo?.workspaceRoot">{{ appInfo.workspaceRoot }}</code>
            <template #action>
              <code>{{ versionLabel }}</code>
            </template>
          </SettingsRow>

          <SettingsRow title="Repository root" :description="repoStatus?.rootPath || 'Repository status unavailable.'" />
          <SettingsRow title="Current branch" :description="repoStatus?.branch || 'No active branch.'" />
        </div>

        <div class="surface-list settings-system-list" data-testid="repo-worktrees-list">
          <article class="surface-row single-line">
            <div>
              <p class="surface-title">Worktrees</p>
              <p class="surface-subtitle">Open branches that can map cleanly to rooms and focused work.</p>
            </div>
          </article>

          <article
            v-for="worktree in repoStatus?.worktrees || []"
            :key="worktree.path"
            class="surface-row"
            :data-current="worktree.isCurrent"
            :data-testid="`repo-worktree-${worktree.path}`"
          >
            <div>
              <p class="surface-title">{{ worktree.branch || "Detached worktree" }}</p>
              <p class="surface-subtitle">{{ worktree.path }}</p>
            </div>
            <div class="surface-meta">
              <span class="state-pill" :data-state="worktree.isCurrent ? 'connected' : 'away'">
                {{ worktree.isCurrent ? "current" : "open" }}
              </span>
              <code>{{ worktree.head.slice(0, 10) }}</code>
            </div>
          </article>

          <article v-if="!repoStatus?.worktrees?.length" class="surface-row single-line" data-testid="repo-worktrees-empty">
            <p class="surface-title">No worktrees discovered yet.</p>
          </article>
        </div>
      </section>

      <section v-else-if="activePane === 'system:mcp'" class="settings-panel" data-testid="settings-mcp-panel">
        <div class="surface-list settings-system-list">
          <article
            v-for="target in mcpInstallState.targets"
            :key="target.id"
            class="surface-row"
            :data-testid="`settings-mcp-target-${target.id}`"
          >
            <div>
              <p class="surface-title">{{ target.name }}</p>
              <p class="surface-subtitle">{{ target.configPath }}</p>
              <p v-if="target.configIssue" class="surface-subtitle">{{ target.configIssue }}</p>
              <ul v-if="target.configPaths?.length" class="settings-mcp-config-paths">
                <li v-for="configPath in target.configPaths" :key="configPath.path">
                  <span>{{ configPath.label }}:</span>
                  <em :data-status="configPath.status">{{ configPathStatusLabel(configPath.status) }}</em>
                  <code>{{ configPath.path }}</code>
                  <small v-if="configPath.issue">{{ configPath.issue }}</small>
                </li>
              </ul>
            </div>
            <div class="surface-meta">
              <span class="state-pill" :data-state="target.status === 'installed' ? 'installed' : 'starting'">
                {{ target.status.replace(/_/g, " ") }}
              </span>
            </div>
          </article>
        </div>
      </section>

      <section v-else-if="activePane === 'system:agents'" class="settings-panel" data-testid="settings-agents-panel">
        <div class="surface-list settings-system-list" data-testid="worker-status-list">
          <article
            v-for="worker in workers"
            :key="worker.id"
            class="surface-row"
            :data-testid="`worker-row-${worker.id}`"
          >
            <div>
              <p class="surface-title">{{ worker.runtime }}</p>
              <p class="surface-subtitle">{{ worker.detail }}</p>
            </div>
            <div class="surface-meta">
              <span class="state-pill" :data-state="worker.state">{{ worker.state.replace(/_/g, " ") }}</span>
              <code>{{ worker.roomId || "No room yet" }}</code>
            </div>
          </article>

          <article v-if="!workers.length" class="surface-row single-line" data-testid="worker-status-empty">
            <p class="surface-title">No app-managed workers yet.</p>
            <p class="surface-subtitle">This surface will fill in once the desktop app starts launching and supervising workers directly.</p>
          </article>
        </div>
      </section>

      <section v-else class="settings-panel" data-testid="settings-diagnostics-panel">
        <div class="surface-list settings-system-list" data-testid="diagnostics-list">
          <article
            v-for="note in diagnosticsNotes"
            :key="note"
            class="surface-row single-line"
            :data-testid="`diagnostic-note-${slugify(note)}`"
          >
            <p class="surface-title">{{ note }}</p>
          </article>
          <article v-if="!diagnosticsNotes.length" class="surface-row single-line" data-testid="diagnostics-empty">
            <p class="surface-title">No diagnostic notes right now.</p>
          </article>
        </div>
      </section>
    </main>
  </section>
</template>

<script setup lang="ts">
import {
  Activity,
  ArchiveRestore,
  ArrowRight,
  Bot,
  CircleUser,
  Cloud,
  CloudUpload,
  Copy,
  Database,
  GitBranch,
  HardDrive,
  KeyRound,
  LogIn,
  LogOut,
  Pin,
  RefreshCw,
  Save,
  ServerCog,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useCopyValueIndicator } from "../../../composables/useCopyIndicator";
import { isLocalGitRoom } from "../../../domain/git-rooms";
import { wordInitials } from "../../../domain/initials";
import { buildLetAgentsRoomCopyValue } from "../../../domain/room-urls";
import type {
  DesktopAccountRoomEntry,
  DesktopAppAgentActionMetadata,
  DesktopAppAgentSaveSettingsInput,
  DesktopAppAgentSettingsStatus,
  DesktopAuthStatus,
  DesktopAppInfo,
  DesktopChatStorageSettings,
  DesktopMcpInstallConfigPath,
  DesktopMcpInstallState,
  DesktopMcpInstallTargetId,
  RepoStatus,
  WorkerSnapshot,
} from "../../../../../electron/ipc-types";
import McpInstallOnboardingView from "./McpInstallOnboardingView.vue";
import SettingsRow from "../settings/SettingsRow.vue";
import SettingsSidebar from "../settings/SettingsSidebar.vue";
import type { SettingsNavGroup, SettingsPaneId } from "../settings/types";
import type { DesktopMcpWizardStep } from "../setup/types";
import { buildLetAgentsRoomUrl } from "../../../domain/room-urls";

type SettingsFeedback = {
  message: string;
  state: "error" | "info" | "success";
};

type RoomFilter = "active" | "pinned" | "created" | "joined";

const props = defineProps<{
  accountRooms: DesktopAccountRoomEntry[];
  appInfo: DesktopAppInfo | null;
  appAgentActions: DesktopAppAgentActionMetadata[];
  appAgentBusy: boolean;
  appAgentFeedback: SettingsFeedback | null;
  appAgentSettings: DesktopAppAgentSettingsStatus | null;
  authStatus: DesktopAuthStatus | null;
  busy: boolean;
  chatStorageAvailable: boolean;
  diagnosticsNotes: string[];
  feedback: SettingsFeedback | null;
  initialPane: SettingsPaneId;
  chatStorageBusy: boolean;
  chatStorageFeedback: SettingsFeedback | null;
  chatStorageSettings: DesktopChatStorageSettings | null;
  mcpInstallBusy: boolean;
  mcpInstallFeedback: string | null;
  mcpInstallState: DesktopMcpInstallState;
  mcpWizardStep: DesktopMcpWizardStep;
  repoStatus: RepoStatus | null;
  roomActionBusyKey: string | null;
  selectedMcpTargetIds: DesktopMcpInstallTargetId[];
  selectedRoomIdentifier: string | null;
  setupApiAvailable: boolean;
  workers: WorkerSnapshot[];
}>();

const emit = defineEmits<{
  "back-mcp": [];
  "back-to-app": [];
  "clear-mcp-target-selection": [];
  "continue-mcp": [];
  "delete-room": [room: DesktopAccountRoomEntry];
  "finish-mcp": [];
  "install-mcp-targets": [];
  "leave-room": [room: DesktopAccountRoomEntry];
  "open-room": [room: DesktopAccountRoomEntry];
  "restore-room": [room: DesktopAccountRoomEntry];
  "select-all-mcp-targets": [];
  "select-mcp-target": [targetId: DesktopMcpInstallTargetId];
  "save-app-agent-settings": [input: DesktopAppAgentSaveSettingsInput];
  "set-chat-storage-mode": [mode: DesktopChatStorageSettings["mode"]];
  "sync-local-chat": [];
  "toggle-pin-room": [room: DesktopAccountRoomEntry];
  refresh: [];
  "sign-out": [];
  "start-auth": [];
}>();

const activePane = ref<SettingsPaneId>(props.initialPane);
const { copiedValue: copiedRoomUrl, copy: copyRoomUrlToClipboard } = useCopyValueIndicator(1400);
const { copiedValue: copiedText, copy: copyTextValueToClipboard } = useCopyValueIndicator(1400);
const roomFilter = ref<RoomFilter>("active");
const roomSearch = ref("");
const selectedRoomDetailIdentifier = ref<string | null>(null);
const appAgentModelDraft = ref("");
const appAgentApiKeyDraft = ref("");

function configPathStatusLabel(
  status: DesktopMcpInstallConfigPath["status"],
): string {
  if (status === "installed") return "ready";
  if (status === "needs_attention") return "repair";
  return "not installed";
}

const settingsNavGroups: SettingsNavGroup[] = [
  {
    label: "Account",
    items: [
      { id: "account:profile", title: "Profile", description: "Identity and sign-in", icon: CircleUser },
    ],
  },
  {
    label: "Rooms",
    items: [
      { id: "rooms:defaults", title: "Rooms", description: "Active, pinned, and joined", icon: SlidersHorizontal },
      { id: "rooms:left", title: "Left rooms", description: "Restore rooms you left", icon: ArchiveRestore },
      { id: "rooms:danger", title: "Room removal", description: "Leave and delete rooms", icon: Trash2 },
    ],
  },
  {
    label: "Storage",
    items: [
      { id: "storage:chat", title: "Chat storage", description: "Cloud or local messages", icon: Cloud },
      { id: "storage:sync", title: "Publishing", description: "Manual cloud upload", icon: CloudUpload },
      { id: "storage:database", title: "Local database", description: "Local database files", icon: Database },
    ],
  },
  {
    label: "System",
    items: [
      { id: "system:setup", title: "Setup", description: "Install LetAgents", icon: Wrench },
      { id: "system:app-agent", title: "App Agent", description: "App control", icon: KeyRound },
      { id: "system:runtime", title: "Runtime", description: "Repo and desktop state", icon: GitBranch },
      { id: "system:mcp", title: "Agent app connections", description: "Connected apps", icon: ServerCog },
      { id: "system:agents", title: "Agents", description: "Status and availability", icon: Bot },
      { id: "system:diagnostics", title: "Troubleshooting", description: "Local truth and recovery", icon: Activity },
    ],
  },
];

const roomFilters: Array<{ id: RoomFilter; label: string }> = [
  { id: "active", label: "Active" },
  { id: "pinned", label: "Pinned" },
  { id: "created", label: "Created" },
  { id: "joined", label: "Joined" },
];

const activeRoomCount = computed(() => props.accountRooms.filter((room) => !room.archived).length);
const archivedRoomCount = computed(() => props.accountRooms.filter((room) => room.archived).length);
const createdRoomCount = computed(() => props.accountRooms.filter((room) => room.canDelete && !room.archived).length);
const focusRoomCount = computed(() => props.accountRooms.reduce((total, room) => total + room.focusRooms.length, 0));

const isRoomPane = computed(() => activePane.value.startsWith("rooms:"));
const isStoragePane = computed(() => activePane.value.startsWith("storage:"));

const activePaneItem = computed(() =>
  settingsNavGroups.flatMap((group) => group.items).find((item) => item.id === activePane.value) || settingsNavGroups[2].items[0],
);

const activePaneBreadcrumb = computed(() => {
  const group = settingsNavGroups.find((navGroup) => navGroup.items.some((item) => item.id === activePane.value));
  return `Settings / ${group?.label || "Storage"}`;
});

const activePaneTitle = computed(() => activePaneItem.value.title);
const activePaneDescription = computed(() => {
  if (activePane.value === "rooms:defaults") return "Manage active, pinned, and joined rooms.";
  if (activePane.value === "rooms:left") return "Restore rooms you previously left.";
  if (activePane.value === "storage:chat") return "Choose where room messages are stored before upload.";
  if (activePane.value === "rooms:danger") return "Review actions that remove access or delete rooms you created.";
  if (activePane.value === "system:app-agent") return "Configure the app assistant and see what it can do in the app.";
  return activePaneItem.value.description;
});

const filteredRooms = computed(() => {
  const search = roomSearch.value.trim().toLowerCase();
  const effectiveFilter = activePane.value === "rooms:left"
    ? "left"
    : activePane.value === "rooms:danger"
      ? "danger"
      : roomFilter.value;

  return props.accountRooms
    .filter((room) => {
      if (effectiveFilter === "danger" && !room.canLeave && !room.canDelete && !room.archived) return false;
      if (effectiveFilter === "active" && room.archived) return false;
      if (effectiveFilter === "pinned" && (!room.pinned || room.archived)) return false;
      if (effectiveFilter === "created" && (!room.canDelete || room.archived)) return false;
      if (effectiveFilter === "joined" && (room.canDelete || room.archived)) return false;
      if (effectiveFilter === "left" && !room.archived) return false;
      if (!search) return true;
      const searchable = [
        room.displayName,
        room.roomIdentifier,
        room.source || "",
        ...room.focusRooms.flatMap((focusRoom) => [
          focusRoom.displayName,
          focusRoom.roomIdentifier,
          focusRoom.sourceTaskId || "",
          focusRoom.focusKey || "",
        ]),
      ].join(" ").toLowerCase();
      return searchable.includes(search);
    })
    .sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.lastOpenedAt || "").localeCompare(a.lastOpenedAt || "");
    });
});

const selectedRoomDetail = computed(() => {
  if (!selectedRoomDetailIdentifier.value) return null;
  return props.accountRooms.find((room) => room.roomIdentifier === selectedRoomDetailIdentifier.value) || null;
});
const selectedAccountRoom = computed(() => {
  const selectedIdentifier = props.selectedRoomIdentifier?.trim().toLowerCase();
  if (!selectedIdentifier) return null;
  return props.accountRooms.find(
    (room) => room.roomIdentifier.trim().toLowerCase() === selectedIdentifier
  ) || null;
});
const selectedRoomIsLocalGitRoom = computed(() =>
  /^git-room:local:/i.test(props.selectedRoomIdentifier || "") ||
    Boolean(selectedAccountRoom.value && isLocalGitRoom(selectedAccountRoom.value))
);

const roomCountLabel = computed(() => {
  if (activePane.value === "rooms:left") return `${archivedRoomCount.value} left`;
  if (activePane.value === "rooms:danger") return `${filteredRooms.value.length} actionable`;
  if (roomFilter.value === "created") return `${createdRoomCount.value} created`;
  return `${filteredRooms.value.length} ${roomFilter.value}`;
});

const accountTitle = computed(() => {
  if (!props.authStatus?.authenticated || !props.authStatus.account) return "No account connected";
  return props.authStatus.account.displayName || props.authStatus.account.login;
});

const accountHandleLabel = computed(() => {
  if (!props.authStatus?.authenticated || !props.authStatus.account) return "No GitHub account connected";
  return `@${props.authStatus.account.login}`;
});

const accountPurposeLabel = computed(() => {
  if (props.authStatus?.authenticated) {
    return "Shown to humans and agents in your LetAgents rooms.";
  }
  return props.authStatus?.error || "Connect GitHub to show your identity in LetAgents rooms.";
});

const accountInitials = computed(() => wordInitials(accountTitle.value, "LA"));

const providerLabel = computed(() => {
  const provider = props.authStatus?.account?.provider || "github";
  return provider === "github" ? "GitHub" : provider;
});

const providerConnectionLabel = computed(() =>
  props.authStatus?.authenticated ? `Connected with ${providerLabel.value}` : "Not connected",
);

const apiEndpointLabel = computed(() => props.authStatus?.apiUrl || props.appInfo?.apiUrl || "API endpoint unavailable");

const emptyRoomsLabel = computed(() => {
  if (roomSearch.value.trim()) return "No rooms match that search.";
  if (activePane.value === "rooms:left") return "No left rooms.";
  if (activePane.value === "rooms:danger") return "No room actions are available.";
  if (roomFilter.value === "pinned") return "No pinned rooms yet.";
  if (roomFilter.value === "created") return "No rooms created by you.";
  if (roomFilter.value === "joined") return "No joined rooms yet.";
  return "No account rooms found.";
});

const versionLabel = computed(() => {
  if (!props.appInfo) return "version unavailable";
  return `Electron ${props.appInfo.versions.electron}`;
});

const chatStorageModeLabel = computed(() =>
  props.chatStorageSettings?.mode === "local" ? "local" : "cloud",
);

const chatStorageSubtitle = computed(() => {
  if (props.chatStorageSettings?.mode === "local") {
    return "New rooms default to local storage on this computer.";
  }
  return "New rooms default to LetAgents cloud storage.";
});

const chatStorageSavedLabel = computed(() => {
  if (!props.chatStorageSettings?.savedAt) return "Never";
  const timestamp = new Date(props.chatStorageSettings.savedAt);
  if (Number.isNaN(timestamp.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
});

const appAgentStatusLabel = computed(() =>
  props.appAgentSettings?.configured ? "configured" : "setup needed",
);

const appAgentBadgeState = computed(() =>
  props.appAgentSettings?.configured ? "connected" : "offline",
);

const appAgentStatusDescription = computed(() => {
  if (props.appAgentSettings?.error) return props.appAgentSettings.error;
  if (props.appAgentSettings?.configured) {
    return `Ready to control the app with ${props.appAgentSettings.model}.`;
  }
  return "Add a tool-capable planner model before running app actions.";
});

const sortedAppAgentActions = computed(() =>
  [...props.appAgentActions].sort((left, right) =>
    `${left.category}:${actionDisplayName(left)}`.localeCompare(`${right.category}:${actionDisplayName(right)}`),
  ),
);

const appAgentActionCountLabel = computed(() =>
  `${props.appAgentActions.length} ${props.appAgentActions.length === 1 ? "action" : "actions"}`,
);

const appAgentSavedLabel = computed(() => {
  if (!props.appAgentSettings?.savedAt) return "never";
  const timestamp = new Date(props.appAgentSettings.savedAt);
  if (Number.isNaN(timestamp.getTime())) return "recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
});

const appAgentKeyDescription = computed(() => {
  if (!props.appAgentSettings?.savedAt) return "No provider key has been saved yet.";
  return `Last saved ${appAgentSavedLabel.value}.`;
});

function actionRiskState(risk: DesktopAppAgentActionMetadata["risk"]): string {
  if (risk === "low") return "connected";
  if (risk === "medium") return "starting";
  return "failed";
}

function actionRiskLabel(risk: DesktopAppAgentActionMetadata["risk"]): string {
  if (risk === "low") return "Low risk";
  if (risk === "medium") return "Review first";
  return "High risk";
}

function actionCategoryLabel(category: DesktopAppAgentActionMetadata["category"]): string {
  return category === "rooms" ? "Rooms" : "Settings";
}

function actionDisplayName(action: DesktopAppAgentActionMetadata): string {
  return action.displayName || readableActionId(action.id);
}

function actionCapabilityName(action: DesktopAppAgentActionMetadata): string {
  return action.capabilityName || readableActionId(action.id);
}

function actionDisplayDescription(action: DesktopAppAgentActionMetadata): string {
  return action.displayDescription || action.description;
}

function actionRefreshTargetsLabel(action: DesktopAppAgentActionMetadata): string {
  const labels = action.refreshTargets.map((target) => {
    if (target === "rooms") return "room list";
    if (target === "active_room") return "current room";
    if (target === "foreground") return "visible app state";
    return "settings";
  });
  return labels.length
    ? `Updates ${labels.join(", ")} after it runs.`
    : "No visible update after it runs.";
}

function readableActionId(actionId: string): string {
  return actionId
    .replace(/^[^.]+\./, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

watch(
  () => props.initialPane,
  (nextPane) => {
    activePane.value = nextPane;
    selectedRoomDetailIdentifier.value = null;
  }
);

watch(
  () => props.appAgentSettings?.model,
  (model) => {
    appAgentModelDraft.value = model || "";
    appAgentApiKeyDraft.value = "";
  },
  { immediate: true },
);

function selectPane(paneId: SettingsPaneId): void {
  activePane.value = paneId;
  selectedRoomDetailIdentifier.value = null;
}

function saveAppAgentSettings(): void {
  emit("save-app-agent-settings", {
    model: appAgentModelDraft.value,
    openRouterApiKey: appAgentApiKeyDraft.value.trim() || undefined,
  });
}

function actionKey(action: "delete" | "leave" | "pin" | "restore", room: DesktopAccountRoomEntry): string {
  return `${action}:${room.roomIdentifier}`;
}

function busyLabel(room: DesktopAccountRoomEntry, action: "delete" | "leave" | "restore", fallback: string): string {
  return props.roomActionBusyKey === actionKey(action, room)
    ? action === "delete" ? "Deleting" : action === "restore" ? "Restoring" : "Leaving"
    : fallback;
}

function isBusy(room: DesktopAccountRoomEntry): boolean {
  return props.busy
    || props.roomActionBusyKey === actionKey("leave", room)
    || props.roomActionBusyKey === actionKey("delete", room)
    || props.roomActionBusyKey === actionKey("pin", room)
    || props.roomActionBusyKey === actionKey("restore", room);
}

async function copyText(value: string): Promise<void> {
  if (!value) return;
  await copyTextValueToClipboard(value);
}

function roomUrl(room: DesktopAccountRoomEntry): string {
  return buildLetAgentsRoomCopyValue(room.roomIdentifier);
}

function showRoomDetail(room: DesktopAccountRoomEntry): void {
  selectedRoomDetailIdentifier.value = room.roomIdentifier;
}

async function copyRoomUrl(room: DesktopAccountRoomEntry): Promise<void> {
  const value = roomUrl(room);
  if (!value) return;
  await copyRoomUrlToClipboard(value);
}

function lastOpenedLabel(room: DesktopAccountRoomEntry): string {
  if (!room.lastOpenedAt) return "No recent activity";
  const timestamp = new Date(room.lastOpenedAt);
  if (Number.isNaN(timestamp.getTime())) return "Recent";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function roleSourceLabel(room: DesktopAccountRoomEntry): string {
  const role = room.role === "admin" ? "Admin" : "Participant";
  if (room.archived) return `${role} · Left`;
  if (room.source === "create_invite") return `${role} · Created`;
  if (room.source === "open_room") return `${role} · Opened`;
  if (room.source === "agent") return `${role} · Agent activity`;
  if (room.source === "participant") return `${role} · Participant`;
  if (room.source === "focus") return `${role} · Focus activity`;
  return role;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "room";
}
</script>
