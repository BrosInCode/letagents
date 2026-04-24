<template>
  <div class="activity-panel" :data-loading="isLoading">
    <div v-if="isLoading" class="activity-refresh-indicator" role="status" aria-live="polite">
      <span class="activity-spinner" aria-hidden="true" />
      <span>Refreshing activity…</span>
    </div>

    <div class="activity-summary">
      <template v-if="activeView === 'live'">
        <article class="summary-card">
          <strong>{{ activeAgents.length }}</strong>
          <span>Active agents</span>
        </article>
        <article class="summary-card">
          <strong>{{ awayAgents.length }}</strong>
          <span>Away agents</span>
        </article>
        <article class="summary-card">
          <strong>{{ offlineAgents.length }}</strong>
          <span>Offline agents</span>
        </article>
        <article class="summary-card">
          <strong>{{ humans.length }}</strong>
          <span>Humans seen</span>
        </article>
        <article class="summary-card">
          <strong>{{ activeReasoningSessions.length }}</strong>
          <span>Active reasoning</span>
        </article>
      </template>
      <template v-else>
        <article
          v-for="card in historySummaryCards"
          :key="card.label"
          class="summary-card"
        >
          <strong>{{ card.value }}</strong>
          <span>{{ card.label }}</span>
        </article>
      </template>
    </div>

    <div class="activity-toolbar-row">
      <div class="activity-view-switcher">
        <button
          class="activity-view-button"
          type="button"
          :data-active="activeView === 'live'"
          @click="activeView = 'live'"
        >
          Live
        </button>
        <button
          class="activity-view-button"
          type="button"
          :data-active="activeView === 'history'"
          @click="activeView = 'history'"
        >
          History
        </button>
      </div>

      <p v-if="activeView === 'live' && clearedLiveCount > 0" class="activity-toolbar-note">
        {{ clearedLiveCount }} cleared from the live roster.
      </p>
    </div>

    <div v-if="activeView === 'history'" class="activity-history-view">
      <div class="activity-history-toolbar">
        <label v-if="historyRoomOptions.length > 1" class="activity-history-filter">
          <span>Room</span>
          <AppSelect v-model="historyRoomId">
            <option
              v-for="option in historyRoomOptions"
              :key="option.id"
              :value="option.id"
            >
              {{ option.label }}
            </option>
          </AppSelect>
        </label>

        <label class="activity-history-search">
          <span>Search history</span>
          <input
            v-model="historyQuery"
            type="search"
            placeholder="Agent, owner, or task"
          >
        </label>

        <label class="activity-history-filter">
          <span>Filter</span>
          <AppSelect v-model="historyKind">
            <option value="all">All</option>
            <option value="agent">Agents</option>
            <option value="human">Humans</option>
          </AppSelect>
        </label>
      </div>

      <div class="activity-history-meta">
        <span>{{ historyCountLabel }}</span>
        <span v-if="props.activityHistory">{{ historyPageLabel }}</span>
      </div>

      <div v-if="props.activityHistoryLoading" class="activity-empty">
        <h3>Loading room history</h3>
        <p>Pulling room-family activity and task history.</p>
      </div>

      <div v-else-if="props.activityHistoryError" class="activity-empty">
        <h3>History unavailable</h3>
        <p>{{ props.activityHistoryError }}</p>
      </div>

      <div v-else-if="historyEntries.length === 0" class="activity-empty">
        <h3>No matching history</h3>
        <p>Try a broader query or choose another room scope.</p>
      </div>

      <div v-else class="activity-layout">
        <div class="activity-groups">
          <section v-if="showHistoryAgentSection" class="activity-group">
            <div class="activity-group-header">
              <div>
                <h3>Agents in room history</h3>
                <p>Agents who have been in this room, ordered by when they were last seen here.</p>
              </div>
              <span class="activity-group-count">{{ historyAgents.length }}</span>
            </div>

            <div v-if="historyAgents.length > 0" class="activity-roster">
              <button
                v-for="participant in historyAgents"
                :key="participant.key"
                class="activity-roster-item"
                :data-selected="selectedHistoryParticipant?.key === participant.key"
                :data-kind="participant.kind"
                type="button"
                @click="selectedHistoryParticipantKey = participant.key"
              >
                <div class="activity-roster-header">
                  <div>
                    <div class="activity-roster-name">{{ participant.label }}</div>
                    <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                  </div>
                </div>
                <div class="activity-roster-status">
                  <span>{{ historyParticipantNote(participant) }}</span>
                  <span class="activity-roster-seen">{{ historyLastSeenLabel(participant.lastSeenAt) }}</span>
                </div>
              </button>
            </div>

            <div v-else class="activity-group-empty">
              No agents match this room history scope yet.
            </div>
          </section>

          <section v-if="showHistoryHumanSection" class="activity-group">
            <div class="activity-group-header">
              <div>
                <h3>Humans seen in room</h3>
                <p>Browser-side activity recorded for this room scope.</p>
              </div>
              <span class="activity-group-count">{{ historyHumans.length }}</span>
            </div>

            <div v-if="historyHumans.length > 0" class="activity-roster">
              <button
                v-for="participant in historyHumans"
                :key="participant.key"
                class="activity-roster-item"
                :data-selected="selectedHistoryParticipant?.key === participant.key"
                :data-kind="participant.kind"
                type="button"
                @click="selectedHistoryParticipantKey = participant.key"
              >
                <div class="activity-roster-header">
                  <div>
                    <div class="activity-roster-name">{{ participant.label }}</div>
                    <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                  </div>
                  <span class="activity-kind-pill">Human</span>
                </div>
                <div class="activity-roster-status">
                  <span>{{ historyParticipantNote(participant) }}</span>
                  <span class="activity-roster-seen">{{ historyLastSeenLabel(participant.lastSeenAt) }}</span>
                </div>
              </button>
            </div>

            <div v-else class="activity-group-empty">
              No human room activity is recorded for this scope yet.
            </div>
          </section>
        </div>

        <aside v-if="selectedHistoryParticipant" class="activity-detail" :data-kind="selectedHistoryParticipant.kind">
          <div class="activity-detail-header">
            <div>
              <div class="activity-detail-kicker">History detail</div>
              <h3>{{ selectedHistoryParticipant.label }}</h3>
              <p>{{ selectedHistoryRoomOption?.label }} · {{ participantMeta(selectedHistoryParticipant) }}</p>
            </div>

            <div class="activity-detail-badges">
              <span class="activity-history-room-pill">
                {{ selectedHistoryRoomOption?.kind === 'focus' ? 'Focus room' : 'Main room' }}
              </span>
            </div>
          </div>

          <p class="activity-detail-description">
            Last in room {{ formatLastSeen(selectedHistoryParticipant.lastSeenAt) }}
            <template v-if="selectedHistoryParticipant.firstSeenAt">
              · first joined {{ formatLastSeen(selectedHistoryParticipant.firstSeenAt) }}
            </template>
          </p>

          <div class="activity-detail-stats">
            <article class="detail-stat">
              <strong>{{ selectedHistoryParticipant.currentTasks.length }}</strong>
              <span>Current work</span>
            </article>
            <article class="detail-stat">
              <strong>{{ selectedHistoryParticipant.completedTasks.length }}</strong>
              <span>Completed</span>
            </article>
            <article class="detail-stat">
              <strong>{{ selectedHistoryParticipant.createdTasks.length }}</strong>
              <span>Created</span>
            </article>
          </div>

          <p
            class="activity-detail-description"
          >
            {{ historyDetailNote(selectedHistoryParticipant) }}
          </p>

          <section class="activity-detail-section">
            <div class="activity-detail-section-header">
              <h4>Current work</h4>
              <span>{{ selectedHistoryParticipant.currentTasks.length }}</span>
            </div>

            <div v-if="selectedHistoryParticipant.currentTasks.length === 0" class="activity-detail-empty">
              No open tasks linked to this participant in this room.
            </div>

            <div v-else class="activity-task-list">
              <article
                v-for="task in selectedHistoryParticipant.currentTasks"
                :key="task.id"
                class="activity-task-card"
              >
                <div class="activity-task-copy">
                  <strong>{{ task.title }}</strong>
                  <span>{{ TASK_STATUS_LABELS[task.status] || task.status }}</span>
                </div>
                <a
                  v-if="getTaskLink(task)"
                  class="activity-task-link"
                  :href="getTaskLink(task)!.url"
                  target="_blank"
                >
                  {{ getTaskLink(task)!.label }}
                </a>
              </article>
            </div>
          </section>

          <section class="activity-detail-section">
            <div class="activity-detail-section-header">
              <h4>Recent completed work</h4>
              <span>{{ selectedHistoryParticipant.completedTasks.length }}</span>
            </div>

            <div v-if="selectedHistoryParticipant.completedTasks.length === 0" class="activity-detail-empty">
              No completed or merged tasks tracked yet.
            </div>

            <div v-else class="activity-task-list">
              <article
                v-for="task in selectedHistoryParticipant.completedTasks"
                :key="task.id"
                class="activity-task-card"
              >
                <div class="activity-task-copy">
                  <strong>{{ task.title }}</strong>
                  <span>{{ TASK_STATUS_LABELS[task.status] || task.status }}</span>
                </div>
                <a
                  v-if="getTaskLink(task)"
                  class="activity-task-link"
                  :href="getTaskLink(task)!.url"
                  target="_blank"
                >
                  {{ getTaskLink(task)!.label }}
                </a>
              </article>
            </div>
          </section>

          <section v-if="selectedHistoryParticipant.createdTasks.length > 0" class="activity-detail-section">
            <div class="activity-detail-section-header">
              <h4>Tasks created</h4>
              <span>{{ selectedHistoryParticipant.createdTasks.length }}</span>
            </div>

            <div class="activity-task-list">
              <article
                v-for="task in selectedHistoryParticipant.createdTasks"
                :key="task.id"
                class="activity-task-card"
              >
                <div class="activity-task-copy">
                  <strong>{{ task.title }}</strong>
                  <span>{{ TASK_STATUS_LABELS[task.status] || task.status }}</span>
                </div>
                <a
                  v-if="getTaskLink(task)"
                  class="activity-task-link"
                  :href="getTaskLink(task)!.url"
                  target="_blank"
                >
                  {{ getTaskLink(task)!.label }}
                </a>
              </article>
            </div>
          </section>
        </aside>
      </div>

      <div v-if="props.activityHistory && props.activityHistory.page_count > 1" class="activity-history-pagination">
        <button
          class="activity-pagination-button"
          type="button"
          :disabled="props.activityHistory.page <= 1 || props.activityHistoryLoading"
          @click="changeHistoryPage((props.activityHistory?.page || 1) - 1)"
        >
          Previous
        </button>
        <button
          class="activity-pagination-button"
          type="button"
          :disabled="props.activityHistory.page >= props.activityHistory.page_count || props.activityHistoryLoading"
          @click="changeHistoryPage((props.activityHistory?.page || 1) + 1)"
        >
          Next
        </button>
      </div>
    </div>

    <div v-else-if="participants.length === 0" class="activity-empty">
      <h3>{{ clearedLiveCount > 0 ? 'Live roster cleared' : 'No active room participants right now' }}</h3>
      <p>
        {{
          clearedLiveCount > 0
            ? 'Offline agents were cleared from the live roster. Switch to History to inspect the full room record.'
            : 'Agents and humans will appear here once they become active, go away, join, or send messages.'
        }}
      </p>
    </div>

    <div v-else class="activity-layout">
      <div class="activity-groups">
        <section class="activity-group">
          <div class="activity-group-header">
            <div>
              <h3>Active in room</h3>
              <p>Agents currently active through the room transport.</p>
            </div>
            <span class="activity-group-count">{{ activeAgents.length }}</span>
          </div>

          <div v-if="activeAgents.length > 0" class="activity-roster">
            <button
              v-for="participant in activeAgents"
              :key="participant.key"
              class="activity-roster-item"
              :data-selected="selectedParticipant?.key === participant.key"
              :data-kind="participant.kind"
              :data-connection="participant.activityState"
              type="button"
              @click="selectedParticipantKey = participant.key"
            >
              <div class="activity-roster-header">
                <div>
                  <div class="activity-roster-name">{{ participant.label }}</div>
                  <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                </div>
                <span class="activity-connection-pill" :data-connection="participant.activityState">
                  {{ connectionLabel(participant) }}
                </span>
              </div>
              <div class="activity-roster-status">
                <span
                  v-if="participant.status"
                  class="activity-status-dot"
                  :data-status="participant.status"
                />
                <span>{{ participantNote(participant) }}</span>
                <span
                  v-if="participant.activeReasoning.length > 0"
                  class="activity-reasoning-pill"
                >
                  {{ participant.activeReasoning.length === 1 ? '1 live reasoning stream' : `${participant.activeReasoning.length} live reasoning streams` }}
                </span>
                <span class="activity-roster-seen">{{ formatLastSeen(participant.lastSeenAt) }}</span>
              </div>
            </button>
          </div>

          <div v-else class="activity-group-empty">
            No active agents are in this room right now.
          </div>
        </section>

        <section class="activity-group">
          <div class="activity-group-header">
            <div>
              <h3>Away but reachable</h3>
              <p>Agents still connected to this room and able to receive messages.</p>
            </div>
            <span class="activity-group-count">{{ awayAgents.length }}</span>
          </div>

          <div v-if="awayAgents.length > 0" class="activity-roster">
            <button
              v-for="participant in awayAgents"
              :key="participant.key"
              class="activity-roster-item"
              :data-selected="selectedParticipant?.key === participant.key"
              :data-kind="participant.kind"
              :data-connection="participant.activityState"
              type="button"
              @click="selectedParticipantKey = participant.key"
            >
              <div class="activity-roster-header">
                <div>
                  <div class="activity-roster-name">{{ participant.label }}</div>
                  <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                </div>
                <span class="activity-connection-pill" :data-connection="participant.activityState">
                  {{ connectionLabel(participant) }}
                </span>
              </div>
              <div class="activity-roster-status">
                <span
                  v-if="participant.status"
                  class="activity-status-dot"
                  :data-status="participant.status"
                />
                <span>{{ participantNote(participant) }}</span>
                <span
                  v-if="participant.activeReasoning.length > 0"
                  class="activity-reasoning-pill"
                >
                  {{ participant.activeReasoning.length === 1 ? '1 live reasoning stream' : `${participant.activeReasoning.length} live reasoning streams` }}
                </span>
                <span class="activity-roster-seen">{{ formatLastSeen(participant.lastSeenAt) }}</span>
              </div>
            </button>
          </div>

          <div v-else class="activity-group-empty">
            No away agents are connected right now.
          </div>
        </section>

        <section class="activity-group">
          <div class="activity-group-header">
            <div>
              <h3>Offline</h3>
              <p>Agents that are no longer reachable in this room.</p>
            </div>
            <div class="activity-group-header-actions">
              <span class="activity-group-count">{{ offlineAgents.length }}</span>
              <button
                v-if="props.canManageParticipants && offlineAgents.length > 0"
                class="activity-action-button"
                type="button"
                :disabled="clearBusy"
                @click="handleClearDisconnected"
              >
                {{ clearBusy ? 'Clearing…' : 'Clear disconnected' }}
              </button>
            </div>
          </div>

          <div v-if="offlineAgents.length > 0" class="activity-roster">
            <button
              v-for="participant in offlineAgents"
              :key="participant.key"
              class="activity-roster-item"
              :data-selected="selectedParticipant?.key === participant.key"
              :data-kind="participant.kind"
              :data-connection="participant.activityState"
              type="button"
              @click="selectedParticipantKey = participant.key"
            >
              <div class="activity-roster-header">
                <div>
                  <div class="activity-roster-name">{{ participant.label }}</div>
                  <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                </div>
                <span class="activity-connection-pill" :data-connection="participant.activityState">
                  {{ connectionLabel(participant) }}
                </span>
              </div>
              <div class="activity-roster-status">
                <span
                  v-if="participant.status"
                  class="activity-status-dot"
                  :data-status="participant.status"
                />
                <span>{{ participantNote(participant) }}</span>
                <span
                  v-if="participant.activeReasoning.length > 0"
                  class="activity-reasoning-pill"
                >
                  {{ participant.activeReasoning.length === 1 ? '1 live reasoning stream' : `${participant.activeReasoning.length} live reasoning streams` }}
                </span>
                <span class="activity-roster-seen">{{ formatLastSeen(participant.lastSeenAt) }}</span>
              </div>
            </button>
          </div>

          <div v-else class="activity-group-empty">
            {{ clearedLiveCount > 0 ? 'Offline agents were cleared from the live roster.' : 'No offline agents have been seen yet.' }}
          </div>
        </section>

        <section class="activity-group">
          <div class="activity-group-header">
            <div>
              <h3>Humans seen in room</h3>
              <p>People detected from browser-side room activity.</p>
            </div>
            <span class="activity-group-count">{{ humans.length }}</span>
          </div>

          <div v-if="humans.length > 0" class="activity-roster">
            <button
              v-for="participant in humans"
              :key="participant.key"
              class="activity-roster-item"
              :data-selected="selectedParticipant?.key === participant.key"
              :data-kind="participant.kind"
              type="button"
              @click="selectedParticipantKey = participant.key"
            >
              <div class="activity-roster-header">
                <div>
                  <div class="activity-roster-name">{{ participant.label }}</div>
                  <div class="activity-roster-meta">{{ participantMeta(participant) }}</div>
                </div>
                <span class="activity-kind-pill">Human</span>
              </div>
              <div class="activity-roster-status">
                <span>{{ participantNote(participant) }}</span>
                <span class="activity-roster-seen">{{ formatLastSeen(participant.lastSeenAt) }}</span>
              </div>
            </button>
          </div>

          <div v-else class="activity-group-empty">
            No human browser activity has been seen yet.
          </div>
        </section>
      </div>

      <aside v-if="selectedParticipant" class="activity-detail" :data-kind="selectedParticipant.kind">
        <div class="activity-detail-header">
          <div>
            <div class="activity-detail-kicker">
              {{ selectedParticipant.kind === 'agent' ? 'Agent detail' : 'Human detail' }}
            </div>
            <h3>{{ selectedParticipant.label }}</h3>
            <p>{{ participantMeta(selectedParticipant) }}</p>
          </div>

          <div class="activity-detail-badges">
            <span
              v-if="selectedParticipant.kind === 'agent'"
              class="activity-connection-pill"
              :data-connection="selectedParticipant.activityState"
            >
              {{ connectionLabel(selectedParticipant) }}
            </span>
            <span
              v-if="selectedParticipant.status"
              class="activity-status-pill"
              :data-status="selectedParticipant.status"
            >
              {{ STATUS_LABELS[selectedParticipant.status] }}
            </span>
          </div>
        </div>

        <div class="activity-detail-stats">
          <article class="detail-stat">
            <strong>{{ selectedParticipant.messageCount }}</strong>
            <span>Messages</span>
          </article>
          <article class="detail-stat">
            <strong>{{ selectedParticipant.currentTasks.length }}</strong>
            <span>Current work</span>
          </article>
          <article class="detail-stat">
            <strong>{{ selectedParticipant.completedTasks.length }}</strong>
            <span>Completed</span>
          </article>
          <article class="detail-stat">
            <strong>{{ formatLastSeen(selectedParticipant.lastSeenAt) }}</strong>
            <span>Last activity</span>
          </article>
        </div>

        <section
          v-if="selectedParticipant.kind === 'agent' && selectedParticipant.thinkingSnapshot"
          class="activity-detail-section"
        >
          <div class="activity-detail-section-header">
            <h4>Reasoning snapshot</h4>
            <span>Live</span>
          </div>

          <AgentThinkingCard
            :card="selectedParticipant.thinkingSnapshot"
            kicker="Latest visible reasoning"
            :timestampLabel="formatLastSeen(selectedParticipant.lastSeenAt)"
          />
        </section>

        <p
          v-else-if="selectedParticipant.statusText"
          class="activity-detail-description"
        >
          {{ selectedParticipant.statusText }}
        </p>

        <section
          v-if="selectedParticipant.kind === 'agent'"
          class="activity-detail-section"
        >
          <div class="activity-detail-section-header">
            <h4>Live reasoning</h4>
            <span>{{ selectedParticipant.activeReasoning.length }}</span>
          </div>

          <div
            v-if="selectedParticipant.activeReasoning.length === 0"
            class="activity-detail-empty"
          >
            No active reasoning streams are exposed for this agent right now.
          </div>

          <div v-else class="activity-reasoning-list">
            <article
              v-for="session in selectedParticipant.activeReasoning"
              :key="session.id"
              class="activity-reasoning-card"
            >
              <div class="activity-reasoning-header">
                <strong>{{ reasoningCardTitle(session) }}</strong>
                <span>{{ formatLastSeen(reasoningTimestamp(session)) }}</span>
              </div>
              <p>{{ reasoningCardSummary(session) }}</p>
              <div class="activity-reasoning-meta">
                <span>{{ reasoningStatusLabel(session) }}</span>
                <span v-if="session.task_id">{{ session.task_id }}</span>
              </div>
              <button
                class="activity-reasoning-action"
                type="button"
                @click="selectedReasoningId = session.id"
              >
                Open reasoning
              </button>
            </article>
          </div>
        </section>

        <section
          v-if="selectedParticipant.kind === 'agent' && selectedParticipant.thinkingTimeline.length > 0"
          class="activity-detail-section"
        >
          <div class="activity-detail-section-header">
            <h4>Reasoning trail</h4>
            <span>{{ selectedParticipant.thinkingTimeline.length }}</span>
          </div>

          <div class="activity-thinking-list">
            <AgentThinkingCard
              v-for="entry in selectedParticipant.thinkingTimeline"
              :key="entry.id"
              :card="entry"
              compact
              :timestampLabel="formatLastSeen(entry.timestamp)"
            />
          </div>
        </section>

        <section class="activity-detail-section">
          <div class="activity-detail-section-header">
            <h4>Current work</h4>
            <span>{{ selectedParticipant.currentTasks.length }}</span>
          </div>

          <div v-if="selectedParticipant.currentTasks.length === 0" class="activity-detail-empty">
            No open tasks linked to this participant right now.
          </div>

          <div v-else class="activity-task-list">
            <article
              v-for="task in selectedParticipant.currentTasks"
              :key="task.id"
              class="activity-task-card"
            >
              <div class="activity-task-copy">
                <strong>{{ task.title }}</strong>
                <span>{{ TASK_STATUS_LABELS[task.status] || task.status }}</span>
              </div>
              <a
                v-if="getTaskLink(task)"
                class="activity-task-link"
                :href="getTaskLink(task)!.url"
                target="_blank"
              >
                {{ getTaskLink(task)!.label }}
              </a>
            </article>
          </div>
        </section>

        <section class="activity-detail-section">
          <div class="activity-detail-section-header">
            <h4>Recent completed work</h4>
            <span>{{ selectedParticipant.completedTasks.length }}</span>
          </div>

          <div v-if="selectedParticipant.completedTasks.length === 0" class="activity-detail-empty">
            No completed or merged tasks tracked yet.
          </div>

          <div v-else class="activity-task-list">
            <article
              v-for="task in selectedParticipant.completedTasks"
              :key="task.id"
              class="activity-task-card"
            >
              <div class="activity-task-copy">
                <strong>{{ task.title }}</strong>
                <span>{{ TASK_STATUS_LABELS[task.status] || task.status }}</span>
              </div>
              <a
                v-if="getTaskLink(task)"
                class="activity-task-link"
                :href="getTaskLink(task)!.url"
                target="_blank"
              >
                {{ getTaskLink(task)!.label }}
              </a>
            </article>
          </div>
        </section>

        <section v-if="selectedParticipant.createdTasks.length > 0" class="activity-detail-section">
          <div class="activity-detail-section-header">
            <h4>Tasks created</h4>
            <span>{{ selectedParticipant.createdTasks.length }}</span>
          </div>

          <div class="activity-task-list">
            <article
              v-for="task in selectedParticipant.createdTasks"
              :key="task.id"
              class="activity-task-card"
            >
              <div class="activity-task-copy">
                <strong>{{ task.title }}</strong>
                <span>{{ TASK_STATUS_LABELS[task.status] || task.status }}</span>
              </div>
              <a
                v-if="getTaskLink(task)"
                class="activity-task-link"
                :href="getTaskLink(task)!.url"
                target="_blank"
              >
                {{ getTaskLink(task)!.label }}
              </a>
            </article>
          </div>
        </section>

        <section class="activity-detail-section">
          <div class="activity-detail-section-header">
            <h4>Recent room messages</h4>
            <span>{{ selectedParticipant.recentMessages.length }}</span>
          </div>

          <div v-if="selectedParticipant.recentMessages.length === 0" class="activity-detail-empty">
            No recent room messages from this participant.
          </div>

          <div v-else class="activity-message-list">
            <article
              v-for="message in selectedParticipant.recentMessages"
              :key="message.id"
              class="activity-message-card"
            >
              <div class="activity-message-meta">
                <span>{{ message.source === 'browser' ? 'Browser' : 'Agent message' }}</span>
                <span>{{ formatLastSeen(message.timestamp) }}</span>
              </div>
              <p>{{ previewMessage(message.text) }}</p>
            </article>
          </div>
        </section>
      </aside>
    </div>
    <ReasoningTraceModal
      :open="Boolean(selectedReasoningSession)"
      :roomIdentifier="roomIdentifier"
      :session="selectedReasoningSession"
      @close="selectedReasoningId = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import AgentThinkingCard from './AgentThinkingCard.vue'
