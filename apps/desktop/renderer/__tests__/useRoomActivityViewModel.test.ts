import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextTick, reactive } from "vue";

import { activityParticipantToAgentTarget } from "../src/components/desktop/content/room-activity/agentTarget";
import { useRoomActivityViewModel } from "../src/components/desktop/content/room-activity/useRoomActivityViewModel";
import type { RoomActivityViewModelInput } from "../src/components/desktop/content/room-activity/useRoomActivityViewModel";

function createProps(overrides: Partial<RoomActivityViewModelInput> = {}): RoomActivityViewModelInput {
  return {
    recentActivity: [],
    participants: [],
    liveClearedCount: 0,
    presence: [],
    reasoningSessions: [],
    tasks: [],
    messages: [],
    workers: [],
    ...overrides,
  };
}

describe("useRoomActivityViewModel", () => {
  it("groups reachable workers and exposes the selected live participant", async () => {
    const recentIso = new Date(Date.now() - 60_000).toISOString();
    const staleIso = new Date(Date.now() - 60 * 60_000).toISOString();
    const props = reactive(createProps({
      participants: [
        {
          participantKey: "agent:reviewer",
          kind: "agent",
          displayName: "Review Agent",
          actorLabel: "agent:reviewer",
          ownerLabel: "team",
          ideLabel: "Codex",
          githubLogin: null,
          agentKey: null,
          sourceFlags: ["presence"],
          activityState: "active",
          hiddenAt: null,
          lastRoomActivityAt: "2026-05-28T03:00:00.000Z",
          lastLiveHeartbeatAt: "2026-05-28T03:04:00.000Z",
          lastSeenAt: "2026-05-28T03:04:00.000Z",
        },
      ],
      presence: [
        {
          agentSessionId: "session-1",
          actorLabel: "agent:reviewer",
          displayName: "Review Agent",
          ownerLabel: "team",
          ideLabel: "Codex",
          repoBranch: "feature/review",
          runtime: "codex",
          sessionKind: "worker",
          sourceFlags: ["delivery"],
          freshness: "active",
          activityState: "active",
          status: "working",
          statusText: "reviewing the branch",
          lastHeartbeatAt: "2026-05-28T03:05:00.000Z",
          roomId: "room-1",
          livenessObservation: null,
        },
        {
          agentSessionId: "session-2",
          actorLabel: "agent:builder",
          displayName: "Build Agent",
          ownerLabel: "team",
          ideLabel: "Codex",
          repoBranch: null,
          runtime: "codex",
          sessionKind: "worker",
          sourceFlags: ["presence"],
          freshness: "stale",
          activityState: "offline",
          status: "working",
          statusText: "running the smoke tests",
          lastHeartbeatAt: recentIso,
          roomId: "room-1",
          livenessObservation: null,
        },
        {
          agentSessionId: "session-3",
          actorLabel: "agent:stale",
          displayName: "Stale Agent",
          ownerLabel: "team",
          ideLabel: "Codex",
          repoBranch: null,
          runtime: "codex",
          sessionKind: "worker",
          sourceFlags: ["presence"],
          freshness: "stale",
          activityState: "offline",
          status: "working",
          statusText: "old status",
          lastHeartbeatAt: staleIso,
          roomId: "room-1",
          livenessObservation: null,
        },
      ],
      messages: [
        {
          id: "msg-1",
          text: "[status] reviewing the branch",
          sender: "agent:reviewer",
          actorLabel: "agent:reviewer",
          timestamp: "2026-05-28T03:05:00.000Z",
          source: "mcp",
          agentIdentity: {
            name: null,
            displayName: null,
            ownerLabel: null,
            ownerAttribution: null,
            ideLabel: null,
            actorLabel: "agent:reviewer",
            agentKey: null,
            agentSessionId: null,
          },
        },
      ],
      tasks: [
        {
          id: "task-1",
          title: "Review branch",
          description: null,
          status: "in_progress",
          assignee: "agent:reviewer",
          assigneeAgentKey: null,
          createdBy: null,
          prUrl: null,
          workflowArtifacts: [],
          workflowRefs: [],
          activeLeases: [],
          activeLocks: [],
          stalePromptState: null,
          createdAt: null,
          updatedAt: "2026-05-28T03:05:00.000Z",
        },
        {
          id: "task-2",
          title: "Run smoke tests",
          description: null,
          status: "in_progress",
          assignee: "agent:builder",
          assigneeAgentKey: null,
          createdBy: null,
          prUrl: null,
          workflowArtifacts: [],
          workflowRefs: [],
          activeLeases: [],
          activeLocks: [],
          stalePromptState: null,
          createdAt: null,
          updatedAt: recentIso,
        },
        {
          id: "task-3",
          title: "Old task",
          description: null,
          status: "in_progress",
          assignee: "agent:stale",
          assigneeAgentKey: null,
          createdBy: null,
          prUrl: null,
          workflowArtifacts: [],
          workflowRefs: [],
          activeLeases: [],
          activeLocks: [],
          stalePromptState: null,
          createdAt: null,
          updatedAt: staleIso,
        },
      ],
    } as Partial<RoomActivityViewModelInput>));

    const model = useRoomActivityViewModel(props);
    await nextTick();

    assert.equal(model.reachableAgents.value.length, 1);
    assert.equal(model.workingAgents.value.length, 1);
    assert.equal(model.liveRosterAgents.value.length, 2);
    assert.equal(model.selectedLiveParticipant.value?.label, "Review Agent");
    assert.equal(model.connectionLabel(model.selectedLiveParticipant.value!), "connected");
    assert.equal(model.workingAgents.value[0]?.label, "Build Agent");
    assert.equal(model.liveRosterAgents.value.some((agent) => agent.label === "Stale Agent"), false);
  });

  it("maps a live activity participant to the shared agent detail modal target", async () => {
    const props = reactive(createProps({
      presence: [
        {
          agentSessionId: "session-1",
          agentKey: "codex/maple-ridge",
          actorLabel: "MapleRidge",
          displayName: "MapleRidge",
          ownerLabel: "Local desktop",
          ideLabel: "Codex",
          repoBranch: "codex/git-rooms",
          runtime: "codex",
          sessionKind: "worker",
          sourceFlags: ["delivery"],
          freshness: "active",
          activityState: "active",
          status: "working",
          statusText: "editing",
          lastHeartbeatAt: "2026-05-28T03:05:00.000Z",
          roomId: "room-1",
          livenessObservation: null,
        },
      ],
    } as Partial<RoomActivityViewModelInput>));

    const model = useRoomActivityViewModel(props);
    await nextTick();

    assert.deepEqual(
      activityParticipantToAgentTarget(model.selectedLiveParticipant.value!),
      {
        messageId: null,
        actorLabel: "MapleRidge",
        displayName: "MapleRidge",
        ownerAttribution: "Local desktop's agent",
        ideLabel: "Codex",
        sender: "MapleRidge",
        agentKey: "codex/maple-ridge",
        agentSessionId: "session-1",
      },
    );
  });

  it("keeps selected live and history rows pointed at visible entries", async () => {
    const props = reactive(createProps({
      recentActivity: [
        {
          id: "history-1",
          participantKind: "agent",
          participantDisplayName: "History Agent",
          participantActorLabel: "agent:history",
          repoBranch: "codex/history",
          activityState: "offline",
          firstSeenAt: "2026-05-28T02:00:00.000Z",
          lastRoomActivityAt: "2026-05-28T03:00:00.000Z",
          messageCount: 2,
          reasoningSessionCount: 0,
          currentTasks: [],
          completedTasks: [],
          createdTasks: [],
          room: { id: "room-1", displayName: "Main room" },
        },
      ],
      presence: [
        {
          roomId: "room-1",
          actorLabel: "agent:history",
          agentKey: null,
          agentInstanceId: null,
          agentSessionId: "session-history",
          sessionKind: "worker",
          runtime: "codex",
          displayName: "History Agent",
          ownerLabel: null,
          ideLabel: null,
          repoBranch: null,
          status: "idle",
          statusText: null,
          lastHeartbeatAt: "2026-05-28T03:05:00.000Z",
          freshness: "active",
          activityState: "active",
          sourceFlags: ["delivery"],
          livenessObservation: null,
        },
      ],
    } as Partial<RoomActivityViewModelInput>));

    const model = useRoomActivityViewModel(props);
    await nextTick();

    assert.equal(model.selectedLiveKey.value, "agent:session-history");
    assert.equal(model.selectedHistoryKey.value, "history-1");
    assert.equal(model.selectedHistoryEntry.value?.participantDisplayName, "History Agent");

    props.presence = [];
    props.recentActivity = [];
    await nextTick();

    assert.equal(model.selectedLiveKey.value, null);
    assert.equal(model.selectedHistoryKey.value, null);
    assert.equal(model.selectedHistoryEntry.value, null);
  });
});
