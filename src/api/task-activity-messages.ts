import type { AgentPromptKind } from "../shared/room-agent-prompts.js";
import type { Message, Project, TaskStatus } from "./db.js";
import {
  shouldHardIsolateGitHubEventToFocusRoom,
  shouldPostFocusRoomEventToParent,
  shouldRouteGitHubEventToFocusRoom,
  type FocusGitHubRoutingContext,
  type FocusParentEventKind,
} from "./focus-room-settings.js";
import {
  formatFocusRoomAnchorMessage,
  getFocusRoomSettings,
} from "./room-formatting.js";
import { formatTaskLifecycleStatus } from "./task-lifecycle-status.js";

interface EmitProjectMessageOptions {
  source?: string;
  agent_prompt_kind?: AgentPromptKind | null;
}

export interface TaskActivityMessageDeps {
  getProjectById(projectId: string): Promise<Project | null>;
  getActiveFocusRoomForTask(projectId: string, taskId: string): Promise<Project | null>;
  getFocusRoomsForParent(projectId: string): Promise<Project[]>;
  emitProjectMessage(
    projectId: string,
    sender: string,
    text: string,
    options?: EmitProjectMessageOptions
  ): Promise<Message>;
}

export function createTaskActivityMessageEmitters(deps: TaskActivityMessageDeps) {
  async function getActiveTaskFocusRoom(
    projectId: string,
    taskId: string
  ): Promise<Project | null> {
    const project = await deps.getProjectById(projectId);
    if (!project || project.kind === "focus") {
      return null;
    }

    return (await deps.getActiveFocusRoomForTask(project.id, taskId)) ?? null;
  }

  async function emitTaskAnchoredMessage(
    projectId: string,
    sender: string,
    text: string,
    task: { id: string; title: string },
    options?: {
      source?: string;
      agent_prompt_kind?: AgentPromptKind | null;
      parent_activity?: string;
      parent_event_kind?: FocusParentEventKind;
      event_kind?: "github";
      github_routing_context?: FocusGitHubRoutingContext;
    }
  ): Promise<Message> {
    const focusRoom = await getActiveTaskFocusRoom(projectId, task.id);
    if (!focusRoom) {
      return deps.emitProjectMessage(projectId, sender, text, {
        source: options?.source,
        agent_prompt_kind: options?.agent_prompt_kind ?? null,
      });
    }

    const focusSettings = getFocusRoomSettings(focusRoom);
    const githubRoutingContext = options?.github_routing_context ?? {};
    if (
      options?.event_kind === "github" &&
      !shouldRouteGitHubEventToFocusRoom(focusSettings, githubRoutingContext)
    ) {
      return deps.emitProjectMessage(projectId, sender, text, {
        source: options?.source,
        agent_prompt_kind: options?.agent_prompt_kind ?? null,
      });
    }

    const focusMessage = await deps.emitProjectMessage(focusRoom.id, sender, text, {
      source: options?.source,
      agent_prompt_kind: options?.agent_prompt_kind ?? null,
    });
    const hardIsolatedGitHubEvent =
      options?.event_kind === "github" &&
      shouldHardIsolateGitHubEventToFocusRoom(focusSettings, githubRoutingContext);
    if (
      !hardIsolatedGitHubEvent &&
      shouldPostFocusRoomEventToParent(
        focusSettings,
        options?.parent_event_kind ?? "major_activity"
      )
    ) {
      await deps.emitProjectMessage(
        projectId,
        "letagents",
        formatFocusRoomAnchorMessage({
          task,
          focusRoom,
          activity: options?.parent_activity ?? "Activity",
        })
      );
    }

    return focusMessage;
  }

  async function emitGitHubEventToAllParentRepoFocusRooms(
    projectId: string,
    sender: string,
    text: string,
    options?: {
      excludeRoomIds?: Set<string>;
    }
  ): Promise<void> {
    const focusRooms = await deps.getFocusRoomsForParent(projectId);
    const targetFocusRooms = focusRooms.filter((focusRoom) =>
      focusRoom.focus_status !== "concluded" &&
      !options?.excludeRoomIds?.has(focusRoom.id) &&
      shouldRouteGitHubEventToFocusRoom(getFocusRoomSettings(focusRoom), {
        parent_repo_event: true,
      })
    );

    await Promise.all(
      targetFocusRooms.map((focusRoom) =>
        deps.emitProjectMessage(focusRoom.id, sender, text, { source: "github" })
      )
    );
  }

  async function emitTaskLifecycleStatusMessage(
    projectId: string,
    task: {
      id: string;
      title: string;
      status: TaskStatus;
      assignee: string | null;
    },
    options?: {
      agent_prompt_kind?: AgentPromptKind | null;
      event_kind?: "github";
      github_routing_context?: FocusGitHubRoutingContext;
    }
  ): Promise<Message> {
    return emitTaskAnchoredMessage(
      projectId,
      "letagents",
      formatTaskLifecycleStatus(task),
      task,
      {
        agent_prompt_kind: options?.agent_prompt_kind ?? null,
        parent_activity: "Task status",
        parent_event_kind: "major_activity",
        event_kind: options?.event_kind,
        github_routing_context: options?.github_routing_context,
      }
    );
  }

  return {
    getActiveTaskFocusRoom,
    emitTaskAnchoredMessage,
    emitGitHubEventToAllParentRepoFocusRooms,
    emitTaskLifecycleStatusMessage,
  };
}
