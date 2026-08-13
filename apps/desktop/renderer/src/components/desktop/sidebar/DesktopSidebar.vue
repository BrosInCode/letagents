<template>
  <aside
    class="app-sidebar"
    :data-selection-active="selectionActive"
    data-testid="desktop-sidebar"
    @keydown.esc="handleSidebarEscape"
    @dragover="clearSidebarDropTarget"
    @drop.prevent="cancelSidebarDrag"
  >
    <p id="sidebar-room-reorder-instructions" class="sr-only">
      Drag rooms to reorder them. Press Option plus Up or Down Arrow to move the focused room.
    </p>
    <p class="sr-only" role="status" aria-live="polite">{{ reorderAnnouncement }}</p>
    <div class="sidebar-topbar" :data-selection-active="selectionActive">
      <template v-if="selectionActive">
        <div class="sidebar-selection-summary" aria-live="polite">
          <ListChecks aria-hidden="true" />
          <strong>{{ selectedEntryIds.length }}</strong>
          <span>{{ selectedEntryIds.length === 1 ? "room selected" : "rooms selected" }}</span>
        </div>
        <button
          class="sidebar-topbar-action"
          type="button"
          aria-label="Finish selecting rooms"
          title="Finish selecting rooms"
          data-testid="sidebar-selection-close"
          :disabled="Boolean(batchActionBusy)"
          @click="$emit('cancel-selection')"
        >
          <X aria-hidden="true" />
        </button>
      </template>
      <template v-else>
      <button
        class="sidebar-collapse-button"
        type="button"
        aria-label="Hide sidebar"
        title="Hide sidebar"
        data-testid="sidebar-cycle-button"
        @click="$emit('cycle-sidebar')"
      >
        <svg class="sidebar-toggle-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4.5 3.5h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" />
          <path d="M12.5 3.5v13" />
          <path d="m7.5 7.5 2.5 2.5-2.5 2.5" />
        </svg>
      </button>
      <div class="sidebar-topbar-actions">
        <button
          class="sidebar-topbar-action"
          type="button"
          aria-label="Select rooms"
          title="Select rooms"
          data-testid="sidebar-select-rooms-button"
          @click="startSelection()"
        >
          <ListChecks aria-hidden="true" />
        </button>
        <button
          ref="searchButton"
          class="sidebar-search-button"
          type="button"
          :data-active="searchOpen"
          :aria-expanded="searchOpen"
          aria-controls="sidebar-room-search"
          :aria-label="searchOpen ? 'Close room search' : 'Search rooms'"
          :title="searchOpen ? 'Close room search' : 'Search rooms'"
          data-testid="sidebar-search-button"
          @click="toggleSearch"
        >
          <X v-if="searchOpen" aria-hidden="true" />
          <Search v-else aria-hidden="true" />
        </button>
      </div>
      </template>
    </div>

    <section
      v-if="searchOpen"
      id="sidebar-room-search"
      class="sidebar-room-search"
      data-testid="sidebar-room-search"
    >
        <label class="sidebar-search-field">
          <Search aria-hidden="true" />
          <input
            ref="searchInput"
            v-model="searchQuery"
            type="search"
            placeholder="Search rooms"
            autocomplete="off"
            spellcheck="false"
            role="combobox"
            aria-label="Search rooms"
            aria-autocomplete="list"
            :aria-controls="searchResults.length ? 'sidebar-room-search-results' : undefined"
            :aria-expanded="Boolean(searchResults.length)"
            :aria-activedescendant="activeSearchResultId"
            data-testid="sidebar-room-search-input"
            @keydown="handleSearchKeydown"
          />
        </label>

        <div class="sidebar-search-summary" aria-live="polite">
          <span>Rooms</span>
          <span v-if="searchQuery.trim()">{{ searchResults.length }}</span>
        </div>

        <div
          v-if="searchQuery.trim() && searchResults.length"
          id="sidebar-room-search-results"
          class="sidebar-search-results"
          role="listbox"
        >
          <button
            v-for="(result, index) in searchResults"
            :id="searchResultId(result.entry.id)"
            :key="result.entry.id"
            class="sidebar-search-result"
            type="button"
            role="option"
            tabindex="-1"
            :aria-selected="index === activeSearchIndex"
            :data-active="index === activeSearchIndex"
            :data-testid="`sidebar-search-result-${result.entry.id}`"
            @pointerenter="activeSearchIndex = index"
            @click="selectSearchResult(result.entry)"
          >
            <span class="sidebar-search-result-icon" aria-hidden="true">
              <GitBranch v-if="result.entry.kind === 'branch'" />
              <MessageSquare v-else-if="result.entry.kind === 'focus'" />
              <House v-else />
            </span>
            <span class="sidebar-search-result-copy">
              <strong>{{ result.entry.title }}</strong>
              <small>{{ result.context }}</small>
            </span>
            <span v-if="result.entry.hasUnread" class="room-unread-dot" aria-label="Unread messages"></span>
          </button>
        </div>
        <p v-else-if="searchQuery.trim()" class="sidebar-search-empty">
          No rooms match “{{ searchQuery.trim() }}”
        </p>
        <p v-else class="sidebar-search-empty">Search by room, branch, or task.</p>
    </section>

    <div v-else class="sidebar-navigation" @contextmenu.prevent="openBackgroundContextMenu">
      <div class="sidebar-actions">
        <button
          v-if="selectionActive"
          class="sidebar-selection-scope"
          type="button"
          :disabled="!visibleSelectableEntries.length || Boolean(batchActionBusy)"
          data-testid="sidebar-select-visible"
          @click="toggleVisibleSelection"
        >
          <span class="sidebar-selection-scope-icon" :data-selected="allVisibleSelected" aria-hidden="true">
            <Check v-if="allVisibleSelected" />
          </span>
          <span>{{ allVisibleSelected ? "Clear visible" : "Select visible" }}</span>
          <small>{{ visibleSelectableEntries.length }}</small>
        </button>
        <button
          v-else
          class="sidebar-cta"
          type="button"
          data-testid="sidebar-new-room"
          @click="$emit('new-room')"
        >
          <span class="cta-plus" aria-hidden="true">
            <Plus />
          </span>
          <span>New room</span>
        </button>
        <button
          v-if="!selectionActive"
          class="sidebar-cta sidebar-rent-cta"
          type="button"
          :data-active="activeEntry.type === 'marketplace'"
          data-testid="sidebar-rent"
          @click="$emit('open-rent')"
        >
          <span class="cta-plus sidebar-rent-icon" aria-hidden="true"><Handshake /></span>
          <span>Rent</span>
          <span v-if="rentalRequestCount" class="sidebar-rent-count" :aria-label="`${rentalRequestCount} rental requests`">
            {{ rentalRequestCount > 99 ? '99+' : rentalRequestCount }}
          </span>
        </button>
      </div>

      <div class="sidebar-room-sections">
      <section v-if="pinnedProjectEntries.length" class="sidebar-pinned-section" data-testid="sidebar-section-pinned">
        <button
          class="sidebar-section-header pinned-section-header"
          type="button"
          :aria-expanded="!pinnedCollapsed"
          aria-controls="sidebar-pinned-rooms"
          :data-collapsed="pinnedCollapsed"
          data-testid="sidebar-pinned-heading"
          @click="$emit('toggle-pinned-collapsed')"
        >
          <span class="sidebar-heading">Pinned</span>
          <span class="sidebar-section-meta">
            <span class="section-count">{{ pinnedProjectEntries.length }}</span>
            <span class="sidebar-section-arrow" :data-collapsed="pinnedCollapsed" aria-hidden="true">
              <ChevronRight />
            </span>
          </span>
        </button>
        <Transition name="sidebar-pinned-reveal">
          <TransitionGroup
            v-if="!pinnedCollapsed"
            id="sidebar-pinned-rooms"
            name="sidebar-room-order"
            tag="div"
            class="pinned-list"
          >
          <article
            v-for="project in pinnedProjectEntries"
            :key="project.id"
            class="project-group pinned-project-group"
            :data-dragging="isParentDragging(project.id)"
            :data-drop-position="parentDropPosition(project.id)"
            :data-testid="`pinned-room-group-${project.id}`"
          >
            <div class="sidebar-project-row-shell">
              <button
                class="pinned-room"
                :aria-current="isSelectableRoom(project.parent) && activeEntry.id === project.parent.id ? 'page' : undefined"
                :data-active="isSelectableRoom(project.parent) && activeEntry.id === project.parent.id"
                :data-unread="project.parent.hasUnread"
                :data-selected="isEntrySelected(project.parent)"
                :data-sidebar-entry-id="project.parent.id"
                :aria-pressed="selectionActive && isSidebarRoomSelectable(project.parent) ? isEntrySelected(project.parent) : undefined"
                :aria-describedby="roomReorderEnabled ? 'sidebar-room-reorder-instructions' : undefined"
                :aria-keyshortcuts="roomReorderEnabled ? 'Alt+ArrowUp Alt+ArrowDown' : undefined"
                :draggable="roomReorderEnabled"
                type="button"
                :data-testid="`pinned-room-${project.parent.id}`"
                @click="handleProjectActivation($event, project)"
                @contextmenu.prevent.stop="openRoomContextMenu($event, project.parent, project.id)"
                @dragstart="startParentDrag($event, project)"
                @dragover.stop="handleParentDragOver($event, project)"
                @drop.stop="dropParentRoom($event, project)"
                @dragend="finishSidebarDrag"
                @keydown="handleParentReorderKeydown($event, project)"
              >
                <span
                  v-if="selectionActive && isSidebarRoomSelectable(project.parent)"
                  class="sidebar-selection-indicator"
                  :data-selected="isEntrySelected(project.parent)"
                  aria-hidden="true"
                >
                  <Check v-if="isEntrySelected(project.parent)" />
                </span>
                <span v-else class="pin-mark" aria-hidden="true">
                  <Pin />
                </span>
                <span class="pinned-main">
                  <span class="room-title-line">
                    <span class="pinned-title">{{ project.roomName }}</span>
                    <span
                      v-if="project.parent.hasUnread"
                      class="room-unread-dot"
                      aria-label="Unread messages"
                      title="Unread messages"
                    ></span>
                  </span>
                  <span class="pinned-meta">{{ projectSubtitle(project) }}</span>
                </span>
              </button>
              <button
                v-if="projectChildRooms(project).length"
                class="project-toggle"
                :data-collapsed="collapsedProjects[project.id]"
                type="button"
                :aria-label="`${collapsedProjects[project.id] ? 'Expand' : 'Collapse'} ${project.roomName}`"
                :aria-controls="projectChildListId(project.id)"
                :aria-expanded="!collapsedProjects[project.id]"
                :data-testid="`pinned-room-group-toggle-${project.id}`"
                @click="$emit('toggle-project', project.id)"
                @contextmenu.prevent.stop="openRoomContextMenu($event, project.parent, project.id)"
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>

            <Transition name="sidebar-reveal">
              <TransitionGroup
                v-if="!collapsedProjects[project.id] && projectChildRooms(project).length"
                :id="projectChildListId(project.id)"
                name="sidebar-room-order"
                tag="div"
                class="project-room-list"
              >
                <button
                  v-for="childRoom in visibleProjectChildRooms(project)"
                  :key="childRoom.id"
                  class="room-row room-focus"
                  :data-kind="childRoom.kind"
                  :data-active="activeEntry.id === childRoom.id"
                  :data-unread="childRoom.hasUnread"
                  :data-selected="isEntrySelected(childRoom)"
                  :data-dragging="isChildDragging(project.id, childRoom.id)"
                  :data-drop-position="childDropPosition(project.id, childRoom.id)"
                  :data-sidebar-entry-id="childRoom.id"
                  :aria-current="activeEntry.id === childRoom.id ? 'page' : undefined"
                  :aria-pressed="selectionActive && isSidebarRoomSelectable(childRoom) ? isEntrySelected(childRoom) : undefined"
                  :aria-describedby="roomReorderEnabled ? 'sidebar-room-reorder-instructions' : undefined"
                  :aria-keyshortcuts="roomReorderEnabled ? 'Alt+ArrowUp Alt+ArrowDown' : undefined"
                  :draggable="roomReorderEnabled"
                  type="button"
                  :data-testid="`pinned-child-room-${childRoom.id}`"
                  @click="handleEntryActivation($event, childRoom)"
                  @contextmenu.prevent.stop="openRoomContextMenu($event, childRoom)"
                  @dragstart="startChildDrag($event, project, childRoom)"
                  @dragover.stop="handleChildDragOver($event, project, childRoom)"
                  @drop.stop="dropChildRoom($event, project, childRoom)"
                  @dragend="finishSidebarDrag"
                  @keydown="handleChildReorderKeydown($event, project, childRoom)"
                >
                  <span
                    v-if="selectionActive && isSidebarRoomSelectable(childRoom)"
                    class="sidebar-child-selection-indicator"
                    :data-selected="isEntrySelected(childRoom)"
                    aria-hidden="true"
                  >
                    <Check v-if="isEntrySelected(childRoom)" />
                  </span>
                  <span class="room-title-line">
                    <span class="room-title">{{ childRoom.title }}</span>
                    <span v-if="childRoom.currentWorkspace" class="room-workspace-pill">Current</span>
                    <span
                      v-if="childRoom.hasUnread"
                      class="room-unread-dot"
                      aria-label="Unread messages"
                      title="Unread messages"
                    ></span>
                  </span>
                  <small v-if="childRoom.meta" class="room-child-meta">{{ childRoom.meta }}</small>
                  <small
                    v-if="childRoom.suggestedAction && !childRoom.currentWorkspace"
                    class="room-suggested-action"
                  >
                    {{ childRoom.suggestedAction }}
                  </small>
                </button>
                <button
                  v-if="hasProjectRoomOverflow(project)"
                  :key="`overflow:${project.id}`"
                  class="project-room-overflow-toggle"
                  :data-expanded="projectRoomListExpanded(project.id)"
                  :aria-expanded="projectRoomListExpanded(project.id)"
                  :aria-controls="projectChildListId(project.id)"
                  type="button"
                  @click="toggleProjectRoomOverflow(project.id)"
                >
                  <ChevronRight aria-hidden="true" />
                  <span>{{ projectRoomOverflowLabel(project) }}</span>
                </button>
              </TransitionGroup>
            </Transition>
          </article>
          </TransitionGroup>
        </Transition>
      </section>

        <section
          class="sidebar-section"
          :data-empty="!roomProjectEntries.length"
          data-testid="sidebar-section-rooms"
        >
      <button
        class="sidebar-section-header"
        type="button"
        :aria-expanded="!roomsCollapsed"
        :data-collapsed="roomsCollapsed"
        data-testid="sidebar-rooms-heading"
        @click="$emit('toggle-rooms-collapsed')"
      >
        <span class="sidebar-heading">Rooms</span>
        <span class="sidebar-section-meta">
          <span class="section-count">{{ totalRoomCount }}</span>
          <span class="sidebar-section-arrow" :data-collapsed="roomsCollapsed" aria-hidden="true">
            <ChevronRight />
          </span>
        </span>
      </button>
      <Transition name="sidebar-reveal">
        <TransitionGroup
          v-if="!roomsCollapsed"
          name="sidebar-room-order"
          tag="div"
          class="project-list"
        >
          <article
            v-for="project in roomProjectEntries"
            :key="project.id"
            class="project-group"
            :data-dragging="isParentDragging(project.id)"
            :data-drop-position="parentDropPosition(project.id)"
            :data-testid="`room-group-${project.id}`"
          >
            <div class="sidebar-project-row-shell">
              <button
                class="project-row"
                :aria-current="isSelectableRoom(project.parent) && activeEntry.id === project.parent.id ? 'page' : undefined"
                :data-active="isSelectableRoom(project.parent) && activeEntry.id === project.parent.id"
                :data-unread="project.parent.hasUnread"
                :data-selected="isEntrySelected(project.parent)"
                :data-sidebar-entry-id="project.parent.id"
                :aria-pressed="selectionActive && isSidebarRoomSelectable(project.parent) ? isEntrySelected(project.parent) : undefined"
                :aria-describedby="roomReorderEnabled ? 'sidebar-room-reorder-instructions' : undefined"
                :aria-keyshortcuts="roomReorderEnabled ? 'Alt+ArrowUp Alt+ArrowDown' : undefined"
                :draggable="roomReorderEnabled"
                type="button"
                :data-testid="`room-parent-${project.parent.id}`"
                @click="handleProjectActivation($event, project)"
                @contextmenu.prevent.stop="openRoomContextMenu($event, project.parent, project.id)"
                @dragstart="startParentDrag($event, project)"
                @dragover.stop="handleParentDragOver($event, project)"
                @drop.stop="dropParentRoom($event, project)"
                @dragend="finishSidebarDrag"
                @keydown="handleParentReorderKeydown($event, project)"
              >
                <span class="project-row-main">
                  <span
                    v-if="selectionActive && isSidebarRoomSelectable(project.parent)"
                    class="sidebar-selection-indicator"
                    :data-selected="isEntrySelected(project.parent)"
                    aria-hidden="true"
                  >
                    <Check v-if="isEntrySelected(project.parent)" />
                  </span>
                  <span v-else class="project-icon" aria-hidden="true">
                    <House />
                  </span>
                  <span class="project-copy">
                    <span class="room-title-line">
                      <span class="project-name">{{ project.roomName }}</span>
                      <span
                        v-if="project.parent.hasUnread"
                        class="room-unread-dot"
                        aria-label="Unread messages"
                        title="Unread messages"
                      ></span>
                    </span>
                    <small>
                      {{ projectSubtitle(project) }}
                    </small>
                  </span>
                </span>
              </button>
              <button
                v-if="projectChildRooms(project).length"
                class="project-toggle"
                :data-collapsed="collapsedProjects[project.id]"
                type="button"
                :aria-label="`${collapsedProjects[project.id] ? 'Expand' : 'Collapse'} ${project.roomName}`"
                :aria-controls="projectChildListId(project.id)"
                :aria-expanded="!collapsedProjects[project.id]"
                :data-testid="`room-group-toggle-${project.id}`"
                @click="$emit('toggle-project', project.id)"
                @contextmenu.prevent.stop="openRoomContextMenu($event, project.parent, project.id)"
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>

            <Transition name="sidebar-reveal">
              <TransitionGroup
                v-if="!collapsedProjects[project.id] && projectChildRooms(project).length"
                :id="projectChildListId(project.id)"
                name="sidebar-room-order"
                tag="div"
                class="project-room-list"
              >
                <button
                  v-for="childRoom in visibleProjectChildRooms(project)"
                  :key="childRoom.id"
                  class="room-row room-focus"
                  :data-kind="childRoom.kind"
                  :data-active="activeEntry.id === childRoom.id"
                  :data-unread="childRoom.hasUnread"
                  :data-selected="isEntrySelected(childRoom)"
                  :data-dragging="isChildDragging(project.id, childRoom.id)"
                  :data-drop-position="childDropPosition(project.id, childRoom.id)"
                  :data-sidebar-entry-id="childRoom.id"
                  :aria-current="activeEntry.id === childRoom.id ? 'page' : undefined"
                  :aria-pressed="selectionActive && isSidebarRoomSelectable(childRoom) ? isEntrySelected(childRoom) : undefined"
                  :aria-describedby="roomReorderEnabled ? 'sidebar-room-reorder-instructions' : undefined"
                  :aria-keyshortcuts="roomReorderEnabled ? 'Alt+ArrowUp Alt+ArrowDown' : undefined"
                  :draggable="roomReorderEnabled"
                  type="button"
                  :data-testid="`child-room-${childRoom.id}`"
                  @click="handleEntryActivation($event, childRoom)"
                  @contextmenu.prevent.stop="openRoomContextMenu($event, childRoom)"
                  @dragstart="startChildDrag($event, project, childRoom)"
                  @dragover.stop="handleChildDragOver($event, project, childRoom)"
                  @drop.stop="dropChildRoom($event, project, childRoom)"
                  @dragend="finishSidebarDrag"
                  @keydown="handleChildReorderKeydown($event, project, childRoom)"
                >
                  <span
                    v-if="selectionActive && isSidebarRoomSelectable(childRoom)"
                    class="sidebar-child-selection-indicator"
                    :data-selected="isEntrySelected(childRoom)"
                    aria-hidden="true"
                  >
                    <Check v-if="isEntrySelected(childRoom)" />
                  </span>
                  <span class="room-title-line">
                    <span class="room-title">{{ childRoom.title }}</span>
                    <span v-if="childRoom.currentWorkspace" class="room-workspace-pill">Current</span>
                    <span
                      v-if="childRoom.hasUnread"
                      class="room-unread-dot"
                      aria-label="Unread messages"
                      title="Unread messages"
                    ></span>
                  </span>
                  <small v-if="childRoom.meta" class="room-child-meta">{{ childRoom.meta }}</small>
                  <small
                    v-if="childRoom.suggestedAction && !childRoom.currentWorkspace"
                    class="room-suggested-action"
                  >
                    {{ childRoom.suggestedAction }}
                  </small>
                </button>
                <button
                  v-if="hasProjectRoomOverflow(project)"
                  :key="`overflow:${project.id}`"
                  class="project-room-overflow-toggle"
                  :data-expanded="projectRoomListExpanded(project.id)"
                  :aria-expanded="projectRoomListExpanded(project.id)"
                  :aria-controls="projectChildListId(project.id)"
                  type="button"
                  @click="toggleProjectRoomOverflow(project.id)"
                >
                  <ChevronRight aria-hidden="true" />
                  <span>{{ projectRoomOverflowLabel(project) }}</span>
                </button>
              </TransitionGroup>
            </Transition>
          </article>
          <p v-if="!roomProjectEntries.length" class="room-empty">No other rooms</p>
        </TransitionGroup>
      </Transition>
        </section>
      </div>
    </div>

    <div v-if="selectionActive" class="sidebar-footer sidebar-selection-footer">
      <div class="sidebar-selection-toolbar" role="toolbar" aria-label="Selected room actions">
        <button
          type="button"
          :disabled="Boolean(batchActionBusy) || !readResolution.targets.length"
          :aria-label="batchActionLabel(readResolution.label, readResolution.targets.length)"
          data-testid="sidebar-batch-mark-read"
          @click="$emit('batch-action', 'mark-read')"
        >
          <Check aria-hidden="true" />
          <span>{{ readResolution.label }}</span>
          <small>{{ readResolution.targets.length }}</small>
        </button>
        <button
          type="button"
          :disabled="Boolean(batchActionBusy) || !pinResolution.targets.length"
          :aria-label="batchActionLabel(pinResolution.label, pinResolution.targets.length)"
          data-testid="sidebar-batch-pin"
          @click="$emit('batch-action', 'pin')"
        >
          <PinOff v-if="pinResolution.pinned === false" aria-hidden="true" />
          <Pin v-else aria-hidden="true" />
          <span>{{ pinResolution.label }}</span>
          <small>{{ pinResolution.targets.length }}</small>
        </button>
        <button
          type="button"
          :disabled="Boolean(batchActionBusy) || !concludeResolution.targets.length"
          :aria-label="batchActionLabel(concludeResolution.label, concludeResolution.targets.length)"
          data-testid="sidebar-batch-conclude"
          @click="$emit('batch-action', 'conclude')"
        >
          <CheckCircle2 aria-hidden="true" />
          <span>{{ concludeResolution.label }}</span>
          <small>{{ concludeResolution.targets.length }}</small>
        </button>
        <button
          type="button"
          :disabled="Boolean(batchActionBusy) || !hideResolution.targets.length"
          :aria-label="batchActionLabel(hideResolution.label, hideResolution.targets.length)"
          data-testid="sidebar-batch-hide"
          @click="$emit('batch-action', 'hide')"
        >
          <Archive aria-hidden="true" />
          <span>{{ hideResolution.label }}</span>
          <small>{{ hideResolution.targets.length }}</small>
        </button>
      </div>
    </div>
    <div v-else class="sidebar-footer">
      <button
        v-if="updatePresentation.active"
        class="sidebar-row sidebar-settings-row sidebar-update-row"
        :data-update-state="updatePresentation.state"
        type="button"
        data-testid="sidebar-update-status"
        @click="handleSettingsRowClick"
      >
        <span class="system-icon" aria-hidden="true">
          <Download v-if="updatePresentation.state === 'downloading'" />
          <CircleCheck v-else-if="updatePresentation.state === 'ready'" />
          <RefreshCw v-else-if="updatePresentation.state === 'installing'" />
          <TriangleAlert v-else-if="updatePresentation.state === 'error'" />
        </span>
        <span class="system-copy">
          <span>{{ updatePresentation.title }}</span>
          <small>{{ updatePresentation.detail }}</small>
        </span>
        <span
          v-if="updatePresentation.state === 'downloading'"
          class="sidebar-update-progress"
          role="progressbar"
          :aria-label="updatePresentation.title"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="updatePresentation.percent ?? undefined"
        >
          <span :style="{ width: `${updatePresentation.percent ?? 14}%` }"></span>
        </span>
      </button>
      <SidebarAccountMenu
        :auth-status="authStatus"
        :busy="authBusy"
        @open-settings="$emit('open-settings')"
        @connect="$emit('connect-account')"
        @sign-out="$emit('sign-out')"
      />
    </div>

    <DesktopContextMenu
      v-if="roomContextMenu"
      :item-groups="roomContextMenuItemGroups"
      :position="roomContextMenu"
      :title="roomContextMenu.entry.title"
      testid="sidebar-room-context-menu"
      @select="handleRoomContextMenuSelect"
      @close="closeRoomContextMenu"
    />
    <DesktopContextMenu
      v-if="backgroundContextMenu"
      :item-groups="backgroundContextMenuItemGroups"
      :position="backgroundContextMenu"
      testid="sidebar-background-context-menu"
      @select="handleBackgroundContextMenuSelect"
      @close="closeBackgroundContextMenu"
    />
  </aside>
