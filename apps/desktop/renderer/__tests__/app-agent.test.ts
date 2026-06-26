import assert from "node:assert/strict";
import test from "node:test";

import {
  appAgentArchivedRoomIdentifiers,
  appAgentCurrentPhase,
  appAgentRefreshTargets,
  appAgentSurfaceKicker,
  appAgentSurfaceState,
  appAgentStatusLabel,
  appAgentTimeline,
  appAgentTraceDisplayEntry,
  buildAppAgentRunInput,
  shouldRefreshRoomsAfterAppAgentResult,
  visibleAppAgentExecutionJournal,
  visibleAppAgentPlan,
  visibleAppAgentChoices,
} from "../src/domain/app-agent";
import {
  appAgentClampTopLeft,
  appAgentPanelPositionForLauncher,
  appAgentOrbCenterFromLauncherPosition,
  appAgentOrbCenterFromPanelPosition,
  appAgentLauncherPositionFromPanel,
  appAgentPanelPositionFromLauncher,
} from "../src/components/desktop/app-agent/useAppAgentPosition";

test("App Agent submit input trims prompts and includes the active room", () => {
  assert.deepEqual(
    buildAppAgentRunInput({
      prompt: "  Pin the LetAgents room.  ",
      activeRoomDisplayName: "The Test Room",
      activeRoomIdentifier: "room_1",
      activeRoomPinned: false,
    }),
    {
      prompt: "Pin the LetAgents room.",
      activeRoomIdentifier: "room_1",
      activeRoomDisplayName: "The Test Room",
      activeRoomPinned: false,
      selectedAction: null,
      confirmedAction: null,
      confirmedPlan: null,
    },
  );
  assert.equal(buildAppAgentRunInput({ prompt: "   " }), null);
});

test("App Agent panel position preserves the orb anchor across open and close", () => {
  const launcherPosition = { x: 640, y: 360 };
  const panelPosition = appAgentPanelPositionFromLauncher(launcherPosition);

  assert.deepEqual(
    appAgentLauncherPositionFromPanel(panelPosition),
    launcherPosition,
  );
  assert.notDeepEqual(panelPosition, launcherPosition);
  assert.deepEqual(
    appAgentOrbCenterFromPanelPosition(panelPosition),
    appAgentOrbCenterFromLauncherPosition(launcherPosition),
  );
});

test("App Agent panel opens near an orb dragged to the message input", () => {
  const launcherPosition = { x: 997, y: 652 };
  const compactPanel = { width: 390, height: 260 };
  const viewport = { width: 1296, height: 768 };

  assert.deepEqual(
    appAgentOrbCenterFromLauncherPosition(launcherPosition),
    { x: 1035, y: 690 },
  );
  assert.deepEqual(
    appAgentPanelPositionForLauncher(launcherPosition, compactPanel, viewport),
    { x: 894, y: 496 },
  );
});

test("App Agent launcher keeps clear of bottom room controls", () => {
  assert.deepEqual(
    appAgentClampTopLeft(
      { x: 1200, y: 644 },
      { width: 76, height: 76 },
      { width: 1296, height: 768 },
      172,
    ),
    { x: 1200, y: 520 },
  );
});

test("App Agent selected actions are converted to plain IPC-safe objects", () => {
  const proxiedInput = new Proxy(
    { roomIdentifier: "sable-creek", pinned: null, archived: null, mode: null },
    {},
  );
  const proxiedAction = new Proxy(
    {
      actionId: "rooms.open",
      input: proxiedInput,
      label: "Open sable-creek",
      description: "Open the room.",
      risk: "low" as const,
      refreshTargets: ["active_room", "foreground"] as const,
    },
    {},
  );

  const runInput = buildAppAgentRunInput({
    prompt: "open sable-creek",
    selectedAction: proxiedAction,
  });

  assert.deepEqual(runInput?.selectedAction, {
    actionId: "rooms.open",
    input: { roomIdentifier: "sable-creek", pinned: null, archived: null, mode: null },
    label: "Open sable-creek",
    description: "Open the room.",
    risk: "low",
    refreshTargets: ["active_room", "foreground"],
  });
  assert.notEqual(runInput?.selectedAction, proxiedAction);
  assert.notEqual(runInput?.selectedAction?.input, proxiedInput);
});

