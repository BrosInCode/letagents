import type {
  DesktopActivityEntry,
  DesktopAgentPresence,
  DesktopBoardSettingsSummary,
  DesktopFocusRoomInfo,
  DesktopGitHubEventsPage,
  DesktopParticipantSummary,
  DesktopReasoningSession,
  DesktopRoomAgentWork,
  DesktopRoomInfo,
  DesktopRoomMessage,
  DesktopRoomSharedArtifact,
  DesktopRoomSnapshot,
  DesktopRoomStorageState,
  DesktopSnapshotSourceStates,
  DesktopTaskSummary,
  RepoStatus,
  WorkerSnapshot,
} from "../../../../electron/ipc-types";
import type { DefineProps, EmitFn, ShortEmitsToObject } from "vue";
import type { ChatScrollPosition } from "../../domain/chat-scroll";
import type { FocusRoomConcludedEvent } from "../../domain/focus-room-conclusion";
import type { SidebarMode } from "../../components/desktop/types";
import type { AttentionNavigationIntent } from "../../components/desktop/content/room-shell/types";

/** DesktopRoomShell.vue's props, as passed to defineProps. */
export interface DesktopRoomShellProps {
  viewerLogin?: string | null;
  sidebarMode: SidebarMode;
  roomLoading: boolean;
  room: DesktopRoomInfo;
  storage: DesktopRoomStorageState;
  focusRooms: DesktopFocusRoomInfo[];
  tasks: DesktopTaskSummary[];
  participants: DesktopParticipantSummary[];
  participantHiddenCount: number;
  presence: DesktopAgentPresence[];
  reasoningSessions: DesktopReasoningSession[];
  /** Agents' turns their owners share with the room. Absent: none. */
  liveActivitySessions?: DesktopReasoningSession[];
  recentActivity: DesktopActivityEntry[];
  roomArtifacts: DesktopRoomSharedArtifact[];
  roomAgentWork: DesktopRoomAgentWork[];
  roomAgentWorkStatus: "idle" | "loading" | "ready" | "stale" | "error" | "unavailable";
  roomAgentWorkTruncated: boolean;
  boardSettings: DesktopBoardSettingsSummary | null;
  messages: DesktopRoomMessage[];
  githubEvents: DesktopGitHubEventsPage | null;
  sourceStates?: DesktopSnapshotSourceStates | null;
  repoStatus: RepoStatus;
  gitRoomMatchesActiveRepo: boolean;
  durableProjectRootPath?: string | null;
  projectRoom?: boolean;
  workers: WorkerSnapshot[];
  openAddAgentRequested?: boolean;
  notificationRevealMessageId?: string | null;
  notificationRevealNonce?: number;
  attentionIntent?: AttentionNavigationIntent | null;
  attention?: { count: number; pulse: boolean };
  initialChatScrollPosition?: ChatScrollPosition | null;
  onFocusRoomConcluded?: (event: FocusRoomConcludedEvent) => Promise<void>;
}

/** DesktopRoomShell.vue's events, as passed to defineEmits. */
export type DesktopRoomShellEmits = {
  "attention-opened": [];
  "open-ask-agent": [];
  "cycle-sidebar": [];
  "message-sent": [message: DesktopRoomMessage];
  "room-renamed": [room: DesktopRoomInfo];
  "task-updated": [task: DesktopTaskSummary];
  "refresh-room": [snapshot?: DesktopRoomSnapshot];
  "open-focus-room": [roomIdentifier: string];
  "request-focus-room-conclusion": [focusRoom: DesktopFocusRoomInfo];
  "chat-scroll-position": [roomIdentifier: string, scrollTop: ChatScrollPosition];
  "connect-project": [];
  "choose-worktree": [rootPath: string];
  "open-repo-root": [rootPath: string];
  "add-agent-open-request-consumed": [];
  /** Placeholder until the daemon exposes a receipt retry control endpoint. */
  "retry-room-agent-delivery": [input: { agentId: string; sourceMessageId: string }];
  "message-reveal-unavailable": [messageId: string, reason?: "not_found" | "too_far_back" | "unavailable"];
  "open-inbox": []; "open-messages-with": [target: { login: string; displayName: string; avatarUrl: string | null }];
};

type BooleanPropKeys<T, K extends keyof T = keyof T> = K extends unknown
  ? T[K] extends boolean | undefined ? T[K] extends undefined ? never : K : never
  : never;

/** The `props` object defineProps returns: optional booleans default to false. */
export type DesktopRoomShellPropsValue = DefineProps<
  { [K in keyof Required<DesktopRoomShellProps>]: DesktopRoomShellProps[K] },
  BooleanPropKeys<DesktopRoomShellProps>
>;

/** The `emit` function defineEmits returns. */
export type DesktopRoomShellEmit = EmitFn<ShortEmitsToObject<DesktopRoomShellEmits>>;
