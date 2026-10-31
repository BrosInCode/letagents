import type { LetAgentsExecutionProfile } from "./execution-profile.js";

export interface ExecutionProfileToolSurface {
  agentSessionLifecycle: boolean;
  deliveryLoop: boolean;
  /**
   * send_message and send_thread_message take workspace file paths. Daemon-
   * supervised agents attach through set_reply_attachments instead, because
   * their sends go through the daemon's effect journal.
   */
  messageFileAttachments: boolean;
  onboarding: boolean;
  rental: boolean;
  roomResume: boolean;
}

const TOOL_SURFACE_BY_PROFILE: Readonly<
  Record<LetAgentsExecutionProfile, Readonly<ExecutionProfileToolSurface>>
> = {
  supervised_mcp_polling: {
    agentSessionLifecycle: false,
    deliveryLoop: true,
    messageFileAttachments: false,
    onboarding: false,
    rental: false,
    roomResume: false,
  },
  supervised_room_turn: {
    agentSessionLifecycle: false,
    deliveryLoop: false,
    messageFileAttachments: false,
    onboarding: false,
    rental: false,
    roomResume: false,
  },
  autonomous_mcp_worker: {
    agentSessionLifecycle: true,
    deliveryLoop: true,
    messageFileAttachments: true,
    onboarding: true,
    rental: true,
    roomResume: true,
  },
  interactive_desktop: {
    agentSessionLifecycle: true,
    deliveryLoop: true,
    messageFileAttachments: true,
    onboarding: true,
    rental: true,
    roomResume: true,
  },
};

export function toolSurfaceForExecutionProfile(
  profile: LetAgentsExecutionProfile,
): Readonly<ExecutionProfileToolSurface> {
  return TOOL_SURFACE_BY_PROFILE[profile];
}
