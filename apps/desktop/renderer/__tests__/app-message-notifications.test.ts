import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { effectScope, nextTick, ref } from "vue";
import type {
  DesktopAccountActivityState,
  DesktopAccountRoomEntry,
  DesktopNotificationStatus,
  DesktopNotificationTarget,
  DesktopRoomMessage,
} from "../../electron/ipc-types";
import type { RoomMentionEvent } from "../../../../shared/room-mention-events.mjs";

const deferred = <T = unknown>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
  }
};

const storage = new Map<string, string>();
const createdNotifications: Array<{
  title: string;
  options: Record<string, unknown>;
  onclick: (() => void) | null;
}> = [];
const activatedViaIpc: DesktopNotificationTarget[] = [];
const statusListeners = new Set<(status: DesktopNotificationStatus) => void>();

let notificationPermission: NotificationPermission = "granted";
let notificationStatus: DesktopNotificationStatus = {
  enabled: true,
  nativeSupported: false,
  nativeRegistered: false,
  lastError: null,
};
let documentHasFocus = false;
let documentVisibilityState = "visible";
let soundCount = 0;
let ipcActivateResult = true;
let restartActivityCalls = 0;
let stopActivityCalls = 0;

let getPreferenceHandler: (roomId: string) => Promise<{
  room_id: string;
  level: "all" | "mentions" | "muted";
  snoozed_until: string | null;
}> = async (roomId) => ({ room_id: roomId, level: "all", snoozed_until: null });

let getMessageHandler: (roomId: string, messageId: string) => Promise<DesktopRoomMessage | null> = async () => null;
let getMessagesAfterHandler:
  | ((roomId: string, afterId: string | null) => Promise<{ messages: DesktopRoomMessage[] }>)
  | null = null;

function emitStatusChanged(next: DesktopNotificationStatus): void {
  notificationStatus = next;
  for (const listener of statusListeners) listener(next);
}

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  sampleRate = 44100;
  destination = {};
  createOscillator() {
    return {
      type: "sine",
      detune: { value: 0 },
      frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect(node: unknown) {
        return node;
      },
      disconnect() {},
      start() {
        soundCount += 1;
      },
      stop() {},
    };
  }
  createGain() {
    return {
      gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect(node: unknown) {
        return node;
      },
      disconnect() {},
    };
  }
  createDelay() {
    return {
      delayTime: { value: 0 },
      connect(node: unknown) {
        return node;
      },
      disconnect() {},
    };
  }
  createBiquadFilter() {
    return {
      type: "lowpass",
      frequency: { value: 0 },
      Q: { value: 1 },
      connect(node: unknown) {
        return node;
      },
      disconnect() {},
    };
  }
  createBuffer(_channels: number, length: number) {
    return { getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    return {
      buffer: null,
      connect(node: unknown) {
        return node;
      },
      disconnect() {},
      start() {
        soundCount += 1;
      },
      stop() {},
    };
  }
  async resume() {}
  async close() {}
}