</template>

<script setup lang="ts">
import {
  Archive,
  Check,
  CheckCircle2,
  CircleCheck,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  GitBranch,
  Handshake,
  House,
  ListChecks,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "@lucide/vue";
import { computed, nextTick, ref, watch, type Component } from "vue";
import { copyTextToClipboard } from "../../../domain/clipboard";
import { desktopUpdateSidebarPresentation } from "../../../domain/desktop-update-status";
import { buildLetAgentsFocusRoomUrl, buildLetAgentsRoomCopyValue } from "../../../domain/room-urls";
import {
  SIDEBAR_PROJECT_ROOM_PREVIEW_LIMIT,
  previewSidebarProjectRooms,
} from "../../../domain/sidebar-project-room-preview";
import { searchSidebarRooms } from "../../../domain/sidebar-room-search";
import {
  isSidebarRoomReorderEnabled,
  orderedSidebarChildRooms,
  resolveSidebarKeyboardRoomReorder,
  type SidebarChildRoomReorder,
  type SidebarParentRoomReorder,
  type SidebarRoomDropPlacement,
} from "../../../domain/sidebar-room-order";
import {
  isSidebarRoomSelectable,
  resolveSidebarRoomBatchAction,
  type SidebarRoomBatchActionId,
} from "../../../domain/sidebar-room-selection";
import {
  buildGitRoomWebUrl,
  buildSidebarBackgroundMenuItems,
  buildSidebarRoomContextMenuItems,
  type SidebarBackgroundMenuActionId,
  type SidebarRoomMenuActionId,
} from "../../../domain/sidebar-context-menu";
import DesktopContextMenu, { type DesktopContextMenuItem } from "../controls/DesktopContextMenu.vue";
import SidebarAccountMenu from "./SidebarAccountMenu.vue";
import type { ProjectGroup, SidebarEntry, SystemEntry, RoomEntry } from "../types";
import { desktopIpc } from "../../../ipc/index.js";
import type { DesktopAuthStatus, DesktopUpdateStatus } from "../../../../../electron/ipc-types";

const props = defineProps<{
  activeEntry: SidebarEntry;
  primaryRoom: RoomEntry;
  projectEntries: ProjectGroup[];
  settingsEntry: SystemEntry;
  pinnedCollapsed: boolean;
  roomsCollapsed: boolean;
  collapsedProjects: Record<string, boolean>;
  selectionActive: boolean;
  selectedEntryIds: string[];
  batchActionBusy: SidebarRoomBatchActionId | null;
  rentalRequestCount?: number;
  updateStatus: DesktopUpdateStatus | null;
  authStatus: DesktopAuthStatus | null;
  authBusy: boolean;
}>();

const emit = defineEmits<{
  "cycle-sidebar": [];
  "new-room": [];
  "open-rent": [];
  "open-updates": [];
  "open-settings": [];
  "connect-account": [];
  "sign-out": [];
  "archive-room": [entry: RoomEntry];
  "archive-focus-room": [entry: RoomEntry];
  "conclude-focus-room": [entry: RoomEntry];
  "mark-room-read": [entry: RoomEntry];
  "pin-room": [entry: RoomEntry];
  "rename-room": [entry: RoomEntry];
  "start-selection": [entry?: RoomEntry];
  "cancel-selection": [];
  "toggle-entry-selection": [entryId: string];
  "set-entry-selection": [entryIds: string[], selected: boolean];
  "batch-action": [action: SidebarRoomBatchActionId];
  "select-entry": [entry: SidebarEntry];
  "set-projects-collapsed": [collapsed: boolean];
  "reorder-parent-room": [input: SidebarParentRoomReorder];
  "reorder-child-room": [input: SidebarChildRoomReorder];
  "toggle-project": [projectId: string];
  "toggle-pinned-collapsed": [];
  "toggle-rooms-collapsed": [];
}>();

type RoomContextMenu = {
  entry: RoomEntry;
  projectId: string | null;
  x: number;
  y: number;
};

type SidebarDragState =
  | { kind: "parent"; projectId: string; pinned: boolean }
  | { kind: "child"; projectId: string; entryId: string };

type SidebarDropTarget =
  | { kind: "parent"; projectId: string; placement: SidebarRoomDropPlacement }
  | { kind: "child"; projectId: string; entryId: string; placement: SidebarRoomDropPlacement };

const roomContextMenu = ref<RoomContextMenu | null>(null);
const backgroundContextMenu = ref<{ x: number; y: number } | null>(null);
const searchButton = ref<HTMLButtonElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const searchOpen = ref(false);
const searchQuery = ref("");
const activeSearchIndex = ref(0);
const expandedProjectRoomLists = ref<Record<string, boolean>>({});
const lastSelectionAnchorId = ref<string | null>(null);
const dragState = ref<SidebarDragState | null>(null);
const dropTarget = ref<SidebarDropTarget | null>(null);
const reorderAnnouncement = ref("");
const suppressedActivationEntryId = ref<string | null>(null);
const updatePresentation = computed(() => desktopUpdateSidebarPresentation(props.updateStatus));

function handleSettingsRowClick(): void {
  emit("open-updates");
}

const roomReorderEnabled = computed(() => isSidebarRoomReorderEnabled(
  props.selectionActive,
  Boolean(props.batchActionBusy),
));
const pinnedProjectEntries = computed(() => props.projectEntries.filter((project) => project.parent.pinned));
const roomProjectEntries = computed(() => props.projectEntries.filter((project) => !project.parent.pinned));
const searchResults = computed(() => searchSidebarRooms(props.projectEntries, searchQuery.value));
const activeSearchResultId = computed(() => {
  const entry = searchResults.value[activeSearchIndex.value]?.entry;
  return entry ? searchResultId(entry.id) : undefined;
});
const selectedEntryIdSet = computed(() => new Set(props.selectedEntryIds));
const selectedEntries = computed(() => props.projectEntries
  .flatMap((project) => [project.parent, ...projectChildRooms(project)])
  .filter((entry, index, entries) =>
    selectedEntryIdSet.value.has(entry.id)
    && entries.findIndex((candidate) => candidate.id === entry.id) === index
  ));
const visibleSelectableEntries = computed(() => {
  const visible: RoomEntry[] = [];
  if (!props.pinnedCollapsed) {
    for (const project of pinnedProjectEntries.value) {
      visible.push(project.parent);
      if (!props.collapsedProjects[project.id]) visible.push(...visibleProjectChildRooms(project));
    }
  }
  if (!props.roomsCollapsed) {
    for (const project of roomProjectEntries.value) {
      visible.push(project.parent);
      if (!props.collapsedProjects[project.id]) visible.push(...visibleProjectChildRooms(project));
    }
  }
  const seen = new Set<string>();
  return visible.filter((entry) => {
    if (!isSidebarRoomSelectable(entry) || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
});
const allVisibleSelected = computed(() =>
  Boolean(visibleSelectableEntries.value.length)
  && visibleSelectableEntries.value.every((entry) => selectedEntryIdSet.value.has(entry.id))
);
const readResolution = computed(() => batchResolution("mark-read"));
const pinResolution = computed(() => batchResolution("pin"));
const concludeResolution = computed(() => batchResolution("conclude"));
const hideResolution = computed(() => batchResolution("hide"));

watch(searchResults, (results) => {
  activeSearchIndex.value = Math.min(activeSearchIndex.value, Math.max(0, results.length - 1));
});

watch(searchQuery, () => {
  activeSearchIndex.value = 0;
});

watch(() => props.selectionActive, (selectionActive) => {
  if (selectionActive) {
    resetSearch();
    cancelSidebarDrag();
  }
  else lastSelectionAnchorId.value = null;
});

const totalRoomCount = computed(() =>
  roomProjectEntries.value.reduce((total, project) => total + 1 + projectChildRooms(project).length, 0)
);

const roomMenuIcons: Record<SidebarRoomMenuActionId, Component> = {
  "open-room": House,
  "select-room": ListChecks,
  "mark-room-read": Check,
  "pin-room": Pin,
  "rename-room": Pencil,
  "copy-room-url": Copy,
  "copy-branch-name": GitBranch,
  "open-on-github": ExternalLink,
  "toggle-project": ChevronRight,
  "conclude-focus-room": CheckCircle2,
  "archive-focus-room": Archive,
  "archive-room": Archive,
};

function roomMenuGroupsFor(entry: RoomEntry, projectId: string | null): DesktopContextMenuItem[][] {
  const project = projectId
    ? props.projectEntries.find((candidate) => candidate.id === projectId && projectChildRooms(candidate).length)
    : null;
  return buildSidebarRoomContextMenuItems({
    entry,
    isPrimaryRoom: entry.id === props.primaryRoom.id,
    hasProjectChildren: Boolean(project),
    projectCollapsed: Boolean(project && props.collapsedProjects[project.id]),
    canManageRooms: props.authStatus?.authenticated === true,
  }).map((group) => group.map((item) => ({
    ...item,
    icon: item.id === "pin-room" && entry.pinned ? PinOff : roomMenuIcons[item.id],
  })));
}

const roomContextMenuItemGroups = computed<DesktopContextMenuItem[][]>(() => {
  const menu = roomContextMenu.value;
  return menu ? roomMenuGroupsFor(menu.entry, menu.projectId) : [];
});

const backgroundMenuIcons: Record<SidebarBackgroundMenuActionId, Component> = {
  "new-room": Plus,
  "select-rooms": ListChecks,
  "set-projects-collapsed": ChevronRight,
};

const allProjectsCollapsed = computed(() =>
  props.projectEntries.every((project) =>
    !projectChildRooms(project).length || props.collapsedProjects[project.id]
  )
);

const backgroundContextMenuItemGroups = computed<DesktopContextMenuItem[][]>(() =>
  buildSidebarBackgroundMenuItems({
    hasProjects: props.projectEntries.some((project) => projectChildRooms(project).length > 0),
    allProjectsCollapsed: allProjectsCollapsed.value,
  }).map((group) => group.map((item) => ({ ...item, icon: backgroundMenuIcons[item.id] })))
);

function openRoomContextMenu(event: MouseEvent, entry: RoomEntry, projectId: string | null = null): void {
  backgroundContextMenu.value = null;
  roomContextMenu.value = roomMenuGroupsFor(entry, projectId).length
    ? { entry, projectId, x: event.clientX, y: event.clientY }
    : null;
}

function closeRoomContextMenu(): void {
  roomContextMenu.value = null;
}

function roomCopyValue(entry: RoomEntry): string {
  return entry.kind === "focus"
    ? buildLetAgentsFocusRoomUrl({
        roomIdentifier: entry.roomIdentifier,
        parentRoomId: entry.parentRoomIdentifier,
        focusKey: entry.focusKey,
        sourceTaskId: entry.sourceTaskId,
      })
    : buildLetAgentsRoomCopyValue(entry.roomIdentifier);
}

function openBackgroundContextMenu(event: MouseEvent): void {
  roomContextMenu.value = null;
  backgroundContextMenu.value = { x: event.clientX, y: event.clientY };
}

function closeBackgroundContextMenu(): void {
  backgroundContextMenu.value = null;
}

function handleRoomContextMenuSelect(item: DesktopContextMenuItem): void {
  const menu = roomContextMenu.value;
  if (!menu) return;
  const actions: Record<SidebarRoomMenuActionId, () => void> = {
    "open-room": () => emit("select-entry", menu.entry),
    "select-room": () => startSelection(menu.entry),
    "mark-room-read": () => emit("mark-room-read", menu.entry),
    "pin-room": () => emit("pin-room", menu.entry),
    "rename-room": () => emit("rename-room", menu.entry),
    "copy-room-url": () =>
      void copyText(roomCopyValue(menu.entry)),
    "copy-branch-name": () => void copyText(menu.entry.gitRoom?.ref.name ?? null),
    "open-on-github": () => {
      const url = buildGitRoomWebUrl(menu.entry.gitRoom ?? null);
      if (url) void desktopIpc.app.openGitHubUrl(url);
    },
    "toggle-project": () => {
      if (menu.projectId) emit("toggle-project", menu.projectId);
    },
    "conclude-focus-room": () => emit("conclude-focus-room", menu.entry),
    "archive-focus-room": () => emit("archive-focus-room", menu.entry),
    "archive-room": () => emit("archive-room", menu.entry),
  };
  actions[item.id as SidebarRoomMenuActionId]?.();
}

function handleBackgroundContextMenuSelect(item: DesktopContextMenuItem): void {
  if (item.id === "new-room") {
    emit("new-room");
    return;
  }
  if (item.id === "select-rooms") {
    startSelection();
    return;
  }
  if (item.id === "set-projects-collapsed") {
    emit("set-projects-collapsed", !allProjectsCollapsed.value);
  }
}

async function copyText(value: string | null): Promise<void> {
  if (!value) return;
  await copyTextToClipboard(value);
}

function projectSubtitle(project: ProjectGroup): string {
  const branchCount = project.branchRooms.length;
  const focusCount = project.focusRooms.length;
  if (project.parent.gitRoom && branchCount) {
    const branchLabel = `${branchCount} ${branchCount === 1 ? "branch" : "branches"}`;
    const focusLabel = focusCount ? ` · ${focusCount} focus ${focusCount === 1 ? "room" : "rooms"}` : "";
    return `${project.parent.meta} · ${branchLabel}${focusLabel}`;
  }
  if (focusCount) {
    return `${focusCount} focus ${focusCount === 1 ? "room" : "rooms"}`;
  }
  return project.parent.meta;
}

function projectChildRooms(project: ProjectGroup | null | undefined): RoomEntry[] {
  return orderedSidebarChildRooms(project);
}

function visibleProjectChildRooms(project: ProjectGroup): RoomEntry[] {
  return previewSidebarProjectRooms({
    rooms: projectChildRooms(project),
    activeEntryId: props.activeEntry.id,
    expanded: projectRoomListExpanded(project.id),
  });
}

function hasProjectRoomOverflow(project: ProjectGroup): boolean {
  return projectChildRooms(project).length > SIDEBAR_PROJECT_ROOM_PREVIEW_LIMIT;
}

function projectRoomListExpanded(projectId: string): boolean {
  return Boolean(expandedProjectRoomLists.value[projectId]);
}

function toggleProjectRoomOverflow(projectId: string): void {
  expandedProjectRoomLists.value = {
    ...expandedProjectRoomLists.value,
    [projectId]: !expandedProjectRoomLists.value[projectId],
  };
}

function projectRoomOverflowLabel(project: ProjectGroup): string {
  if (projectRoomListExpanded(project.id)) return "Show fewer rooms";
  const hiddenCount = projectChildRooms(project).length - visibleProjectChildRooms(project).length;
  return `Show ${hiddenCount} more`;
}

function projectChildListId(projectId: string): string {
  return `sidebar-project-children-${encodeURIComponent(projectId)}`;
}

function startParentDrag(event: DragEvent, project: ProjectGroup): void {
  if (!roomReorderEnabled.value) {
    event.preventDefault();
    return;
  }
  closeRoomContextMenu();
  closeBackgroundContextMenu();
  dragState.value = { kind: "parent", projectId: project.id, pinned: project.parent.pinned };
  setDragTransfer(event, "parent");
}

function startChildDrag(event: DragEvent, project: ProjectGroup, entry: RoomEntry): void {
  if (!roomReorderEnabled.value) {
    event.preventDefault();
    return;
  }
  closeRoomContextMenu();
  closeBackgroundContextMenu();
  dragState.value = { kind: "child", projectId: project.id, entryId: entry.id };
  setDragTransfer(event, "child");
}

function setDragTransfer(event: DragEvent, kind: SidebarDragState["kind"]): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("application/x-letagents-sidebar-room", kind);
}

function handleParentDragOver(event: DragEvent, project: ProjectGroup): void {
  const drag = dragState.value;
  if (
    !drag
    || drag.kind !== "parent"
    || drag.projectId === project.id
    || drag.pinned !== project.parent.pinned
  ) {
    dropTarget.value = null;
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTarget.value = {
    kind: "parent",
    projectId: project.id,
    placement: placementFromPointer(event),
  };
}

function handleChildDragOver(event: DragEvent, project: ProjectGroup, entry: RoomEntry): void {
  const drag = dragState.value;
  if (
    !drag
    || drag.kind !== "child"
    || drag.projectId !== project.id
    || drag.entryId === entry.id
  ) {
    dropTarget.value = null;
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTarget.value = {
    kind: "child",
    projectId: project.id,
    entryId: entry.id,
    placement: placementFromPointer(event),
  };
}

function dropParentRoom(event: DragEvent, targetProject: ProjectGroup): void {
  const drag = dragState.value;
  const target = dropTarget.value;
  if (
    !drag
    || drag.kind !== "parent"
    || drag.pinned !== targetProject.parent.pinned
    || !target
    || target.kind !== "parent"
    || target.projectId !== targetProject.id
  ) {
    cancelSidebarDrag();
    return;
  }
  event.preventDefault();
  const sourceProject = props.projectEntries.find((project) => project.id === drag.projectId);
  if (!sourceProject) {
    cancelSidebarDrag();
    return;
  }
  emit("reorder-parent-room", {
    sourceProjectId: drag.projectId,
    targetProjectId: targetProject.id,
    placement: target.placement,
  });
  suppressActivation(sourceProject.parent.id);
  announceReorder(sourceProject.roomName, targetProject.roomName, target.placement);
  cancelSidebarDrag();
}

function dropChildRoom(
  event: DragEvent,
  project: ProjectGroup,
  targetEntry: RoomEntry,
): void {
  const drag = dragState.value;
  const target = dropTarget.value;
  if (
    !drag
    || drag.kind !== "child"
    || drag.projectId !== project.id
    || !target
    || target.kind !== "child"
    || target.projectId !== project.id
    || target.entryId !== targetEntry.id
  ) {
    cancelSidebarDrag();
    return;
  }
  event.preventDefault();
  const sourceEntry = projectChildRooms(project).find((entry) => entry.id === drag.entryId);
  if (!sourceEntry) {
    cancelSidebarDrag();
    return;
  }
  emit("reorder-child-room", {
    projectId: project.id,
    sourceEntryId: drag.entryId,
    targetEntryId: targetEntry.id,
    placement: target.placement,
  });
  suppressActivation(sourceEntry.id);
  announceReorder(sourceEntry.title, targetEntry.title, target.placement);
  cancelSidebarDrag();
}

function handleParentReorderKeydown(event: KeyboardEvent, project: ProjectGroup): void {
  const direction = keyboardReorderDirection(event);
  if (!direction) return;
  event.preventDefault();
  event.stopPropagation();
  const siblings = project.parent.pinned ? pinnedProjectEntries.value : roomProjectEntries.value;
  const reorder = resolveSidebarKeyboardRoomReorder(siblings, project.id, direction);
  if (!reorder) {
    announceReorderBoundary(project.roomName, direction);
    return;
  }
  emit("reorder-parent-room", {
    sourceProjectId: project.id,
    targetProjectId: reorder.target.id,
    placement: reorder.placement,
  });
  announceReorder(project.roomName, reorder.target.roomName, reorder.placement);
}

function handleChildReorderKeydown(
  event: KeyboardEvent,
  project: ProjectGroup,
  entry: RoomEntry,
): void {
  const direction = keyboardReorderDirection(event);
  if (!direction) return;
  event.preventDefault();
  event.stopPropagation();
  const visibleSiblings = visibleProjectChildRooms(project);
  const reorder = resolveSidebarKeyboardRoomReorder(visibleSiblings, entry.id, direction);
  if (!reorder) {
    announceReorderBoundary(entry.title, direction);
    return;
  }
  emit("reorder-child-room", {
    projectId: project.id,
    sourceEntryId: entry.id,
    targetEntryId: reorder.target.id,
    placement: reorder.placement,
  });
  announceReorder(entry.title, reorder.target.title, reorder.placement);
}

function keyboardReorderDirection(event: KeyboardEvent): -1 | 1 | null {
  if (
    !roomReorderEnabled.value
    || !event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) return null;
  if (event.key === "ArrowUp") return -1;
  if (event.key === "ArrowDown") return 1;
  return null;
}

function placementFromPointer(event: DragEvent): SidebarRoomDropPlacement {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return "after";
  const bounds = target.getBoundingClientRect();
  return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
}

function parentDropPosition(projectId: string): SidebarRoomDropPlacement | undefined {
  const target = dropTarget.value;
  return target?.kind === "parent" && target.projectId === projectId ? target.placement : undefined;
}

function childDropPosition(
  projectId: string,
  entryId: string,
): SidebarRoomDropPlacement | undefined {
  const target = dropTarget.value;
  return target?.kind === "child"
    && target.projectId === projectId
    && target.entryId === entryId
    ? target.placement
    : undefined;
}

function isParentDragging(projectId: string): boolean {
  return dragState.value?.kind === "parent" && dragState.value.projectId === projectId;
}

function isChildDragging(projectId: string, entryId: string): boolean {
  return dragState.value?.kind === "child"
    && dragState.value.projectId === projectId
    && dragState.value.entryId === entryId;
}

function clearSidebarDropTarget(): void {
  if (dragState.value) dropTarget.value = null;
}

function finishSidebarDrag(): void {
  dragState.value = null;
  dropTarget.value = null;
}

function cancelSidebarDrag(): void {
  finishSidebarDrag();
}

function announceReorder(
  sourceLabel: string,
  targetLabel: string,
  placement: SidebarRoomDropPlacement,
): void {
  announceReorderStatus(`${sourceLabel} moved ${placement} ${targetLabel}.`);
}

function announceReorderBoundary(label: string, direction: -1 | 1): void {
  announceReorderStatus(`${label} is already ${direction < 0 ? "first" : "last"} in this group.`);
}

function announceReorderStatus(message: string): void {
  reorderAnnouncement.value = "";
  void nextTick(() => {
    reorderAnnouncement.value = message;
  });
}

function suppressActivation(entryId: string): void {
  suppressedActivationEntryId.value = entryId;
  window.setTimeout(() => {
    if (suppressedActivationEntryId.value === entryId) suppressedActivationEntryId.value = null;
  }, 0);
}

function consumeSuppressedActivation(entryId: string): boolean {
  if (suppressedActivationEntryId.value !== entryId) return false;
  suppressedActivationEntryId.value = null;
  return true;
}

function isSelectableRoom(entry: RoomEntry): boolean {
  return Boolean(entry.roomIdentifier);
}

function selectOrToggleProject(project: ProjectGroup): void {
  if (isSelectableRoom(project.parent)) {
    emit("select-entry", project.parent);
    return;
  }
  if (projectChildRooms(project).length) {
    emit("toggle-project", project.id);
  }
}

function batchResolution(action: SidebarRoomBatchActionId) {
  const resolution = resolveSidebarRoomBatchAction({
    action,
    entries: selectedEntries.value,
    primaryRoomId: props.primaryRoom.id,
  });
  if (!props.authStatus?.authenticated && action !== "mark-read") {
    return { ...resolution, targets: [] };
  }
  return resolution;
}

function batchActionLabel(label: string, targetCount: number): string {
  const selectedCount = props.selectedEntryIds.length;
  if (!targetCount) return `${label}: unavailable for the selected rooms`;
  return `${label} ${targetCount} of ${selectedCount} selected ${selectedCount === 1 ? "room" : "rooms"}`;
}

function startSelection(entry?: RoomEntry): void {
  resetSearch();
  if (entry && !isSidebarRoomSelectable(entry)) return;
  lastSelectionAnchorId.value = entry?.id || null;
  emit("start-selection", entry);
}

function isEntrySelected(entry: RoomEntry): boolean {
  return selectedEntryIdSet.value.has(entry.id);
}

function handleProjectActivation(event: MouseEvent, project: ProjectGroup): void {
  if (consumeSuppressedActivation(project.parent.id)) return;
  if (handleSelectionActivation(event, project.parent)) return;
  selectOrToggleProject(project);
}

function handleEntryActivation(event: MouseEvent, entry: RoomEntry): void {
  if (consumeSuppressedActivation(entry.id)) return;
  if (handleSelectionActivation(event, entry)) return;
  emit("select-entry", entry);
}

function handleSelectionActivation(event: MouseEvent, entry: RoomEntry): boolean {
  const selectionGesture = props.selectionActive || event.metaKey || event.ctrlKey;
  if (!selectionGesture) return false;
  if (!isSidebarRoomSelectable(entry)) return false;

  if (!props.selectionActive) {
    startSelection(entry);
    return true;
  }

  if (event.shiftKey && lastSelectionAnchorId.value) {
    const anchorIndex = visibleSelectableEntries.value.findIndex(
      (candidate) => candidate.id === lastSelectionAnchorId.value,
    );
    const entryIndex = visibleSelectableEntries.value.findIndex((candidate) => candidate.id === entry.id);
    if (anchorIndex >= 0 && entryIndex >= 0) {
      const start = Math.min(anchorIndex, entryIndex);
      const end = Math.max(anchorIndex, entryIndex);
      emit(
        "set-entry-selection",
        visibleSelectableEntries.value.slice(start, end + 1).map((candidate) => candidate.id),
        true,
      );
      return true;
    }
  }

  emit("toggle-entry-selection", entry.id);
  lastSelectionAnchorId.value = entry.id;
  return true;
}

function toggleVisibleSelection(): void {
  emit(
    "set-entry-selection",
    visibleSelectableEntries.value.map((entry) => entry.id),
    !allVisibleSelected.value,
  );
}

function handleSidebarEscape(): void {
  if (props.selectionActive && !props.batchActionBusy) emit("cancel-selection");
}

function toggleSearch(): void {
  if (searchOpen.value) closeSearch();
  else openSearch();
}

function openSearch(): void {
  searchOpen.value = true;
  activeSearchIndex.value = 0;
  void nextTick(() => searchInput.value?.focus());
}

function closeSearch(): void {
  resetSearch();
  void nextTick(() => searchButton.value?.focus());
}

function resetSearch(): void {
  searchOpen.value = false;
  searchQuery.value = "";
  activeSearchIndex.value = 0;
}

function handleSearchKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
    return;
  }
  if (!searchResults.value.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : -1;
    activeSearchIndex.value = (
      activeSearchIndex.value + offset + searchResults.value.length
    ) % searchResults.value.length;
    void nextTick(() => {
      const resultId = activeSearchResultId.value;
      if (resultId) document.getElementById(resultId)?.scrollIntoView({ block: "nearest" });
    });
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const result = searchResults.value[activeSearchIndex.value];
    if (result) selectSearchResult(result.entry);
  }
}

function selectSearchResult(entry: RoomEntry): void {
  revealSearchResult(entry);
  emit("select-entry", entry);
  closeSearch();
}

function revealSearchResult(entry: RoomEntry): void {
  const project = props.projectEntries.find((candidate) =>
    candidate.parent.id === entry.id
    || projectChildRooms(candidate).some((room) => room.id === entry.id)
  );
  if (!project) return;
  if (project.parent.pinned && props.pinnedCollapsed) emit("toggle-pinned-collapsed");
  if (!project.parent.pinned && props.roomsCollapsed) emit("toggle-rooms-collapsed");
  if (props.collapsedProjects[project.id]) emit("toggle-project", project.id);
}

function searchResultId(entryId: string): string {
  return `sidebar-room-search-result-${encodeURIComponent(entryId)}`;
}

</script>
