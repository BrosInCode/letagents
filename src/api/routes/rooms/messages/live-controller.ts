import type { Project } from "../../../db.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import type { ResolvedRequestAgentIdentity } from "../../../request/agent-identity.js";
import { beginRoomAgentDelivery } from "../../../rooms/agent-delivery.js";
import { acquireLiveRoomAuthorization } from "../../../rooms/live-authorization.js";
import {
  reauthorizeGitRoomParticipant,
} from "../../../rooms/access.js";
import {
  MESSAGE_CREATED_EVENT_KINDS,
  type RoomEventBroker,
  type RoomEventSubscription,
} from "../../../server/room-event-broker.js";
import { isRoomEventVisibleToSubscriber } from "./delivery-visibility.js";
import type { RoomMessageOverlayTarget } from "../../../server/room-message-overlays.js";
import { isRoomAgentDeliveryCredentialExpired } from "../../../../shared/agent-presence.js";

export interface LiveRoomDeliveryController {
  activationIdentity: ResolvedRequestAgentIdentity | null;
  activate(): void;
  check(options?: { force?: boolean }): Promise<boolean>;
  close(): Promise<void>;
}

/** Shared authorization/delivery lease for modern and legacy SSE/poll routes. */
export async function openLiveRoomDeliveryController(input: {
  req: AuthenticatedRequest;
  project: Project;
  accessRoomName: string;
  transport: "sse" | "long_poll";
  trackDelivery: boolean;
  onSessionDisconnected: () => void;
  onAuthorizationDenied: () => void;
  reauthorize?: (req: AuthenticatedRequest, project: Project) => Promise<boolean>;
  beginDelivery?: typeof beginRoomAgentDelivery;
  onEndError?: (error: unknown) => void;
}): Promise<LiveRoomDeliveryController> {
  let closed = false;
  let sessionDisconnected = false;
  let activated = false;
  let pendingSessionDisconnect = false;
  let pendingAuthorizationDenial = false;
  let closing: Promise<void> | null = null;
  const notifyRoute = (kind: "session" | "authorization", callback: () => void) => {
    if (closed) return;
    if (!activated) {
      if (kind === "session") pendingSessionDisconnect = true;
      else pendingAuthorizationDenial = true;
      return;
    }
    callback();
  };
  const delivery = input.trackDelivery
    ? await (input.beginDelivery ?? beginRoomAgentDelivery)({
        req: input.req,
        roomId: input.project.id,
        transport: input.transport,
        onSessionDisconnected: () => {
          sessionDisconnected = true;
          notifyRoute("session", input.onSessionDisconnected);
        },
      })
    : null;
  const activationIdentity = delivery?.identity.session_kind === "worker"
    ? delivery.identity
    : null;
  const authorization = acquireLiveRoomAuthorization({
    req: input.req,
    roomId: input.project.id,
    accessRoomName: input.accessRoomName,
    deliveryCredentialFence: activationIdentity?.credential_fence,
    authorize: async () => {
      // A bridge-loss marker may stand in for a dropped exact credential
      // retirement. Validate the durable delivery fence before any later body;
      // owner/repository authorization alone cannot prove that an X-Agent-
      // Session credential is still current.
      if (delivery?.checkCredential && !(await delivery.checkCredential())) return false;
      return (input.reauthorize ?? reauthorizeGitRoomParticipant)(
        input.req,
        input.project,
      );
    },
    initiallyAllowed: true,
  });
  const stopInvalidation = authorization.onInvalidated(() => {
    void authorization.check({ force: true }).then((allowed) => {
      // Exact credential retirement also tears down the shared delivery lease.
      // Let that terminal callback own the response so a long poll closes
      // cleanly without racing the authorization listener into a 403.
      if (!allowed && !sessionDisconnected) {
        notifyRoute("authorization", input.onAuthorizationDenied);
      }
    });
  });

  return {
    activationIdentity,
    activate() {
      if (closed || activated) return;
      activated = true;
      if (pendingSessionDisconnect) input.onSessionDisconnected();
      else if (pendingAuthorizationDenial) input.onAuthorizationDenied();
      pendingSessionDisconnect = false;
      pendingAuthorizationDenial = false;
    },
    check: async (options) => {
      if (closed) return false;
      // Repository authorization is cached, but bearer expiry is an exact
      // serialization fence and is cheap to evaluate before every body.
      if (isRoomAgentDeliveryCredentialExpired(activationIdentity?.credential_fence)) {
        await delivery?.checkCredential();
        return false;
      }
      return authorization.check(options);
    },
    close() {
      if (closing) return closing;
      closed = true;
      stopInvalidation();
      authorization.release();
      closing = (async () => {
        try {
          await delivery?.end();
        } catch (error) {
          input.onEndError?.(error);
        }
      })();
      return closing;
    },
  };
}

/** One shared visibility boundary for live delivery and replay. */
export function subscribeVisibleRoomEvents(input: {
  broker: RoomEventBroker;
  roomId: string;
  includePromptOnly: boolean;
  activationIdentity: ResolvedRequestAgentIdentity | null;
  eventCursor?: string | null;
  messageOnly?: boolean;
  messageOverlayTarget?: RoomMessageOverlayTarget;
}): RoomEventSubscription {
  return input.broker.subscribe(input.roomId, {
    afterCursor: input.eventCursor,
    ...(input.messageOnly ? { kinds: MESSAGE_CREATED_EVENT_KINDS } : {}),
    messageOverlayTarget: input.messageOverlayTarget,
    accept: (event) => isRoomEventVisibleToSubscriber({
      event,
      includePromptOnly: input.includePromptOnly,
      recipientAgentIdentity: input.activationIdentity,
      messageOnly: input.messageOnly,
    }),
  });
}

export function roomSyncSseFrame(payload: Record<string, unknown>): string {
  return `event: room_sync\ndata: ${JSON.stringify(payload)}\n\n`;
}