import ReasoningTraceModal from './ReasoningTraceModal.vue'
import { AppSelect } from '@/components/ui'
import {
  type FocusRoomInfo,
  isHumanSender,
  parseAgentIdentity,
  type RoomActivityHistoryEntry,
  type RoomActivityHistoryKind,
  type RoomActivityHistoryPage,
  type RoomAgentPresence,
  type RoomMessage,
  type RoomParticipant,
  type RoomInfo,
  type RoomReasoningSession,
  type RoomTask,
  type TaskGitHubArtifactStatus,
} from '@/composables/useRoom'
import {
  buildAgentReachabilitySources,
  resolveAgentActivityState,
  type AgentReachabilitySource,
} from './reachability'
import {
  buildAgentThinkingSnapshot,
  buildAgentThinkingTimeline,
  extractStatusText,
  type AgentThinkingCardData,
  type AgentThinkingTimelineEntry,
} from './agentThinking'

type ParticipantKind = 'agent' | 'human'
type ParticipantActivityState = 'active' | 'away' | 'offline'

interface ActivityParticipant {
  key: string
  kind: ParticipantKind
  label: string
  actorLabel: string
  ownerLabel: string | null
  ideLabel: string | null
  activityState: ParticipantActivityState | null
  hasCanonicalPresence: boolean
  status: RoomAgentPresence['status'] | null
  statusText: string | null
  lastSeenAt: string | null
  messageCount: number
  activeReasoning: RoomReasoningSession[]
  currentTasks: RoomTask[]
  completedTasks: RoomTask[]
  createdTasks: RoomTask[]
  recentMessages: RoomMessage[]
  thinkingSnapshot: AgentThinkingCardData | null
  thinkingTimeline: AgentThinkingTimelineEntry[]
}