test("App Agent confirmed plans are converted to plain IPC-safe objects", () => {
  const proxiedPlan = new Proxy(
    {
      planId: "plan_1",
      title: "Pin rooms",
      description: "Pin two rooms.",
      actions: [
        {
          actionId: "rooms.pin",
          input: { roomIdentifier: "room_1", pinned: true },
          label: "Pin Room 1",
          description: "Pin Room 1.",
          risk: "low" as const,
          refreshTargets: ["rooms"] as const,
        },
      ],
      risk: "low" as const,
      confirmLabel: "Run",
      cancelLabel: "Cancel",
      refreshTargets: ["rooms"] as const,
    },
    {},
  );
  const runInput = buildAppAgentRunInput({
    prompt: "pin room 1",
    confirmedPlan: proxiedPlan,
  });

  assert.deepEqual(runInput?.confirmedPlan, {
    planId: "plan_1",
    title: "Pin rooms",
    description: "Pin two rooms.",
    actions: [
      {
        actionId: "rooms.pin",
        input: { roomIdentifier: "room_1", pinned: true },
        label: "Pin Room 1",
        description: "Pin Room 1.",
        risk: "low",
        refreshTargets: ["rooms"],
      },
    ],
    risk: "low",
    confirmLabel: "Run",
    cancelLabel: "Cancel",
    refreshTargets: ["rooms"],
  });
  assert.notEqual(runInput?.confirmedPlan, proxiedPlan);
});

test("App Agent ambiguous choices are visible only for choice results", () => {
  const choices = visibleAppAgentChoices({
    state: "choices",
    message: "Choose a room.",
    choices: [
      {
        choiceId: "rooms.pin:1",
        label: "Rentals",
        description: "Name match",
        actionId: "rooms.pin",
        input: { roomIdentifier: "room_1", pinned: true },
        risk: "low",
      },
    ],
  });
  assert.equal(choices.length, 1);
  assert.equal(choices[0].label, "Rentals");
  assert.deepEqual(
    visibleAppAgentChoices({ state: "success", message: "Pinned." }),
    [],
  );
});

test("App Agent plan preview and execution journal are exposed for renderer UI", () => {
  const result = {
    state: "confirmation_required" as const,
    message: "Confirm plan.",
    pendingPlan: {
      planId: "plan_1",
      title: "Pin rooms",
      description: "Pin two rooms.",
      actions: [
        {
          actionId: "rooms.pin",
          input: { roomIdentifier: "room_1", pinned: true },
          label: "Pin Room 1",
          risk: "low" as const,
        },
      ],
      risk: "low" as const,
      confirmLabel: "Run",
      cancelLabel: "Cancel",
      refreshTargets: ["rooms" as const],
    },
    executedActions: [
      {
        actionId: "rooms.pin",
        label: "Pin Room 1",
        status: "success" as const,
        message: "Pinned Room 1.",
      },
    ],
  };

  assert.equal(visibleAppAgentPlan(result)?.title, "Pin rooms");
  assert.equal(visibleAppAgentExecutionJournal(result).length, 1);
});

test("App Agent success results request room refresh", () => {
  assert.equal(
    shouldRefreshRoomsAfterAppAgentResult({
      state: "success",
      message: "Pinned LetAgents.",
      roomIdentifier: "room_1",
    }),
    true,
  );
  assert.equal(
    shouldRefreshRoomsAfterAppAgentResult({
      state: "choices",
      message: "Choose a room.",
    }),
    false,
  );
  assert.deepEqual(
    appAgentRefreshTargets({
      state: "error",
      message: "Stopped after 1 of 2 actions.",
      refreshTargets: ["rooms", "active_room"],
      executedActions: [
        {
          actionId: "rooms.archive",
          label: "Archive Room A",
          status: "success",
          message: "Archived Room A.",
        },
        {
          actionId: "rooms.archive",
          label: "Archive Room B",
          status: "error",
          message: "Action failed.",
        },
      ],
    }),
    ["rooms", "active_room"],
  );
});

