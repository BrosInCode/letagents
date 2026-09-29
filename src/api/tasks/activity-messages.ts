import type { AgentPromptKind } from "../../shared/room-agent-prompts.js";
import type { Message, Project, TaskStatus } from "../db.js";
import {
  shouldHardIsolateGitHubEventToFocusRoom,
  shouldPostFocusRoomEventToParent,
  shouldRouteGitHubEventToFocusRoom,
  type FocusGitHubRoutingContext,
  type FocusParentEventKind,
} from "../focus-rooms/settings.js";
import {
  formatFocusRoomAnchorMessage,
  getFocusRoomSettings,
} from "../rooms/formatting.js";
import { formatTaskLifecycleStatus } from "./lifecycle-status.js";

interface EmitProjectMessageOptions {
  source?: string;
  agent_prompt_kind?: AgentPromptKind | null;
  client_message_id?: string | null;
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

  interface TaskAnchoredMessageOptions {
    source?: string;
    agent_prompt_kind?: AgentPromptKind | null;
    parent_activity?: string;
    parent_event_kind?: FocusParentEventKind;
    event_kind?: "github";
    github_routing_context?: FocusGitHubRoutingContext;
    client_message_id?: string | null;
    parent_client_message_id?: string | null;
  }
  type RoomDeliveryCheck = (room: Pick<Project, "id" | "parent_room_id">) => Promise<boolean>;

  function emitTaskAnchoredMessage(
    projectId: string,
    sender: string,
    text: string,
    task: { id: string; title: string },
    options?: TaskAnchoredMessageOptions
  ): Promise<Message>;
  /**
   * With `shouldDeliverToRoom`, the message is posted only where the room
   * takes it, and null is returned when it is posted nowhere. The check is
   * made against the room the message lands in, which for a task with an
   * active focus room is the focus room and not the task's own room.
   */
  function emitTaskAnchoredMessage(
    projectId: string,
    sender: string,
    text: string,
    task: { id: string; title: string },
    options: TaskAnchoredMessageOptions & { shouldDeliverToRoom: RoomDeliveryCheck }
  ): Promise<Message | null>;
  async function emitTaskAnchoredMessage(
    projectId: string,
    sender: string,
    text: string,
    task: { id: string; title: string },
    options?: TaskAnchoredMessageOptions & { shouldDeliverToRoom?: RoomDeliveryCheck }
  ): Promise<Message | null> {
    const shouldDeliverToRoom = options?.shouldDeliverToRoom;
    const project = await deps.getProjectById(projectId);
    const taskRoom = project ?? { id: projectId, parent_room_id: null };
    const focusRoom = project && project.kind !== "focus"
      ? (await deps.getActiveFocusRoomForTask(project.id, task.id)) ?? null
      : null;

    const focusSettings = focusRoom ? getFocusRoomSettings(focusRoom) : null;
    const githubRoutingContext = options?.github_routing_context ?? {};
    if (
      !focusRoom ||
      !focusSettings ||
      (options?.event_kind === "github" &&
        !shouldRouteGitHubEventToFocusRoom(focusSettings, githubRoutingContext))
    ) {
      if (shouldDeliverToRoom && !await shouldDeliverToRoom(taskRoom)) return null;
      return deps.emitProjectMessage(projectId, sender, text, {
        source: options?.source,
        agent_prompt_kind: options?.agent_prompt_kind ?? null,
        client_message_id: options?.client_message_id ?? null,
      });
    }

    // Nothing is posted in the focus room, so there is no activity there for
    // the parent room to be pointed at.
    if (shouldDeliverToRoom && !await shouldDeliverToRoom(focusRoom)) return null;

    const focusMessage = await deps.emitProjectMessage(focusRoom.id, sender, text, {
      source: options?.source,
      agent_prompt_kind: options?.agent_prompt_kind ?? null,
      client_message_id: options?.client_message_id ?? null,
    });
    const hardIsolatedGitHubEvent =
      options?.event_kind === "github" &&
      shouldHardIsolateGitHubEventToFocusRoom(focusSettings, githubRoutingContext);
    if (
      !hardIsolatedGitHubEvent &&
      shouldPostFocusRoomEventToParent(
        focusSettings,
        options?.parent_event_kind ?? "major_activity"
      ) &&
      (!shouldDeliverToRoom || await shouldDeliverToRoom(taskRoom))
    ) {
      await deps.emitProjectMessage(
        projectId,
        "letagents",
        formatFocusRoomAnchorMessage({
          task,
          focusRoom,
          activity: options?.parent_activity ?? "Activity",
        }),
        {
          client_message_id: options?.parent_client_message_id ?? null,
        }
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
      client_message_id_base?: string | null;
      /** Room admins can turn kinds of GitHub events off for a room. */
      filterRooms?: (rooms: Project[]) => Promise<Project[]>;
    }
  ): Promise<void> {
    const focusRooms = await deps.getFocusRoomsForParent(projectId);
    const routedFocusRooms = focusRooms.filter((focusRoom) =>
      focusRoom.focus_status !== "concluded" &&
      !options?.excludeRoomIds?.has(focusRoom.id) &&
      shouldRouteGitHubEventToFocusRoom(getFocusRoomSettings(focusRoom), {
        parent_repo_event: true,
      })
    );
    const targetFocusRooms = options?.filterRooms
      ? await options.filterRooms(routedFocusRooms)
      : routedFocusRooms;

    await Promise.all(
      targetFocusRooms.map((focusRoom) =>
        deps.emitProjectMessage(focusRoom.id, sender, text, {
          source: "github",
          client_message_id: options?.client_message_id_base
            ? `${options.client_message_id_base}:focus-broadcast`
            : null,
        })
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
      client_message_id?: string | null;
      parent_client_message_id?: string | null;
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
        client_message_id: options?.client_message_id ?? null,
        parent_client_message_id: options?.parent_client_message_id ?? null,
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