interface HistoryParticipant {
  key: string
  roomId: string
  kind: ParticipantKind
  label: string
  actorLabel: string
  ownerLabel: string | null
  ideLabel: string | null
  activityState: ParticipantActivityState | null
  hasCanonicalPresence: boolean
  status: RoomAgentPresence['status'] | null
  statusText: string | null
  firstSeenAt: string | null
  lastSeenAt: string | null
  messageCount: number
  currentTasks: ReadonlyArray<RoomActivityHistoryEntry['current_tasks'][number]>
  completedTasks: ReadonlyArray<RoomActivityHistoryEntry['completed_tasks'][number]>
  createdTasks: ReadonlyArray<RoomActivityHistoryEntry['created_tasks'][number]>
  recentMessages: RoomMessage[]
  thinkingSnapshot: AgentThinkingCardData | null
  thinkingTimeline: AgentThinkingTimelineEntry[]
}

interface HistoryRoomOption {
  id: string
  label: string
  kind: 'main' | 'focus'
  sourceTaskId: string | null
}

const props = defineProps<{
  roomIdentifier: string
  currentRoom: RoomInfo | null
  focusRooms: readonly FocusRoomInfo[]
  messages: readonly RoomMessage[]
  participants: readonly RoomParticipant[]
  liveClearedCount: number
  presence: readonly RoomAgentPresence[]
  reasoningSessions: readonly RoomReasoningSession[]
  tasks: readonly RoomTask[]
  activityHistory: RoomActivityHistoryPage | null
  activityHistoryLoading: boolean
  activityHistoryError: string
  canManageParticipants: boolean
  loadActivityHistory?: (options?: {
    query?: string
    page?: number
    pageSize?: number
    kind?: RoomActivityHistoryKind
    roomId?: string
  }) => Promise<boolean>
  clearDisconnectedParticipants?: () => Promise<number>
  taskGithubStatus: Readonly<Record<string, TaskGitHubArtifactStatus>>
  isLoading?: boolean
}>()