test("App Agent archive results expose all archived room identifiers", () => {
  assert.deepEqual(
    appAgentArchivedRoomIdentifiers({
      state: "success",
      message: "Archived rooms.",
      roomIdentifier: "Room_A",
      archived: true,
      displayName: "Room A",
      actionResult: {
        roomIdentifiers: ["Room_A", "Room_B"],
        archivedRoomIdentifiers: ["Room_D"],
        archivedRooms: [{ roomIdentifier: "Room_E", displayName: "Room E" }],
        rooms: [{ roomIdentifier: "Room_C", displayName: "Room C" }],
      },
    }),
    [
      "room_a",
      "room a",
      "room_d",
      "room_b",
      "room_c",
      "room c",
      "room_e",
      "room e",
    ],
  );
  assert.deepEqual(
    appAgentArchivedRoomIdentifiers({
      state: "error",
      message: "Stopped after archiving a room.",
      roomIdentifier: "Room_A",
      archived: true,
    }),
    ["room_a"],
  );
  assert.deepEqual(
    appAgentArchivedRoomIdentifiers({
      state: "success",
      message: "Pinned room.",
      roomIdentifier: "Room_A",
      archived: false,
    }),
    [],
  );
});

test("App Agent surface state maps busy and result states", () => {
  assert.equal(appAgentSurfaceState({ busy: true, result: null }), "running");
  assert.equal(
    appAgentSurfaceState({
      busy: false,
      result: null,
      settingsStatus: {
        configured: false,
        hasApiKey: false,
        model: "openai/gpt-4.1-mini",
        savedAt: null,
        settingsPath: "/tmp/settings.json",
        error: null,
      },
    }),
    "configuration",
  );
  assert.equal(
    appAgentSurfaceState({
      busy: false,
      result: { state: "confirmation_required", message: "Confirm.", pendingAction: null },
      settingsStatus: {
        configured: true,
        hasApiKey: true,
        model: "openai/gpt-4.1-mini",
        savedAt: null,
        settingsPath: "/tmp/settings.json",
        error: null,
      },
    }),
    "confirmation",
  );
  assert.equal(
    appAgentSurfaceState({
      busy: false,
      result: { state: "choices", message: "Choose a room.", choices: [] },
    }),
    "choices",
  );
  assert.equal(
    appAgentSurfaceState({
      busy: false,
      result: { state: "success", message: "Done." },
    }),
    "success",
  );
  assert.equal(
    appAgentSurfaceState({
      busy: false,
      result: { state: "error", message: "Stopped." },
    }),
    "error",
  );
  assert.equal(appAgentSurfaceKicker("success"), "Complete");
});

test("App Agent timeline gives humans progressive running states", () => {
  assert.deepEqual(
    appAgentTimeline({ busy: true, result: null }).map((item) => [item.label, item.state]),
    [
      ["Understanding request", "active"],
      ["Checking app context", "pending"],
      ["Preparing action", "pending"],
    ],
  );
});

test("App Agent timeline summarizes trace activity and outcomes", () => {
  const timeline = appAgentTimeline({
    busy: false,
    result: {
      state: "success",
      message: "Archived shore-delta.",
      archived: true,
      refreshTargets: ["rooms", "active_room"],
      trace: [
        {
          id: "trace_1",
          label: "Asked model to plan",
          status: "info",
          detail: "openai/gpt-4.1-mini",
        },
        {
          id: "trace_2",
          label: "Call list_account_rooms",
          status: "success",
          actionId: "rooms.list",
        },
        {
          id: "trace_3",
          label: "Execute set_room_archived",
          status: "success",
          actionId: "rooms.archive",
          detail: "shore-delta",
        },
      ],
    },
  });

  assert.deepEqual(
    timeline.map((item) => [item.label, item.state]),
    [
      ["Understanding request", "done"],
      ["Checking available rooms", "done"],
      ["Archiving room", "done"],
      ["Refreshing app", "done"],
      ["Done", "done"],
    ],
  );
});

