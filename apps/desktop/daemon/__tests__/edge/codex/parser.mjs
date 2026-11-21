/**
 * Strict Format 1 Codex replay transcript parser.
 * Matches `parseProviderReplayTranscript`: requires `transcript_start` on line 1,
 * valid entry kinds on every line, and a terminating `runtime_exit` entry.
 */
export function parseCodexEdgeTranscript(text, source = "codex-transcript") {
  const rawLines = text.split(/\r?\n/);
  const nonEmpty = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i].trim();
    if (line) nonEmpty.push({ lineNumber: i + 1, raw: line });
  }
  if (nonEmpty.length < 2) {
    throw new Error(`${source}: transcript must contain transcript_start and runtime_exit.`);
  }
  const start = JSON.parse(nonEmpty[0].raw);
  if (
    !start ||
    typeof start !== "object" ||
    start.type !== "transcript_start" ||
    start.format !== 1 ||
    start.provider !== "codex" ||
    typeof start.protocol !== "string" ||
    typeof start.providerVersion !== "string" ||
    typeof start.scenario !== "string"
  ) {
    throw new Error(`${source}:1: invalid transcript_start header for codex.`);
  }

  const entries = [];
  let runtimeExit = null;
  for (let i = 1; i < nonEmpty.length; i += 1) {
    const { lineNumber, raw } = nonEmpty[i];
    if (runtimeExit) {
      throw new Error(`${source}:${lineNumber}: unexpected entry after runtime_exit.`);
    }
    const entry = JSON.parse(raw);
    if (!entry || typeof entry !== "object") {
      throw new Error(`${source}:${lineNumber}: entry must be a JSON object.`);
    }
    if (entry.type === "expect_outbound" || entry.type === "emit_inbound") {
      if (!entry.frame || typeof entry.frame !== "object" || Array.isArray(entry.frame)) {
        throw new Error(`${source}:${lineNumber}: ${entry.type} requires an object frame.`);
      }
      entries.push(entry);
    } else if (entry.type === "runtime_exit") {
      if (
        typeof entry.requested !== "boolean" ||
        typeof entry.transportClosedBeforeExit !== "boolean" ||
        (entry.code !== null && typeof entry.code !== "number") ||
        (entry.signal !== null && typeof entry.signal !== "string")
      ) {
        throw new Error(`${source}:${lineNumber}: malformed runtime_exit entry.`);
      }
      runtimeExit = entry;
      entries.push(entry);
    } else {
      throw new Error(`${source}:${lineNumber}: unknown transcript entry type "${String(entry.type)}".`);
    }
  }
  if (!runtimeExit) {
    throw new Error(`${source}: transcript is missing required terminating runtime_exit entry.`);
  }

  let initializeResult = null;
  let mcpServerStatusResult = null;
  let threadStartResult = null;
  let threadResumeResult = null;
  let mcpResourceReadResult = null;
  const postInitializeNotifications = [];
  const postThreadStartNotifications = [];
  const postThreadResumeNotifications = [];
  const latestReadTurnsById = new Map();

  let phase = "pre_init";
  const turns = [];
  let currentTurn = null;
  let currentNotifyStep = null;

  const pushTurnNotify = (frame) => {
    if (!currentTurn) return;
    if (!currentNotifyStep) {
      currentNotifyStep = { kind: "notify", frames: [] };
      currentTurn.steps.push(currentNotifyStep);
    }
    currentNotifyStep.frames.push(frame);
  };

  for (const entry of entries) {
    if (entry.type === "runtime_exit") break;
    const frame = entry.frame;
    const label = entry.label || frame.method || "";

    if (entry.type === "emit_inbound" && label === "thread/read" && frame.result?.thread?.turns) {
      for (const t of frame.result.thread.turns) {
        if (t && typeof t.id === "string") {
          latestReadTurnsById.set(t.id, t);
        }
      }
    }

    if (entry.type === "expect_outbound") {
      if (label === "turn/start") {
        phase = "in_turn";
        currentTurn = {
          turnIndex: turns.length + 1,
          turnPlaceholder: `<turn-${turns.length + 1}>`,
          turnStartResult: null,
          steps: [],
          hasTerminalNotification: false,
          recoveredTurnSnapshot: null,
        };
        currentNotifyStep = null;
        turns.push(currentTurn);
      } else if (label === "turn/interrupt" && currentTurn) {
        currentNotifyStep = null;
        currentTurn.steps.push({ kind: "await_interrupt", responseResult: {} });
      } else if (label.startsWith("reply:") && currentTurn) {
        currentNotifyStep = null;
      } else if (label === "thread/resume") {
        if (currentTurn && !currentTurn.hasTerminalNotification) {
          currentTurn = null;
          currentNotifyStep = null;
        }
        phase = "post_resume";
      } else if (label === "initialize" && initializeResult) {
        if (currentTurn && !currentTurn.hasTerminalNotification) {
          currentTurn = null;
          currentNotifyStep = null;
        }
        phase = "reconnect";
      }
      continue;
    }

    if (entry.type === "emit_inbound") {
      const isResponse = frame.id !== undefined && frame.method === undefined;
      const isServerRequest = frame.id !== undefined && typeof frame.method === "string";
      const isNotification = frame.id === undefined && typeof frame.method === "string";

      if (isResponse) {
        if (label === "initialize" && !initializeResult) {
          initializeResult = frame.result;
          phase = "post_init";
        } else if (label === "mcpServerStatus/list" && !mcpServerStatusResult) {
          mcpServerStatusResult = frame.result;
        } else if (label === "thread/start" && !threadStartResult) {
          threadStartResult = frame.result;
          phase = "post_thread_start";
        } else if (label === "thread/resume" && !threadResumeResult) {
          threadResumeResult = frame.result;
          phase = "post_resume";
        } else if (label === "mcpServer/resource/read" && !mcpResourceReadResult) {
          mcpResourceReadResult = frame.result;
        } else if (label === "turn/start" && currentTurn && !currentTurn.turnStartResult) {
          currentTurn.turnStartResult = frame.result;
          if (typeof frame.result?.turn?.id === "string") {
            currentTurn.turnPlaceholder = frame.result.turn.id;
          }
        } else if (label === "turn/interrupt" && currentTurn) {
          const step = [...currentTurn.steps].reverse().find((s) => s.kind === "await_interrupt");
          if (step) step.responseResult = frame.result ?? {};
        }
      } else if (isServerRequest && currentTurn) {
        currentNotifyStep = null;
        currentTurn.steps.push({ kind: "server_request", frame });
      } else if (isNotification) {
        if (phase === "post_init" && !threadStartResult) {
          postInitializeNotifications.push(frame);
        } else if (phase === "post_thread_start" && turns.length === 0) {
          postThreadStartNotifications.push(frame);
        } else if (phase === "post_resume" && !currentTurn) {
          postThreadResumeNotifications.push(frame);
        } else if (currentTurn) {
          pushTurnNotify(frame);
          if (frame.method === "turn/completed") {
            currentTurn.hasTerminalNotification = true;
          }
        }
      }
    }
  }

  for (const turn of turns) {
    if (!turn.hasTerminalNotification) {
      const snap = latestReadTurnsById.get(turn.turnPlaceholder);
      if (snap) turn.recoveredTurnSnapshot = snap;
    }
  }

  if (!initializeResult || !threadStartResult) {
    throw new Error(`${source}: transcript must include recorded initialize and thread/start responses.`);
  }

  return {
    start,
    entries,
    runtimeExit,
    initializeResult,
    mcpServerStatusResult,
    threadStartResult,
    threadResumeResult,
    mcpResourceReadResult,
    postInitializeNotifications,
    postThreadStartNotifications,
    postThreadResumeNotifications,
    turns,
  };
}