const STATUS_ORDER = ['working', 'reviewing', 'blocked', 'idle'] as const
const STATUS_LABELS: Record<RoomAgentPresence['status'], string> = {
  idle: 'Idle',
  working: 'Working',
  reviewing: 'Reviewing',
  blocked: 'Blocked',
}
const ACTIVITY_STATE_LABELS: Record<ParticipantActivityState, string> = {
  active: 'Active',
  away: 'Away',
  offline: 'Offline',
}
const TASK_STATUS_LABELS: Record<string, string> = {
  proposed: 'Proposed',
  accepted: 'Accepted',
  assigned: 'Assigned',
  in_progress: 'In progress',
  blocked: 'Blocked',
  in_review: 'In review',
  merged: 'Merged',
  done: 'Done',
  cancelled: 'Cancelled',
}
const COMPLETED_TASK_STATUSES = new Set(['merged', 'done'])
const OPEN_TASK_STATUSES = new Set(['proposed', 'accepted', 'assigned', 'in_progress', 'blocked', 'in_review'])
const INACTIVE_REASONING_STATUSES = new Set(['completed', 'done', 'dismissed', 'closed'])

const activeView = ref<'live' | 'history'>('live')
const selectedParticipantKey = ref<string | null>(null)
const selectedHistoryParticipantKey = ref<string | null>(null)
const selectedReasoningId = ref<string | null>(null)
const historyQuery = ref('')
const historyKind = ref<RoomActivityHistoryKind>('all')
const historyRoomId = ref('')
const clearBusy = ref(false)
let historySearchTimer: ReturnType<typeof setTimeout> | null = null

function isAgentIdentityValue(value: string | null | undefined): boolean {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  if (normalized.toLowerCase() === 'letagents' || normalized.toLowerCase() === 'system') return false
  const parsed = parseAgentIdentity(normalized)
  return Boolean(parsed.structured || parsed.ownerAttribution || parsed.ideLabel)
}

function pushMapValue<T>(target: Map<string, T[]>, key: string, value: T) {
  const existing = target.get(key)
  if (existing) {
    existing.push(value)
    return
  }
  target.set(key, [value])
}

function previewMessage(text: string): string {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return 'No message body'
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized
}

function timestampValue(value: string | null | undefined): number {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : -1
}

function latestTimestamp(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null
  let bestValue = -1
  for (const value of values) {
    const current = timestampValue(value)
    if (current > bestValue) {
      best = value || null
      bestValue = current
    }
  }
  return best
}

function sortTasksByUpdated(tasks: readonly RoomTask[]): RoomTask[] {
  return [...tasks].sort((left, right) => right.updated_at.localeCompare(left.updated_at))
}

function latestTaskTimestamp(tasks: readonly RoomTask[]): string | null {
  return sortTasksByUpdated(tasks)[0]?.updated_at || null
}

function reasoningTimestamp(session: Partial<RoomReasoningSession> | null | undefined): string | null {
  if (!session) return null
  return session.updated_at || session.created_at || session.entries?.[session.entries.length - 1]?.timestamp || null
}

function sortReasoningSessions(sessions: readonly RoomReasoningSession[]): RoomReasoningSession[] {
  return [...sessions].sort((left, right) => timestampValue(reasoningTimestamp(right)) - timestampValue(reasoningTimestamp(left)))
}

const agentMessagesByActor = computed(() => {
  const grouped = new Map<string, RoomMessage[]>()
  for (const message of props.messages) {
    const sender = String(message.sender || '').trim()
    if (!sender || isHumanSender(sender, message.source)) continue
    const key = message.agent_identity?.actor_label || sender
    pushMapValue(grouped, key, message)
  }
  return grouped
})

const presenceByActor = computed(() =>
  new Map(props.presence.map((entry) => [entry.actor_label, entry]))
)

function participantMatchesHuman(participant: RoomParticipant, value: string | null): boolean {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return false

  const githubLogin = String(participant.github_login || '').trim().toLowerCase()
  const displayName = String(participant.display_name || '').trim().toLowerCase()
  return normalized === githubLogin || normalized === displayName
}