Object.assign(globalThis, {
  AudioContext: FakeAudioContext,
  document: {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    hidden: false,
    get visibilityState() {
      return documentVisibilityState;
    },
    hasFocus: () => documentHasFocus,
  },
  window: {
    AudioContext: FakeAudioContext,
    focus() {},
    matchMedia: () => ({ matches: false }),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    letagentsDesktop: {
      notifications: {
        getStatus: async () => notificationStatus,
        setEnabled: async (enabled: boolean) => {
          const next = { ...notificationStatus, enabled };
          emitStatusChanged(next);
          return next;
        },
        activate: async (target: DesktopNotificationTarget) => {
          activatedViaIpc.push(target);
          return ipcActivateResult;
        },
        onStatusChanged: (listener: (status: DesktopNotificationStatus) => void) => {
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
      },
      room: {
        getNotificationPreference: (roomId: string) => getPreferenceHandler(roomId),
        listNotificationPreferences: async () => ({ preferences: [], truncated: false }),
        putNotificationPreference: async (roomId: string, input: { level?: "all" | "mentions" | "muted"; snoozed_until?: string | null }) => ({
          room_id: roomId,
          level: input.level ?? "all",
          snoozed_until: input.snoozed_until ?? null,
        }),
        getMessage: (roomId: string, messageId: string) => getMessageHandler(roomId, messageId),
        getMessagesAfter: (roomId: string, afterId: string | null) =>
          getMessagesAfterHandler ? getMessagesAfterHandler(roomId, afterId) : Promise.resolve({ messages: [] }),
        onAccountActivity: () => () => undefined,
        getAccountActivity: async () => ({ connected: false, rooms: {} }),
        restartAccountActivity: async () => {
          restartActivityCalls += 1;
        },
        stopAccountActivity: async () => {
          stopActivityCalls += 1;
        },
      },
    },
  },
  Notification: class {
    static get permission() {
      return notificationPermission;
    }
    onclick: (() => void) | null = null;
    constructor(
      public title: string,
      public options: Record<string, unknown>,
    ) {
      createdNotifications.push(this);
    }
  },
});

const { useAppMessageNotifications } = await import("../src/composables/app/useAppMessageNotifications");
const { useDesktopRoomPreferences } = await import(
  "../src/components/desktop/content/room-shell/useDesktopRoomPreferences"
);
const { useAccountActivity } = await import("../src/composables/useAccountActivity");
const { roomNotificationPreferences } = await import("../src/composables/useRoomNotificationPreferences");
const { roomMessageAlertGate } = await import("../src/domain/room-message-alert-gate");
const { playRoomInteractionSound } = await import("../src/components/desktop/content/room-shell/roomSounds");
const { resetNotificationSoundCooldownForTests } = await import(
  "../src/components/desktop/content/room-shell/roomSounds"
).catch(() => ({ resetNotificationSoundCooldownForTests: null as null | (() => void) }));

function makeMessage(id: string, text: string, overrides: Partial<DesktopRoomMessage> = {}): DesktopRoomMessage {
  return {
    id,
    sender: "Teammate",
    text,
    attachments: [],
    agentPromptKind: null,
    source: "browser",
    timestamp: "2026-11-11T00:00:00.000Z",
    actorLabel: null,
    agentIdentity: null,
    senderProfile: { login: "teammate", avatarUrl: null },
    threadRootId: id,
    threadReplyToId: null,
    thread: null,
    replyTo: null,
    ...overrides,
  };
}

beforeEach(() => {
  createdNotifications.length = 0;
  activatedViaIpc.length = 0;
  soundCount = 0;
  ipcActivateResult = true;
  restartActivityCalls = 0;
  stopActivityCalls = 0;
  notificationPermission = "granted";
  notificationStatus = {
    enabled: true,
    nativeSupported: false,
    nativeRegistered: false,
    lastError: null,
  };
  documentHasFocus = false;
  documentVisibilityState = "visible";
  storage.clear();
  storage.set("letagents-desktop:sound", "on");
  storage.set("letagents-desktop:notifications", "on");
  getPreferenceHandler = async (roomId) => ({ room_id: roomId, level: "all", snoozed_until: null });
  getMessageHandler = async () => null;
  getMessagesAfterHandler = null;
  roomMessageAlertGate.reset();
  roomNotificationPreferences.setViewer(null);
  resetNotificationSoundCooldownForTests?.();
});

test("Checkpoint #1: concurrent delivery across open room watcher, activity feed, and room_mention alerts exactly once across both arrival orders", async () => {
  // Measure the exact oscillator count of a single notification chime.
  const chimeProbeStart = soundCount;
  playRoomInteractionSound("notification");
  const singleChimeOscillators = soundCount - chimeProbeStart;
  assert.equal(singleChimeOscillators > 0, true);

  for (const order of ["active-first", "background-first"] as const) {
    createdNotifications.length = 0;
    roomMessageAlertGate.reset();
    roomNotificationPreferences.setViewer({ id: "acct_emmy", login: "emmymay" });
    await roomNotificationPreferences.refresh("github.com/org/repo");

    const msg42 = makeMessage("msg_42", "@emmymay ship check", {
      sender: "Ada",
      senderProfile: { login: "ada", avatarUrl: null },
    });
    getMessageHandler = async (_roomId, messageId) => (messageId === "msg_42" ? msg42 : null);
    getMessagesAfterHandler = async () => ({ messages: [msg42] });

    const authStatus = ref({ authenticated: true, account: { id: "acct_emmy", login: "emmymay" } });
    const accountActivityState = ref<DesktopAccountActivityState>({
      connected: true,
      rooms: {
        "github.com/org/repo": {
          roomId: "github.com/org/repo",
          latestMessageId: "msg_41",
          latestMessageAt: "2026-11-11T00:00:00.000Z",
          working: [],
        },
      },
    });
    const accountRooms = ref<DesktopAccountRoomEntry[]>([
      {
        roomIdentifier: "github.com/org/repo",
        displayName: "org/repo",
        name: "org/repo",
        kind: "main",
        parentRoomId: null,
        focusKey: null,
        sourceTaskId: null,
        focusStatus: null,
        role: "admin",
        source: null,
        pinned: false,
        archived: false,
        canLeave: false,
        canDelete: false,
        deleteReason: null,
        firstOpenedAt: null,
        lastOpenedAt: null,
        latestMessageId: "msg_41",
        latestMessageAt: null,
        gitRoom: null,
        focusRooms: [],
      },
    ]);

    // Seed [] -> history -> flush -> incoming so the non-immediate active-room watcher participates.
    const visibleMessages = ref<DesktopRoomMessage[]>([]);
    const scope = effectScope();
    const appNotifications = scope.run(() => {
      const shellPrefs = useDesktopRoomPreferences(() => "github.com/org/repo");
      shellPrefs.watchRoomNotifications({
        visibleMessages,
        ownMessageIds: new Set(),
        playRoomSound: shellPrefs.playRoomSound,
        showRoomNotification: (m) => shellPrefs.showRoomNotification(m, "org/repo"),
      });
      return useAppMessageNotifications({
        accountActivity: { state: accountActivityState },
        accountRooms,
        activeEntry: ref({ type: "room" }),
        authStatus,
        selectedRoomInfo: ref({ identifier: "github.com/org/repo", displayName: "org/repo", name: "org/repo" }),
        handleNotificationActivation: async () => undefined,
        refreshSidebarRoomMetadata: async () => undefined,
        roomHistoryMode: () => "cloud",
      });
    })!;

    try {
      visibleMessages.value = [makeMessage("msg_41", "earlier")];
      await flush();
      assert.equal(createdNotifications.length, 0, `${order}: baseline history produces zero alerts`);
      const soundBaseline = soundCount;
      const mentionEvent: RoomMentionEvent = {
        room_id: "github.com/org/repo",
        room_display_name: "org/repo",
        message_id: "msg_42",
        thread_root_id: null,
      };

      if (order === "active-first") {
        visibleMessages.value = [...visibleMessages.value, msg42];
        await flush();
        accountActivityState.value = {
          connected: true,
          rooms: {
            "github.com/org/repo": {
              roomId: "github.com/org/repo",
              latestMessageId: "msg_42",
              latestMessageAt: "2026-11-11T00:01:00.000Z",
              working: [],
            },
          },
        };
        await appNotifications.receiveRoomMention(mentionEvent);
        await flush();
      } else {
        accountActivityState.value = {
          connected: true,
          rooms: {
            "github.com/org/repo": {
              roomId: "github.com/org/repo",
              latestMessageId: "msg_42",
              latestMessageAt: "2026-11-11T00:01:00.000Z",
              working: [],
            },
          },
        };
        await appNotifications.receiveRoomMention(mentionEvent);
        await flush();
        visibleMessages.value = [...visibleMessages.value, msg42];
        await flush();
      }

      assert.equal(createdNotifications.length, 1, `${order}: shared alert gate deduplicates all three channels to 1 Notification`);
      assert.equal(createdNotifications[0]!.title, "Ada in org/repo");
      assert.equal(createdNotifications[0]!.options.body, "@emmymay ship check");
      assert.equal(createdNotifications[0]!.options.tag, "room-message:github.com/org/repo:msg_42");
      assert.equal(soundCount - soundBaseline, singleChimeOscillators, `${order}: exact single notification chime played`);

      // Re-delivering the same mention frame again produces zero duplicate notifications or chimes.
      await appNotifications.receiveRoomMention(mentionEvent);
      await flush();
      assert.equal(createdNotifications.length, 1);
      assert.equal(soundCount - soundBaseline, singleChimeOscillators);
    } finally {
      scope.stop();
    }
  }
});

test("Checkpoint #2: async stale-state guards drop in-flight alerts on account switch, mute/snooze flip, global disable, APNs flip, and room focus", async () => {
  roomNotificationPreferences.setViewer({ id: "acct_a", login: "ada" });
  await roomNotificationPreferences.refresh("room-guard");

  const authStatus = ref({ authenticated: true, account: { id: "acct_a", login: "ada" } });
  const activeEntry = ref<{ type: string }>({ type: "inbox" });
  const selectedRoomInfo = ref<{ identifier: string; displayName: string; name: string } | null>(null);
  const accountActivityState = ref<DesktopAccountActivityState>({ connected: true, rooms: {} });

  const scope = effectScope();
  const api = scope.run(() =>
    useAppMessageNotifications({
      accountActivity: { state: accountActivityState },
      accountRooms: ref([]),
      activeEntry,
      authStatus,
      selectedRoomInfo,
      handleNotificationActivation: async () => undefined,
      refreshSidebarRoomMetadata: async () => undefined,
      roomHistoryMode: () => "cloud",
    }),
  )!;

  try {
    await flush();

    // 1. Account switch while getMessage is in flight -> dropped.
    const msgGate1 = deferred<DesktopRoomMessage | null>();
    getMessageHandler = () => msgGate1.promise;
    const p1 = api.receiveRoomMention({
      room_id: "room-guard",
      room_display_name: "Guard Room",
      message_id: "msg_1",
      thread_root_id: null,
    });
    await flush();
    authStatus.value = { authenticated: true, account: { id: "acct_b", login: "bea" } };
    roomNotificationPreferences.setViewer({ id: "acct_b", login: "bea" });
    msgGate1.resolve(makeMessage("msg_1", "@ada @bea hi"));
    await p1;
    await flush();
    assert.equal(createdNotifications.length, 0, "account switch drops in-flight alert");

    // 2. Room flipped to muted while preference read is in flight -> dropped.
    const prefGate = deferred<{ room_id: string; level: "all" | "mentions" | "muted"; snoozed_until: string | null }>();
    getPreferenceHandler = () => prefGate.promise;
    getMessageHandler = async (_r, id) => makeMessage(id, "@bea urgent");
    const pendingRefresh = roomNotificationPreferences.refresh("room-muted-inflight");
    const p2 = api.receiveRoomMention({
      room_id: "room-muted-inflight",
      room_display_name: "Muted Room",
      message_id: "msg_2",
      thread_root_id: null,
    });
    await flush();
    prefGate.resolve({ room_id: "room-muted-inflight", level: "muted", snoozed_until: null });
    await pendingRefresh;
    await p2;
    await flush();
    assert.equal(createdNotifications.length, 0, "muted preference suppresses targeted mention");

    // 3. Global notifications disabled while getMessage is in flight -> 0 Notification.
    getPreferenceHandler = async (roomId) => ({ room_id: roomId, level: "all", snoozed_until: null });
    await roomNotificationPreferences.refresh("room-guard");
    const msgGate3 = deferred<DesktopRoomMessage | null>();
    getMessageHandler = () => msgGate3.promise;
    const p3 = api.receiveRoomMention({
      room_id: "room-guard",
      room_display_name: "Guard Room",
      message_id: "msg_3",
      thread_root_id: null,
    });
    await flush();
    emitStatusChanged({ ...notificationStatus, enabled: false });
    msgGate3.resolve(makeMessage("msg_3", "@bea disabled mid-flight"));
    await p3;
    await flush();
    assert.equal(createdNotifications.length, 0, "disabling global notifications mid-flight suppresses Notification");
    emitStatusChanged({ ...notificationStatus, enabled: true });

    // 4. Native APNs registration turns true while getMessage is in flight -> 0 renderer Notification & 0 background chime.
    documentVisibilityState = "hidden";
    const soundsBeforeApns = soundCount;
    const msgGate4 = deferred<DesktopRoomMessage | null>();
    getMessageHandler = () => msgGate4.promise;
    const p4 = api.receiveRoomMention({
      room_id: "room-guard",
      room_display_name: "Guard Room",
      message_id: "msg_4",
      thread_root_id: null,
    });
    await flush();
    emitStatusChanged({ enabled: true, nativeSupported: true, nativeRegistered: true, lastError: null });
    msgGate4.resolve(makeMessage("msg_4", "@bea apns handles this"));
    await p4;
    await flush();
    assert.equal(createdNotifications.length, 0, "APNs-active session suppresses duplicate renderer Notification");
    assert.equal(soundCount, soundsBeforeApns, "APNs background delivery suppresses duplicate renderer chime");
    documentVisibilityState = "visible";
    emitStatusChanged({ enabled: true, nativeSupported: false, nativeRegistered: false, lastError: null });

    // 5. User focuses the target room before getMessage resolves -> 0 Notification.
    const msgGate5 = deferred<DesktopRoomMessage | null>();
    getMessageHandler = () => msgGate5.promise;
    const p5 = api.receiveRoomMention({
      room_id: "room-guard",
      room_display_name: "Guard Room",
      message_id: "msg_5",
      thread_root_id: null,
    });
    await flush();
    documentHasFocus = true;
    activeEntry.value = { type: "room" };
    selectedRoomInfo.value = { identifier: "room-guard", displayName: "Guard Room", name: "room-guard" };
    msgGate5.resolve(makeMessage("msg_5", "@bea already looking here"));
    await p5;
    await flush();
    assert.equal(createdNotifications.length, 0, "focusing target room mid-flight suppresses Notification");
  } finally {
    scope.stop();
  }
});

test("Checkpoint #3: unopened Focus Room and archived room @mentions refresh sidebar, alert, respect snooze, and route click-to-open", async () => {
  // Also verify useAccountActivity opens /account/activity/stream when signed in with zero listed rooms.
  const activityScope = effectScope();
  activityScope.run(() => useAccountActivity({ authenticated: ref(true), roomIds: ref([]) }));
  await new Promise((resolve) => setTimeout(resolve, 430));
  assert.equal(restartActivityCalls, 1, "signed-in account with zero listed rooms still opens activity stream");
  activityScope.stop();

  roomNotificationPreferences.setViewer({ id: "acct_emmy", login: "emmymay" });
  let sidebarRefreshCalls = 0;
  const fallbackTargets: DesktopNotificationTarget[] = [];

  getMessageHandler = async (roomId, messageId) => {
    if (roomId === "focus_103" && messageId === "msg_15") {
      return makeMessage("msg_15", "@EmmyMay please check this thread", {
        sender: "Carbon supervisor | EmmyMay's agent | Codex",
        agentIdentity: {
          name: "worker",
          displayName: "Carbon supervisor",
          ownerLabel: "EmmyMay",
          ownerAttribution: "EmmyMay's agent",
          ideLabel: "Codex",
          actorLabel: "Carbon supervisor | EmmyMay's agent | Codex",
          agentKey: "EmmyMay/worker-1",
          agentSessionId: "agent_session_1509",
        },
        threadRootId: "msg_9",
        threadReplyToId: "msg_9",
      });
    }
    if (roomId === "archived-room" && messageId === "msg_88") {
      return makeMessage("msg_88", "@emmymay reopening discussion", { sender: "Lerato" });
    }
    return null;
  };

  const scope = effectScope();
  const api = scope.run(() =>
    useAppMessageNotifications({
      accountActivity: { state: ref<DesktopAccountActivityState>({ connected: true, rooms: {} }) },
      accountRooms: ref([]),
      activeEntry: ref({ type: "inbox" }),
      authStatus: ref({ authenticated: true, account: { id: "acct_emmy", login: "emmymay" } }),
      selectedRoomInfo: ref(null),
      handleNotificationActivation: async (target: DesktopNotificationTarget) => {
        fallbackTargets.push(target);
      },
      refreshSidebarRoomMetadata: async () => {
        sidebarRefreshCalls += 1;
      },
      roomHistoryMode: () => "cloud",
    }),
  )!;

  try {
    await flush();

    // Unopened Focus Room mention: refreshes sidebar metadata, shows Notification, and click activates target with threadRootId.
    await api.receiveRoomMention({
      room_id: "focus_103",
      room_display_name: "Focus: Features",
      message_id: "msg_15",
      thread_root_id: "msg_9",
    });
    await flush();

    assert.equal(sidebarRefreshCalls, 1, "unlisted room mention triggers sidebar room metadata refresh");
    assert.equal(createdNotifications.length, 1);
    assert.equal(createdNotifications[0]!.title, "Carbon supervisor in Focus: Features");
    assert.equal(createdNotifications[0]!.options.body, "@EmmyMay please check this thread");

    createdNotifications[0]!.onclick?.();
    await flush();
    assert.deepEqual(activatedViaIpc, [
      {
        notificationId: "fallback:focus_103:msg_15",
        roomIdentifier: "focus_103",
        messageId: "msg_15",
        threadRootId: "msg_9",
      },
    ]);
    assert.deepEqual(fallbackTargets, [], "when Electron IPC handles activation, renderer fallback does not double-run");

    // Archived room mention when IPC returns false falls back cleanly to handleNotificationActivation.
    ipcActivateResult = false;
    await api.receiveRoomMention({
      room_id: "archived-room",
      room_display_name: "Archived Design",
      message_id: "msg_88",
      thread_root_id: null,
    });
    await flush();
    assert.equal(createdNotifications.length, 2);
    assert.equal(createdNotifications[1]!.title, "Lerato in Archived Design");
    createdNotifications[1]!.onclick?.();
    await flush();
    assert.deepEqual(fallbackTargets, [
      {
        notificationId: "fallback:archived-room:msg_88",
        roomIdentifier: "archived-room",
        messageId: "msg_88",
        threadRootId: null,
      },
    ]);

    // Snoozed archived room suppresses mention.
    getPreferenceHandler = async (roomId) => ({
      room_id: roomId,
      level: "all",
      snoozed_until: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await roomNotificationPreferences.refresh("snoozed-archived");
    getMessageHandler = async () => makeMessage("msg_89", "@emmymay snoozed ping");
    await api.receiveRoomMention({
      room_id: "snoozed-archived",
      room_display_name: "Snoozed Room",
      message_id: "msg_89",
      thread_root_id: null,
    });
    await flush();
    assert.equal(createdNotifications.length, 2, "snoozed room suppresses mention alert");
  } finally {
    scope.stop();
  }
});

test("Startup snapshot stays silent, empty Focus Room first message alerts, and own-agent ordinary messages stay silent while own-agent @mentions alert", async () => {
  roomNotificationPreferences.setViewer({ id: "acct_emmy", login: "emmymay" });
  await roomNotificationPreferences.refresh("focus_empty");
  await roomNotificationPreferences.refresh("repo_main");

  const messagesById = new Map<string, DesktopRoomMessage>([
    [
      "msg_own_human",
      makeMessage("msg_own_human", "@EmmyMay note to self", {
        sender: "EmmyMay",
        senderProfile: { login: "EmmyMay", avatarUrl: null },
        agentIdentity: null,
      }),
    ],
    [
      "msg_own_agent_ordinary",
      makeMessage("msg_own_agent_ordinary", "running verification suite now", {
        sender: "FjordSpring | EmmyMay's agent | Agent",
        source: "agent",
        senderProfile: null,
        agentIdentity: {
          name: "fjordspring",
          displayName: "FjordSpring",
          ownerLabel: "EmmyMay",
          ownerAttribution: "EmmyMay's agent",
          ideLabel: "Agent",
          actorLabel: "FjordSpring | EmmyMay's agent | Agent",
          agentKey: "EmmyMay/fjordspring",
          agentSessionId: "agent_session_1510",
        },
      }),
    ],
    [
      "msg_own_agent_mention",
      makeMessage("msg_own_agent_mention", "@EmmyMay PR is ready for review", {
        sender: "FjordSpring | EmmyMay's agent | Agent",
        source: "agent",
        senderProfile: null,
        agentIdentity: {
          name: "fjordspring",
          displayName: "FjordSpring",
          ownerLabel: "EmmyMay",
          ownerAttribution: "EmmyMay's agent",
          ideLabel: "Agent",
          actorLabel: "FjordSpring | EmmyMay's agent | Agent",
          agentKey: "EmmyMay/fjordspring",
          agentSessionId: "agent_session_1510",
        },
      }),
    ],
    [
      "msg_1",
      makeMessage("msg_1", "first message in brand-new focus room", {
        sender: "Ada",
        senderProfile: { login: "ada", avatarUrl: null },
      }),
    ],
  ]);

  getMessageHandler = async (_roomId, messageId) => messagesById.get(messageId) ?? null;
  getMessagesAfterHandler = async (_roomId, _afterId) => ({ messages: [] });

  const accountActivityState = ref<DesktopAccountActivityState>({
    connected: true,
    rooms: {
      repo_main: {
        roomId: "repo_main",
        latestMessageId: "msg_4",
        latestMessageAt: "2026-11-11T00:00:00.000Z",
        working: [],
      },
      focus_empty: {
        roomId: "focus_empty",
        latestMessageId: null,
        latestMessageAt: null,
        working: [],
      },
    },
  });

  const scope = effectScope();
  scope.run(() =>
    useAppMessageNotifications({
      accountActivity: { state: accountActivityState },
      accountRooms: ref([]),
      activeEntry: ref({ type: "inbox" }),
      authStatus: ref({ authenticated: true, account: { id: "acct_emmy", login: "emmymay" } }),
      selectedRoomInfo: ref(null),
      handleNotificationActivation: async () => undefined,
      refreshSidebarRoomMetadata: async () => undefined,
      roomHistoryMode: () => "cloud",
    }),
  );

  try {
    await flush();
    assert.equal(createdNotifications.length, 0, "initial snapshot produces 0 notifications");

    // 1. Empty Focus Room seeded with latestMessageId: null receives msg_1 -> alerts!
    accountActivityState.value = {
      connected: true,
      rooms: {
        ...accountActivityState.value.rooms,
        focus_empty: {
          roomId: "focus_empty",
          latestMessageId: "msg_1",
          latestMessageAt: "2026-11-11T00:01:00.000Z",
          working: [],
        },
      },
    };
    await flush();
    assert.equal(createdNotifications.length, 1, "first message in empty Focus Room alerts");
    assert.equal(createdNotifications[0]!.options.body, "first message in brand-new focus room");

    // 2. Viewer's own human self-mention -> suppressed.
    messagesById.set("msg_5", messagesById.get("msg_own_human")!);
    accountActivityState.value = {
      connected: true,
      rooms: {
        ...accountActivityState.value.rooms,
        repo_main: {
          roomId: "repo_main",
          latestMessageId: "msg_5",
          latestMessageAt: "2026-11-11T00:02:00.000Z",
          working: [],
        },
      },
    };
    await flush();
    assert.equal(createdNotifications.length, 1, "human self-mention stays suppressed");

    // 3. Viewer's own agent ordinary message in All-messages room -> suppressed (msg_39 regression).
    messagesById.set("msg_6", { ...messagesById.get("msg_own_agent_ordinary")!, id: "msg_6" });
    accountActivityState.value = {
      connected: true,
      rooms: {
        ...accountActivityState.value.rooms,
        repo_main: {
          roomId: "repo_main",
          latestMessageId: "msg_6",
          latestMessageAt: "2026-11-11T00:03:00.000Z",
          working: [],
        },
      },
    };
    await flush();
    assert.equal(createdNotifications.length, 1, "own-agent ordinary message stays suppressed on All messages");

    // 4. Viewer's own agent explicit @EmmyMay mention -> alerts!
    messagesById.set("msg_7", { ...messagesById.get("msg_own_agent_mention")!, id: "msg_7" });
    accountActivityState.value = {
      connected: true,
      rooms: {
        ...accountActivityState.value.rooms,
        repo_main: {
          roomId: "repo_main",
          latestMessageId: "msg_7",
          latestMessageAt: "2026-11-11T00:04:00.000Z",
          working: [],
        },
      },
    };
    await flush();
    assert.equal(createdNotifications.length, 2, "own-agent explicit @owner mention alerts");
    assert.equal(createdNotifications[1]!.options.body, "@EmmyMay PR is ready for review");
  } finally {
    scope.stop();
  }
});

test("Active-room watcher preserves established own-agent ordinary chime, deduplicates own-agent @owner mentions, and fences mid-refresh account switches", async () => {
  // Part A (msg_42): Active open room still chimes/notifies on own-agent ordinary messages while unfocused,
  // and deduplicates own-agent @owner mentions across active + background/mention paths.
  roomNotificationPreferences.setViewer({ id: "acct_emmy", login: "emmymay" });
  await roomNotificationPreferences.refresh("open-room");

  const ownAgentOrdinary = makeMessage("msg_20", "working through tests", {
    sender: "FjordSpring | EmmyMay's agent | Agent",
    source: "agent",
    senderProfile: null,
    agentIdentity: {
      name: "fjordspring",
      displayName: "FjordSpring",
      ownerLabel: "EmmyMay",
      ownerAttribution: "EmmyMay's agent",
      ideLabel: "Agent",
      actorLabel: "FjordSpring | EmmyMay's agent | Agent",
      agentKey: "EmmyMay/fjordspring",
      agentSessionId: "agent_session_1510",
    },
  });
  const ownAgentMention = makeMessage("msg_21", "@EmmyMay all checks green", {
    ...ownAgentOrdinary,
    id: "msg_21",
    text: "@EmmyMay all checks green",
  });
  getMessageHandler = async (_r, id) => (id === "msg_21" ? ownAgentMention : ownAgentOrdinary);

  const visibleMessages = ref<DesktopRoomMessage[]>([]);
  const accountActivityState = ref<DesktopAccountActivityState>({
    connected: true,
    rooms: {
      "open-room": {
        roomId: "open-room",
        latestMessageId: "msg_19",
        latestMessageAt: "2026-11-11T00:00:00.000Z",
        working: [],
      },
    },
  });

  const scope = effectScope();
  const appApi = scope.run(() => {
    const shellPrefs = useDesktopRoomPreferences(() => "open-room");
    shellPrefs.watchRoomNotifications({
      visibleMessages,
      ownMessageIds: new Set(),
      playRoomSound: shellPrefs.playRoomSound,
      showRoomNotification: (m) => shellPrefs.showRoomNotification(m, "Open Room"),
    });
    return useAppMessageNotifications({
      accountActivity: { state: accountActivityState },
      accountRooms: ref([]),
      activeEntry: ref({ type: "room" }),
      authStatus: ref({ authenticated: true, account: { id: "acct_emmy", login: "emmymay" } }),
      selectedRoomInfo: ref({ identifier: "open-room", displayName: "Open Room", name: "open-room" }),
      handleNotificationActivation: async () => undefined,
      refreshSidebarRoomMetadata: async () => undefined,
      roomHistoryMode: () => "cloud",
    });
  })!;

  try {
    visibleMessages.value = [makeMessage("msg_19", "history")];
    await flush();
    const soundsBeforeOrdinary = soundCount;
    visibleMessages.value = [...visibleMessages.value, ownAgentOrdinary];
    accountActivityState.value = {
      connected: true,
      rooms: {
        "open-room": {
          roomId: "open-room",
          latestMessageId: "msg_20",
          latestMessageAt: "2026-11-11T00:01:00.000Z",
          working: [],
        },
      },
    };
    await flush();
    assert.equal(createdNotifications.length, 1, "active-room watcher preserves established own-agent ordinary alert");
    assert.equal(soundCount > soundsBeforeOrdinary, true, "active-room watcher preserves established own-agent ordinary chime");

    // Own-agent explicit @EmmyMay mention arriving on active-room + activity + room_mention -> 1 alert total.
    visibleMessages.value = [...visibleMessages.value, ownAgentMention];
    accountActivityState.value = {
      connected: true,
      rooms: {
        "open-room": {
          roomId: "open-room",
          latestMessageId: "msg_21",
          latestMessageAt: "2026-11-11T00:02:00.000Z",
          working: [],
        },
      },
    };
    await appApi.receiveRoomMention({
      room_id: "open-room",
      room_display_name: "Open Room",
      message_id: "msg_21",
      thread_root_id: null,
    });
    await flush();
    assert.equal(createdNotifications.length, 2, "explicit own-agent @owner mention deduplicates across active + background paths");
  } finally {
    scope.stop();
  }

  // Part B (msg_43): Active-room async account-switch race while post-allowsAfterRead refresh(id) is pending.
  createdNotifications.length = 0;
  roomMessageAlertGate.reset();
  let callIndex = 0;
  const secondRefreshGate = deferred<{ room_id: string; level: "all" | "mentions" | "muted"; snoozed_until: string | null }>();
  getPreferenceHandler = (roomId) => {
    callIndex += 1;
    // Let the initial mount refresh happen for a different room, then keep `race-room` unready at message arrival
    // by switching viewer AFTER mount so `state("race-room").ready === false` with no in-flight read!
    if (roomId === "race-room" && callIndex >= 2) {
      return secondRefreshGate.promise;
    }
    return Promise.resolve({ room_id: roomId, level: "all", snoozed_until: null });
  };

  roomNotificationPreferences.setViewer({ id: "acct_initial", login: "initial" });
  const raceMessages = ref<DesktopRoomMessage[]>([]);
  const raceScope = effectScope();
  raceScope.run(() => {
    const shellPrefs = useDesktopRoomPreferences(() => "race-room");
    shellPrefs.watchRoomNotifications({
      visibleMessages: raceMessages,
      ownMessageIds: new Set(),
      playRoomSound: shellPrefs.playRoomSound,
      showRoomNotification: (m) => shellPrefs.showRoomNotification(m, "Race Room"),
    });
  });

  try {
    raceMessages.value = [makeMessage("msg_1", "baseline")];
    await flush();
    // Switch to `acct_old` without refreshing `race-room`: now `signedIn() === true` and `state("race-room").ready === false`
    // with NO in-flight read, so `allowsAfterRead("race-room", ...)` resolves `true` immediately and enters `await refresh("race-room")`!
    roomNotificationPreferences.setViewer({ id: "acct_old", login: "olduser" });
    assert.equal(roomNotificationPreferences.state("race-room").ready, false);

    const soundsBeforeRace = soundCount;
    raceMessages.value = [...raceMessages.value, makeMessage("msg_race", "hello from old account stream")];
    await flush();
    assert.equal(createdNotifications.length, 0, "still waiting on refresh(race-room)");

    // Switch viewer to `acct_new` while `refresh("race-room")` is pending!
    roomNotificationPreferences.setViewer({ id: "acct_new", login: "newuser" });
    secondRefreshGate.resolve({ room_id: "race-room", level: "all", snoozed_until: null });
    await flush();

    assert.equal(createdNotifications.length, 0, "stale viewer alert is dropped after mid-refresh account switch");
    assert.equal(soundCount, soundsBeforeRace, "stale viewer chime is dropped after mid-refresh account switch");
    assert.equal(
      roomMessageAlertGate.has("acct_new", "race-room", "msg_race"),
      false,
      "old viewer's message must not be claimed under the new viewer's alert gate",
    );
  } finally {
    raceScope.stop();
  }

  // Part C (msg_47 microtask transition): preferences already ready under acct_a, queueMicrotask switches viewer
  // before shouldNotify resumes after `await allowsAfterRead(...)` -> old message discarded without alerting under acct_b.
  getPreferenceHandler = async (roomId) => ({ room_id: roomId, level: "all", snoozed_until: null });
  roomNotificationPreferences.setViewer({ id: "acct_a", login: "ada" });
  const microtaskMessages = ref<DesktopRoomMessage[]>([]);
  const microtaskAlerts: string[] = [];
  const microtaskScope = effectScope();
  microtaskScope.run(() => {
    const prefs = useDesktopRoomPreferences(() => "same-room");
    prefs.watchRoomNotifications({
      visibleMessages: microtaskMessages,
      ownMessageIds: new Set(),
      playRoomSound: prefs.playRoomSound,
      showRoomNotification: (m) => microtaskAlerts.push(m.id),
    });
  });
  try {
    microtaskMessages.value = [makeMessage("msg_1", "history")];
    await flush();
    assert.equal(roomNotificationPreferences.state("same-room").ready, true);
    const read = deferred<{ room_id: string; level: "all" | "mentions" | "muted"; snoozed_until: string | null }>();
    getPreferenceHandler = () => read.promise;
    const soundsBeforeMicrotask = soundCount;
    microtaskMessages.value = [...microtaskMessages.value, makeMessage("msg_2", "old-account message")];
    queueMicrotask(() => roomNotificationPreferences.setViewer({ id: "acct_b", login: "bea" }));
    await flush();
    read.resolve({ room_id: "same-room", level: "all", snoozed_until: null });
    await flush();
    assert.deepEqual(microtaskAlerts, [], "old-account message must be discarded across microtask viewer switch");
    assert.equal(soundCount, soundsBeforeMicrotask);
    assert.equal(roomMessageAlertGate.has("acct_b", "same-room", "msg_2"), false);
  } finally {
    microtaskScope.stop();
  }
});