test("App Agent activity display hides technical tool names", () => {
  const displayEntries = [
    appAgentTraceDisplayEntry({
      id: "trace_1",
      label: "Call list_account_rooms",
      status: "success",
      detail: "list_account_rooms",
      actionId: "rooms.list",
    }),
    appAgentTraceDisplayEntry({
      id: "trace_2",
      label: "Execute set_room_archived",
      status: "success",
      detail: "set_room_archived",
      actionId: "rooms.archive",
    }),
    appAgentTraceDisplayEntry({
      id: "trace_3",
      label: "Call archive_unpinned_rooms",
      status: "info",
      detail: "archive_unpinned_rooms",
      actionId: "rooms.archive_unpinned",
    }),
    appAgentTraceDisplayEntry({
      id: "trace_4",
      label: "Call set_room_pinned",
      status: "success",
      detail: "set_room_pinned",
      actionId: "rooms.pin",
    }),
  ];

  assert.deepEqual(
    displayEntries.map((entry) => entry.label),
    ["Checked rooms", "Ran archive action", "Ran archive action", "Ran pin action"],
  );
  assert.doesNotMatch(
    JSON.stringify(displayEntries),
    /set_room_|list_account_rooms|archive_unpinned_rooms/,
  );
});

test("App Agent timeline marks confirmation and errors as human-readable stops", () => {
  assert.deepEqual(
    appAgentTimeline({
      busy: false,
      result: {
        state: "confirmation_required",
        message: "Please confirm.",
        pendingAction: null,
      },
    }).map((item) => [item.label, item.state]),
    [["Needs confirmation", "active"]],
  );
  assert.deepEqual(
    appAgentTimeline({
      busy: false,
      result: {
        state: "error",
        message: "The model stopped before completing the app tool path.",
      },
    }).map((item) => [item.label, item.state]),
    [["Stopped", "error"]],
  );
});

test("App Agent timeline hides internal model decision details", () => {
  assert.deepEqual(
    appAgentTimeline({
      busy: false,
      result: {
        state: "success",
        message: "Opened sky-lake.",
        trace: [
          {
            id: "trace_1",
            label: "Model returned decision",
            status: "success",
            detail: "state=success, open=github.com/brosincode/letagents",
          },
        ],
      },
    }).map((item) => [item.label, item.detail, item.state]),
    [
      ["Planned action", null, "done"],
      ["Done", "Opened sky-lake.", "done"],
    ],
  );
});

test("App Agent current phase picks the human-facing capsule state", () => {
  assert.deepEqual(
    appAgentCurrentPhase({ busy: true, result: null }),
    {
      label: "Understanding request",
      detail: null,
      state: "active",
    },
  );
  assert.deepEqual(
    appAgentCurrentPhase({
      busy: false,
      result: {
        state: "confirmation_required",
        message: "Please confirm archive.",
        pendingAction: null,
      },
    }),
    {
      label: "Waiting for confirmation",
      detail: "Please confirm archive.",
      state: "active",
    },
  );
  assert.deepEqual(
    appAgentCurrentPhase({
      busy: false,
      result: {
        state: "success",
        message: "Opened sky-lake.",
      },
    }),
    {
      label: "Done",
      detail: "Opened sky-lake.",
      state: "done",
    },
  );
});

test("App Agent status label reflects busy and setup states", () => {
  assert.equal(appAgentStatusLabel(null, true), "Running");
  assert.equal(appAgentStatusLabel(null, false), "Checking");
  assert.equal(
    appAgentStatusLabel({
      configured: false,
      hasApiKey: false,
      model: "anthropic/claude-3.5-sonnet",
      savedAt: null,
      settingsPath: "/tmp/settings.json",
      error: null,
    }, false),
    "Setup needed",
  );
  assert.equal(
    appAgentStatusLabel({
      configured: true,
      hasApiKey: true,
      model: "openai/gpt-4o-mini",
      savedAt: "2026-06-17T00:00:00.000Z",
      settingsPath: "/tmp/settings.json",
      error: null,
    }, false),
    "openai/gpt-4o-mini",
  );
});