function participantMatchesActor(participant: ActivityParticipant, value: string | null): boolean {
  const normalized = String(value || '').trim()
  if (!normalized) return false
  if (normalized === participant.actorLabel) return true

  if (participant.kind === 'agent' && isAgentIdentityValue(normalized)) {
    return parseAgentIdentity(normalized).displayName === participant.label
  }

  return false
}

function sessionMatchesAgent(participant: {
  actorLabel: string
  label: string
}, session: RoomReasoningSession): boolean {
  const actorLabel = String(session.actor_label || '').trim()
  if (actorLabel && actorLabel === participant.actorLabel) return true

  const agentDisplayName = actorLabel ? parseAgentIdentity(actorLabel).displayName : ''
  return Boolean(agentDisplayName && agentDisplayName === participant.label)
}

function isActiveReasoningSession(session: RoomReasoningSession): boolean {
  if (session.closed_at) return false
  return !INACTIVE_REASONING_STATUSES.has(String(session.status || '').toLowerCase())
}

function buildAgentParticipant(source: AgentReachabilitySource): ActivityParticipant {
  const { actorLabel, key, participant, presence: presenceEntry, activityState } = source
  const messages = actorLabel ? (agentMessagesByActor.value.get(actorLabel) || []) : []
  const latestMessage = messages[messages.length - 1] || null
  const latestStatusMessage = [...messages].reverse().find((message) =>
    /^\[status\]\s*/i.test(String(message.text || ''))
  ) || null
  const parsed = parseAgentIdentity(actorLabel)
  const label = participant?.display_name || presenceEntry?.display_name || latestMessage?.agent_identity?.display_name || parsed.displayName || actorLabel
  const ownerLabel = participant?.owner_label
    || presenceEntry?.owner_label
    || latestMessage?.agent_identity?.owner_label
    || parsed.ownerAttribution
    || null
  const ideLabel = participant?.ide_label || presenceEntry?.ide_label || latestMessage?.agent_identity?.ide_label || parsed.ideLabel || null
  const activeReasoning = sortReasoningSessions(
    props.reasoningSessions.filter((session) =>
      isActiveReasoningSession(session)
      && sessionMatchesAgent({ actorLabel, label }, session)
    )
  )

  const assignedTasks = props.tasks.filter((task) => participantMatchesActor({
    key,
    kind: 'agent',
    label,
    actorLabel,
    ownerLabel,
    ideLabel,
    activityState: null,
    hasCanonicalPresence: false,
    status: null,
    statusText: null,
    lastSeenAt: null,
    messageCount: messages.length,
    activeReasoning: [],
    currentTasks: [],
    completedTasks: [],
    createdTasks: [],
    recentMessages: [],
    thinkingSnapshot: null,
    thinkingTimeline: [],
  }, task.assignee))
  const currentTasks = sortTasksByUpdated(assignedTasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)))
  const completedTasks = sortTasksByUpdated(
    assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))
  ).slice(0, 8)
  const createdTasks = sortTasksByUpdated(
    props.tasks.filter((task) => participantMatchesActor({
      key,
      kind: 'agent',
      label,
      actorLabel,
      ownerLabel,
      ideLabel,
      activityState: null,
      hasCanonicalPresence: false,
      status: null,
      statusText: null,
      lastSeenAt: null,
      messageCount: messages.length,
      activeReasoning: [],
      currentTasks: [],
      completedTasks: [],
      createdTasks: [],
      recentMessages: [],
      thinkingSnapshot: null,
      thinkingTimeline: [],
    }, task.created_by))
  ).slice(0, 8)
  const statusText = presenceEntry?.status_text || (latestStatusMessage ? extractStatusText(latestStatusMessage.text || '') : null) || null
  const thinkingSnapshot = buildAgentThinkingSnapshot({
    messages,
    status: presenceEntry?.status || null,
    statusText,
  })
  const thinkingTimeline = buildAgentThinkingTimeline(messages)

  return {
    key,
    kind: 'agent',
    label,
    actorLabel,
    ownerLabel,
    ideLabel,
    activityState,
    hasCanonicalPresence: Boolean(
      presenceEntry?.source_flags?.includes('delivery')
    ),
    status: presenceEntry?.status || null,
    statusText,
    lastSeenAt: latestTimestamp(
      participant?.last_room_activity_at,
      participant?.last_seen_at,
      latestMessage?.timestamp,
      presenceEntry?.last_heartbeat_at,
      reasoningTimestamp(activeReasoning[0] || {}),
      latestTaskTimestamp(currentTasks),
      latestTaskTimestamp(completedTasks),
      latestTaskTimestamp(createdTasks)
    ),
    messageCount: messages.length,
    activeReasoning,
    currentTasks,
    completedTasks,
    createdTasks,
    recentMessages: [...messages].slice(-4).reverse(),
    thinkingSnapshot,
    thinkingTimeline,
  }
}

function buildHumanParticipant(participant: RoomParticipant): ActivityParticipant {
  const label = participant.display_name || participant.github_login || 'Unknown human'
  const messages = props.messages.filter((message) =>
    isHumanSender(message.sender, message.source) && participantMatchesHuman(participant, message.sender)
  )
  const assignedTasks = props.tasks.filter((task) => participantMatchesHuman(participant, task.assignee))
  const createdTasks = sortTasksByUpdated(
    props.tasks.filter((task) => participantMatchesHuman(participant, task.created_by))
  ).slice(0, 8)
  const currentTasks = sortTasksByUpdated(assignedTasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)))
  const completedTasks = sortTasksByUpdated(
    assignedTasks.filter((task) => COMPLETED_TASK_STATUSES.has(task.status))
  ).slice(0, 8)
  const latestMessage = messages[messages.length - 1] || null

  return {
    key: participant.participant_key,
    kind: 'human',
    label,
    actorLabel: participant.github_login || label,
    ownerLabel: null,
    ideLabel: null,
    activityState: null,
    hasCanonicalPresence: false,
    status: null,
    statusText: latestMessage ? previewMessage(latestMessage.text) : null,
    lastSeenAt: latestTimestamp(
      participant.last_room_activity_at,
      participant.last_seen_at,
      latestMessage?.timestamp
    ),
    messageCount: messages.length,
    activeReasoning: [],
    currentTasks,
    completedTasks,
    createdTasks,
    recentMessages: [...messages].slice(-4).reverse(),
    thinkingSnapshot: null,
    thinkingTimeline: [],
  }
}

function compareParticipants(left: ActivityParticipant | HistoryParticipant, right: ActivityParticipant | HistoryParticipant): number {
  const leftStatus = left.status ? STATUS_ORDER.indexOf(left.status) : STATUS_ORDER.length
  const rightStatus = right.status ? STATUS_ORDER.indexOf(right.status) : STATUS_ORDER.length
  if (leftStatus !== rightStatus) {
    return leftStatus - rightStatus
  }

  const timestampDelta = timestampValue(right.lastSeenAt) - timestampValue(left.lastSeenAt)
  if (timestampDelta !== 0) {
    return timestampDelta
  }

  return left.label.localeCompare(right.label)
}

const agentParticipants = computed(() => {
  return buildAgentReachabilitySources({
    participants: props.participants,
    presence: props.presence,
  })
    .map((source) => buildAgentParticipant(source))
    .sort(compareParticipants)
})

const humanParticipants = computed(() => {
  return props.participants
    .filter((participant) => participant.kind === 'human')
    .map((participant) => buildHumanParticipant(participant))
    .sort(compareParticipants)
})

const activeAgents = computed(() =>
  agentParticipants.value.filter((participant) => participant.activityState === 'active')
)

const awayAgents = computed(() =>
  agentParticipants.value.filter((participant) => participant.activityState === 'away')
)

const offlineAgents = computed(() =>
  agentParticipants.value.filter((participant) =>
    participant.activityState === 'offline' && participant.hasCanonicalPresence
  )
)

const activeReasoningSessions = computed(() =>
  agentParticipants.value.flatMap((participant) => participant.activeReasoning)
)

const humans = computed(() => humanParticipants.value)

const participants = computed(() => [
  ...activeAgents.value,
  ...awayAgents.value,
  ...offlineAgents.value,
  ...humans.value,
])

const currentRoomIdentifier = computed(() => props.currentRoom?.identifier || props.roomIdentifier)
const historyEntries = computed(() => props.activityHistory?.entries || [])
const clearedLiveCount = computed(() => props.liveClearedCount || 0)
const historyRoomOptions = computed<HistoryRoomOption[]>(() => {
  const options: HistoryRoomOption[] = []
  const seen = new Set<string>()

  const pushOption = (option: HistoryRoomOption | null) => {
    if (!option?.id || seen.has(option.id)) return
    seen.add(option.id)
    options.push(option)
  }

  pushOption(currentRoomIdentifier.value
    ? {
      id: currentRoomIdentifier.value,
      label: props.currentRoom?.displayName || currentRoomIdentifier.value,
      kind: props.currentRoom?.kind || 'main',
      sourceTaskId: props.currentRoom?.sourceTaskId || null,
    }
    : null)

  if (props.currentRoom?.kind === 'main') {
    for (const focusRoom of props.focusRooms) {
      pushOption({
        id: focusRoom.room_id,
        label: focusRoom.display_name,
        kind: focusRoom.kind,
        sourceTaskId: focusRoom.source_task_id || null,
      })
    }
  }

  return options
})
const selectedHistoryRoomId = computed(() =>
  props.activityHistory?.selected_room_id
  || historyRoomId.value
  || currentRoomIdentifier.value
)
const selectedHistoryRoomOption = computed<HistoryRoomOption | null>(() => {
  const selected = historyRoomOptions.value.find((option) => option.id === selectedHistoryRoomId.value)
  if (selected) {
    return selected
  }

  const historyRoom = historyEntries.value[0]?.room
  if (historyRoom) {
    return {
      id: historyRoom.id,
      label: historyRoom.display_name,
      kind: historyRoom.kind,
      sourceTaskId: historyRoom.source_task_id,
    }
  }

  if (!selectedHistoryRoomId.value) {
    return null
  }

  return {
    id: selectedHistoryRoomId.value,
    label: selectedHistoryRoomId.value,
    kind: 'main',
    sourceTaskId: null,
  }
})
const historyCountLabel = computed(() => {
  const total = props.activityHistory?.total || 0
  const roomLabel = selectedHistoryRoomOption.value?.label || 'selected room'
  return total === 1
    ? `1 participant in ${roomLabel}`
    : `${total} participants in ${roomLabel}`
})
const historyPageLabel = computed(() => {
  if (!props.activityHistory) return ''
  return `Page ${props.activityHistory.page} of ${props.activityHistory.page_count}`
})
const historyOpenTaskCount = computed(() =>
  historyEntries.value.reduce((total, entry) => total + entry.current_tasks.length, 0)
)

function buildHistoryParticipant(entry: RoomActivityHistoryEntry): HistoryParticipant {
  const actorLabel = String(entry.participant.actor_label || entry.participant.display_name || '').trim()
  const parsed = parseAgentIdentity(actorLabel)
  const label = entry.participant.display_name
    || parsed.displayName
    || actorLabel
    || 'Unknown participant'
  const ownerLabel = entry.participant.owner_label
    || parsed.ownerAttribution
    || null
  const ideLabel = entry.participant.ide_label
    || parsed.ideLabel
    || null

  return {
    key: entry.id,
    roomId: entry.room.id,
    kind: entry.participant.kind,
    label,
    actorLabel: entry.participant.kind === 'human'
      ? (entry.participant.github_login || label)
      : actorLabel,
    ownerLabel,
    ideLabel,
    activityState: null,
    hasCanonicalPresence: false,
    status: null,
    statusText: null,
    firstSeenAt: entry.first_seen_at,
    lastSeenAt: entry.last_seen_at,
    messageCount: 0,
    currentTasks: entry.current_tasks,
    completedTasks: entry.completed_tasks,
    createdTasks: entry.created_tasks,
    recentMessages: [],
    thinkingSnapshot: null,
    thinkingTimeline: [],
  }
}

const historyParticipants = computed(() =>
  historyEntries.value
    .map((entry) => buildHistoryParticipant(entry))
    .sort(compareParticipants)
)
const historyAgents = computed(() =>
  historyParticipants.value.filter((participant) => participant.kind === 'agent')
)
const historyHumans = computed(() =>
  historyParticipants.value.filter((participant) => participant.kind === 'human')
)
const showHistoryAgentSection = computed(() => historyKind.value !== 'human')
const showHistoryHumanSection = computed(() => historyKind.value !== 'agent')
const historySummaryCards = computed(() => [
  {
    value: historyAgents.value.length,
    label: 'Agents in history',
  },
  {
    value: historyHumans.value.length,
    label: 'Humans in history',
  },
  {
    value: historyOpenTaskCount.value,
    label: 'Open tasks linked',
  },
])

const selectedParticipant = computed(() =>
  participants.value.find((participant) => participant.key === selectedParticipantKey.value)
  || participants.value[0]
  || null
)
const selectedReasoningSession = computed(() => {
  const selectedId = selectedReasoningId.value
  if (!selectedId) return null
  return props.reasoningSessions.find((session) => session.id === selectedId) || null
})
const selectedHistoryParticipant = computed(() =>
  historyParticipants.value.find((participant) => participant.key === selectedHistoryParticipantKey.value)
  || historyParticipants.value[0]
  || null
)

watch(participants, (next) => {
  if (!next.length) {
    selectedParticipantKey.value = null
    return
  }

  if (!selectedParticipantKey.value || !next.some((participant) => participant.key === selectedParticipantKey.value)) {
    selectedParticipantKey.value = next[0].key
  }
}, { immediate: true })

watch(historyParticipants, (next) => {
  if (!next.length) {
    selectedHistoryParticipantKey.value = null
    return
  }

  if (!selectedHistoryParticipantKey.value || !next.some((participant) => participant.key === selectedHistoryParticipantKey.value)) {
    selectedHistoryParticipantKey.value = next[0].key
  }
}, { immediate: true })

async function requestHistory(page = props.activityHistory?.page || 1): Promise<void> {
  if (!props.roomIdentifier || !props.loadActivityHistory) return
  await props.loadActivityHistory({
    query: historyQuery.value,
    page,
    pageSize: props.activityHistory?.page_size || 20,
    kind: historyKind.value,
    roomId: historyRoomId.value || currentRoomIdentifier.value,
  })
}

function queueHistoryReload(): void {
  if (historySearchTimer) {
    clearTimeout(historySearchTimer)
  }
  historySearchTimer = setTimeout(() => {
    if (activeView.value === 'history') {
      void requestHistory(1)
    }
  }, 220)
}

watch(() => activeView.value, (next) => {
  if (next === 'history' && !props.activityHistoryLoading) {
    if (!historyRoomId.value) {
      historyRoomId.value = currentRoomIdentifier.value || ''
    }
    void requestHistory(props.activityHistory?.page || 1)
  }
})

watch(currentRoomIdentifier, (next) => {
  if (next && !historyRoomId.value) {
    historyRoomId.value = next
  }
  if (activeView.value === 'history') {
    void requestHistory(1)
  }
}, { immediate: true })

watch(() => props.activityHistory?.selected_room_id, (next) => {
  if (next && next !== historyRoomId.value) {
    historyRoomId.value = next
  }
})

watch(() => historyRoomId.value, (next, previous) => {
  if (!next || next === previous || activeView.value !== 'history') {
    return
  }
  void requestHistory(1)
})

watch(() => historyKind.value, () => {
  if (activeView.value === 'history') {
    void requestHistory(1)
  }
})

watch(() => historyQuery.value, () => {
  queueHistoryReload()
})

onUnmounted(() => {
  if (historySearchTimer) {
    clearTimeout(historySearchTimer)
    historySearchTimer = null
  }
})

function participantMeta(participant: ActivityParticipant | HistoryParticipant): string {
  if (participant.kind === 'human') {
    return 'Human participant'
  }

  const bits = [participant.ownerLabel, participant.ideLabel].filter(Boolean)
  return bits.join(' · ') || 'Agent'
}

function participantNote(participant: ActivityParticipant | HistoryParticipant): string {
  if (participant.statusText) {
    return participant.statusText
  }

  if (participant.kind === 'agent') {
    if (participant.activityState === 'offline') {
      return participant.hasCanonicalPresence
        ? 'Offline from this room right now'
        : 'Recorded in room history'
    }

    if (participant.activityState === 'away') {
      return 'Away but still reachable'
    }

    return 'Active in room right now'
  }

  return participant.messageCount > 0
    ? 'Seen via browser room activity'
    : 'Known from task history'
}

function historyLastSeenLabel(value: string | null): string {
  const relative = formatLastSeen(value)
  return relative === 'unknown' ? 'Last in room unknown' : `Last in room ${relative}`
}

function historyParticipantNote(participant: HistoryParticipant): string {
  if (participant.kind === 'human') {
    return 'Seen via browser room history'
  }

  if (!participant.firstSeenAt) {
    return 'Recorded in room history'
  }

  return `First joined ${formatLastSeen(participant.firstSeenAt)}`
}

function historyDetailNote(participant: HistoryParticipant): string {
  if (participant.kind === 'human') {
    return 'History stays focused on room participation and linked work. Use the Live tab for current browser activity.'
  }

  return 'History stays focused on room participation and linked work. Use the Live tab to inspect current active, away, or offline state.'
}

function reasoningCardTitle(session: RoomReasoningSession): string {
  return session.title || session.summary || session.goal || 'Reasoning stream'
}

function reasoningCardSummary(session: RoomReasoningSession): string {
  return session.latest_payload?.checking
    || session.latest_payload?.next_action
    || session.latest_payload?.hypothesis
    || session.checking
    || session.next_action
    || session.hypothesis
    || session.summary
    || 'No summary published yet.'
}

function reasoningStatusLabel(session: RoomReasoningSession): string {
  if (session.closed_at) return 'Closed'
  const normalized = String(session.status || 'active').trim()
  if (!normalized) return 'Active'
  return normalized
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function connectionLabel(participant: ActivityParticipant | HistoryParticipant | null): string {
  if (!participant || participant.kind !== 'agent') return 'Human'
  return participant.activityState ? ACTIVITY_STATE_LABELS[participant.activityState] : 'History'
}

function getTaskLink(task: {
  id: string
  workflow_refs: ReadonlyArray<{ label: string; url: string }>
}): { label: string; url: string } | null {
  const gh = props.taskGithubStatus[task.id]
  if (gh?.pr_url) {
    return {
      label: gh.pr_number ? `PR #${gh.pr_number}` : 'Pull request',
      url: gh.pr_url,
    }
  }

  const firstWorkflowRef = task.workflow_refs[0]
  if (firstWorkflowRef) {
    return {
      label: firstWorkflowRef.label,
      url: firstWorkflowRef.url,
    }
  }

  return null
}

function changeHistoryPage(page: number): void {
  void requestHistory(page)
}

async function handleClearDisconnected(): Promise<void> {
  if (!props.clearDisconnectedParticipants || clearBusy.value) return
  clearBusy.value = true
  try {
    await props.clearDisconnectedParticipants()
    if (activeView.value === 'history') {
      await requestHistory(props.activityHistory?.page || 1)
    }
  } finally {
    clearBusy.value = false
  }
}

function formatLastSeen(value: string | null): string {
  if (!value) return 'unknown'
  const diffMs = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 'unknown'
  }

  const diffMinutes = Math.round(diffMs / 60_000)
  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`

  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.round(diffHours / 24)
  return `${diffDays}d ago`
}
</script>

<style scoped>
.activity-panel {
  --activity-border: var(--border, rgba(255, 255, 255, 0.06));
  --activity-border-strong: var(--border-strong, rgba(255, 255, 255, 0.12));
  --activity-surface: var(--bg-card, #141414);
  --activity-surface-soft: var(--accent-dim, rgba(255, 255, 255, 0.04));
  --activity-surface-hover: var(--accent-hover, rgba(255, 255, 255, 0.08));
  --activity-text-secondary: var(--text-secondary, #a1a1aa);
  --activity-text-tertiary: var(--text-tertiary, #71717a);
  --activity-blue: var(--blue, #3b82f6);
  --activity-blue-dim: var(--blue-dim, rgba(59, 130, 246, 0.1));
  --activity-green: var(--green, #22c55e);
  --activity-green-dim: var(--green-dim, rgba(34, 197, 94, 0.1));
  --activity-amber: var(--amber, #f59e0b);
  --activity-amber-dim: var(--amber-dim, rgba(245, 158, 11, 0.1));
  --activity-red: var(--red, #ef4444);
  --activity-red-dim: var(--red-dim, rgba(239, 68, 68, 0.1));
  height: 100%;
  overflow-y: auto;
  padding: var(--space-lg, 24px);
}

.activity-refresh-indicator {
  position: sticky;
  top: 0;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  margin-bottom: var(--space-sm, 8px);
  padding: 8px 10px;
  border: 1px solid var(--activity-border);
  border-radius: 999px;
  background: color-mix(in srgb, var(--activity-surface) 88%, transparent);
  color: var(--activity-text-secondary);
  font-size: 0.78rem;
  backdrop-filter: blur(10px);
}

.activity-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid color-mix(in srgb, var(--activity-blue) 22%, transparent);
  border-top-color: var(--activity-blue);
  border-radius: 999px;
  animation: activity-spin 0.8s linear infinite;
}

@keyframes activity-spin {
  to { transform: rotate(360deg); }
}

.activity-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-sm, 8px);
  margin-bottom: var(--space-lg, 24px);
}

.summary-card {
  display: grid;
  gap: 2px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--activity-border);
  background: var(--activity-surface-soft);
}

.summary-card strong {
  font-size: 1.08rem;
  color: var(--text, #fafafa);
  line-height: 1.2;
}

.summary-card span {
  font-size: 0.76rem;
  color: var(--activity-text-tertiary);
}

.activity-empty {
  display: grid;
  place-items: center;
  min-height: 220px;
  text-align: center;
  color: var(--muted, #71717a);
}

.activity-empty h3 {
  margin-bottom: 6px;
  color: var(--text, #fafafa);
  font-size: 0.95rem;
}

.activity-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.76fr);
  gap: var(--space-lg, 24px);
  align-items: start;
}

.activity-groups {
  display: grid;
  gap: var(--space-lg, 24px);
}

.activity-group {
  display: grid;
  gap: 10px;
}

.activity-detail {
  display: grid;
  gap: 12px;
  padding: var(--space-md, 16px);
  border-radius: 8px;
  border: 1px solid var(--activity-border);
  background: var(--activity-surface);
}

.activity-group-header,
.activity-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.activity-group-header {
  padding-bottom: 8px;
  border-bottom: 1px solid var(--activity-border);
}

.activity-group-header h3,
.activity-detail-header h3 {
  margin: 0;
  font-size: 0.92rem;
  color: var(--text, #fafafa);
}

.activity-group-header p,
.activity-detail-header p {
  margin: 4px 0 0;
  font-size: 0.78rem;
  color: var(--activity-text-tertiary);
  line-height: 1.45;
}

.activity-group-count,
.activity-kind-pill,
.activity-connection-pill,
.activity-status-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 54px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0;
}

.activity-group-count,
.activity-kind-pill {
  border: 1px solid var(--activity-border);
  background: var(--activity-surface-soft);
  color: var(--activity-text-secondary);
}

.activity-connection-pill[data-connection='active'] {
  background: var(--activity-green-dim);
  color: var(--activity-green);
}

.activity-connection-pill[data-connection='away'] {
  background: var(--activity-blue-dim);
  color: var(--activity-blue);
}

.activity-connection-pill[data-connection='offline'] {
  background: var(--activity-surface-hover);
  color: var(--activity-text-secondary);
}

.activity-status-pill[data-status='idle'] { background: var(--activity-surface-hover); color: var(--activity-text-secondary); }
.activity-status-pill[data-status='working'] { background: var(--activity-blue-dim); color: var(--activity-blue); }
.activity-status-pill[data-status='reviewing'] { background: var(--activity-amber-dim); color: var(--activity-amber); }
.activity-status-pill[data-status='blocked'] { background: var(--activity-red-dim); color: var(--activity-red); }

.activity-roster {
  display: grid;
  gap: var(--space-sm, 8px);
}

.activity-roster-item {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--activity-border);
  background: var(--activity-surface-soft);
  text-align: left;
  cursor: pointer;
  transition: border-color 150ms ease, transform 150ms ease, background 150ms ease;
}

.activity-roster-item:hover,
.activity-roster-item[data-selected='true'] {
  border-color: color-mix(in srgb, var(--activity-blue) 42%, transparent);
  background: var(--activity-blue-dim);
  transform: translateY(-1px);
}

.activity-roster-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.activity-roster-name {
  font-size: 0.88rem;
  font-weight: 700;
  color: var(--text, #fafafa);
  line-height: 1.35;
}

.activity-roster-meta {
  margin-top: 3px;
  font-size: 0.74rem;
  color: var(--activity-text-tertiary);
}

.activity-roster-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 0.78rem;
  color: var(--activity-text-secondary);
}

.activity-roster-status span:first-of-type:not(.activity-status-dot) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-reasoning-pill {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.12);
  color: #93c5fd;
  font-size: 0.68rem;
  font-weight: 700;
}

.activity-roster-seen {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--activity-text-tertiary);
}

.activity-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #71717a;
  flex-shrink: 0;
}

.activity-status-dot[data-status='idle'] { background: var(--activity-text-tertiary); }
.activity-status-dot[data-status='working'] { background: var(--activity-blue); }
.activity-status-dot[data-status='reviewing'] { background: var(--activity-amber); }
.activity-status-dot[data-status='blocked'] { background: var(--activity-red); }

.activity-group-empty,
.activity-detail-empty {
  padding: 12px;
  border-radius: 8px;
  border: 1px dashed var(--activity-border-strong);
  color: var(--activity-text-tertiary);
  font-size: 0.8rem;
}

.activity-detail-kicker {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--activity-blue);
}

.activity-detail-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.activity-detail-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: var(--space-sm, 8px);
}

.detail-stat {
  display: grid;
  gap: 4px;
  padding: 10px;
  border-radius: 8px;
  background: var(--activity-surface-soft);
  border: 1px solid var(--activity-border);
}

.detail-stat strong {
  font-size: 0.96rem;
  color: var(--text, #fafafa);
}

.detail-stat span {
  font-size: 0.72rem;
  color: var(--activity-text-tertiary);
}

.activity-detail-description {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.55;
  color: var(--activity-text-secondary);
}

.activity-detail-section {
  display: grid;
  gap: 10px;
}

.activity-detail-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.activity-detail-section-header h4 {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
  color: var(--activity-text-tertiary);
}

.activity-detail-section-header span {
  font-size: 0.74rem;
  color: var(--activity-text-tertiary);
}

.activity-task-list,
.activity-message-list,
.activity-thinking-list,
.activity-reasoning-list {
  display: grid;
  gap: var(--space-sm, 8px);
}

.activity-task-card,
.activity-message-card,
.activity-reasoning-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--activity-border);
  background: var(--activity-surface-soft);
}

.activity-task-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.activity-task-copy strong {
  font-size: 0.82rem;
  color: var(--text, #fafafa);
}

.activity-task-copy span {
  font-size: 0.72rem;
  color: var(--activity-text-tertiary);
}

.activity-task-link {
  flex-shrink: 0;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--activity-blue);
  text-decoration: none;
}

.activity-task-link:hover {
  text-decoration: underline;
}

.activity-message-card {
  display: grid;
  gap: 6px;
}

.activity-message-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 0.72rem;
  color: var(--activity-text-tertiary);
}

.activity-message-card p {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text, #fafafa);
}

.activity-reasoning-card {
  display: grid;
  gap: 10px;
}

.activity-reasoning-header,
.activity-reasoning-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.activity-reasoning-header strong {
  color: var(--text, #fafafa);
  font-size: 0.84rem;
  line-height: 1.4;
}

.activity-reasoning-header span,
.activity-reasoning-meta span {
  font-size: 0.72rem;
  color: var(--activity-text-tertiary);
}

.activity-reasoning-card p {
  margin: 0;
  color: var(--activity-text-secondary);
  font-size: 0.8rem;
  line-height: 1.5;
}

.activity-reasoning-action {
  justify-self: start;
  border: 1px solid rgba(59, 130, 246, 0.22);
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.1);
  color: #bfdbfe;
  cursor: pointer;
  font: inherit;
  font-size: 0.74rem;
  font-weight: 700;
  line-height: 1;
  padding: 9px 12px;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.activity-reasoning-action:hover,
.activity-reasoning-action:focus-visible {
  background: rgba(59, 130, 246, 0.16);
  border-color: rgba(147, 197, 253, 0.34);
  outline: none;
}

.activity-toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: var(--space-md, 16px);
}

.activity-view-switcher {
  display: inline-flex;
  gap: 6px;
  padding: 4px;
  border: 1px solid var(--activity-border);
  border-radius: 999px;
  background: var(--activity-surface-soft);
}

.activity-view-button,
.activity-action-button,
.activity-pagination-button {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text, #fafafa);
  cursor: pointer;
  transition: background 0.18s ease, border-color 0.18s ease, opacity 0.18s ease;
}

.activity-view-button {
  padding: 8px 14px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 700;
}

.activity-view-button[data-active="true"] {
  background: var(--activity-blue-dim);
  border-color: rgba(59, 130, 246, 0.26);
}

.activity-toolbar-note {
  margin: 0;
  font-size: 0.78rem;
  color: var(--activity-text-secondary);
}

.activity-history-view {
  display: grid;
  gap: 14px;
}

.activity-history-toolbar {
  display: flex;
  align-items: end;
  gap: 12px;
  flex-wrap: wrap;
}

.activity-history-search,
.activity-history-filter {
  display: grid;
  gap: 6px;
}

.activity-history-search {
  flex: 1;
  min-width: 220px;
}

.activity-history-search span,
.activity-history-filter span {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--activity-text-tertiary);
}

.activity-history-search input {
  min-height: 40px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--activity-border);
  background: var(--activity-surface);
  color: var(--text, #fafafa);
}

.activity-history-filter :deep(.app-select__control) {
  --app-select-border: var(--activity-border);
  --app-select-bg: var(--activity-surface);
  --app-select-text: var(--text, #fafafa);
  --app-select-focus: rgba(59, 130, 246, 0.28);
  --app-select-height: 40px;
  --app-select-padding-left: 12px;
  --app-select-padding-right: 38px;
}

.activity-history-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 0.76rem;
  color: var(--activity-text-secondary);
}

.activity-history-list {
  display: grid;
  gap: 12px;
}

.activity-history-card {
  display: grid;
  gap: 14px;
  padding: 16px;
  border-radius: 14px;
  border: 1px solid var(--activity-border);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01));
}

.activity-history-card-header,
.activity-group-header-actions {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.activity-group-header-actions {
  align-items: center;
  flex-wrap: wrap;
}

.activity-group-header-actions > .activity-group-count,
.activity-group-header-actions > .activity-action-button {
  min-height: 40px;
}

.activity-group-header-actions > .activity-group-count {
  min-width: 48px;
  padding: 0 14px;
}

.activity-group-header-actions > .activity-action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
}

.activity-history-room-line,
.activity-history-room-meta,
.activity-history-timestamps {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.activity-history-room-meta,
.activity-history-timestamps {
  font-size: 0.76rem;
  color: var(--activity-text-secondary);
}

.activity-history-room-pill {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 999px;
  background: var(--activity-surface-soft);
  border: 1px solid var(--activity-border);
  font-size: 0.7rem;
  color: var(--activity-text-secondary);
}

.activity-history-room-pill[data-hidden="true"] {
  background: rgba(245, 158, 11, 0.12);
  border-color: rgba(245, 158, 11, 0.26);
  color: #fbbf24;
}

.activity-history-task-columns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.activity-history-task-section {
  display: grid;
  gap: 8px;
}

.activity-history-pagination {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.activity-action-button,
.activity-pagination-button {
  padding: 8px 12px;
  border-radius: 10px;
  border-color: var(--activity-border);
  background: var(--activity-surface-soft);
  font-size: 0.78rem;
  font-weight: 600;
}

.activity-action-button:disabled,
.activity-pagination-button:disabled {
  opacity: 0.5;
  cursor: default;
}

@media (max-width: 960px) {
  .activity-layout {
    grid-template-columns: 1fr;
  }

  .activity-history-task-columns {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .activity-panel {
    padding: 14px 14px 20px;
  }

  .activity-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    margin-bottom: var(--space-md, 16px);
  }

  .activity-toolbar-row,
  .activity-history-toolbar,
  .activity-roster-header,
  .activity-group-header,
  .activity-group-header-actions,
  .activity-history-card-header,
  .activity-history-meta,
  .activity-detail-header,
  .activity-detail-section-header,
  .activity-message-meta,
  .activity-reasoning-header,
  .activity-reasoning-meta {
    flex-direction: column;
    align-items: flex-start;
  }

  .activity-roster-seen {
    margin-left: 0;
  }
}
</style>
