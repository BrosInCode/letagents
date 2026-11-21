/**
 * Strict Format 1 OpenCode replay transcript parser.
 * Matches `parseProviderReplayTranscript`: requires `transcript_start` on line 1,
 * valid entry kinds on every line, and a terminating `runtime_exit` entry.
 */
export function parseOpenCodeEdgeTranscript(text, source = "open-model-transcript") {
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
    start.provider !== "open-model" ||
    typeof start.protocol !== "string" ||
    typeof start.providerVersion !== "string" ||
    typeof start.scenario !== "string"
  ) {
    throw new Error(`${source}:1: invalid transcript_start header for open-model.`);
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

  let healthResponse = null;
  let createSessionResponse = null;
  const turns = [];
  let currentTurn = null;
  let currentPhase = null;

  const ensureTurnPhase = () => {
    if (!currentPhase) {
      currentPhase = { kind: "sse", events: [] };
      currentTurn.steps.push(currentPhase);
    }
  };

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.type === "runtime_exit") break;
    const frame = entry.frame;
    if (entry.type === "emit_inbound" && frame.kind === "http") {
      if (frame.method === "GET" && frame.path === "/global/health" && !healthResponse) {
        healthResponse = { status: frame.status ?? 200, body: frame.body };
      } else if (frame.method === "POST" && frame.path === "/session" && !createSessionResponse) {
        createSessionResponse = { status: frame.status ?? 200, body: frame.body };
      } else if (currentTurn && frame.method === "POST" && typeof frame.path === "string") {
        if (frame.path.endsWith("/prompt_async") && !currentTurn.promptResponse) {
          currentTurn.promptResponse = { status: frame.status ?? 204, body: frame.body ?? null };
        } else if (frame.path.endsWith("/abort")) {
          const abortStep = [...currentTurn.steps].reverse().find((s) => s.kind === "await_abort");
          if (abortStep) abortStep.response = { status: frame.status ?? 200, body: frame.body ?? true };
        } else if (/\/permission\/[^/]+\/reply$/.test(frame.path)) {
          const permStep = [...currentTurn.steps].reverse().find((s) => s.kind === "await_permission");
          if (permStep) permStep.response = { status: frame.status ?? 200, body: frame.body ?? true };
        }
      }
      continue;
    }

    if (entry.type === "expect_outbound") {
      const pathStr = typeof frame.path === "string" ? frame.path.split("?")[0] : "";
      if (frame.method === "POST" && pathStr.endsWith("/prompt_async")) {
        const turnPlaceholder = typeof frame.body?.messageID === "string" ? frame.body.messageID : `<turn-${turns.length + 1}>`;
        currentTurn = {
          turnIndex: turns.length + 1,
          turnPlaceholder,
          promptResponse: null,
          steps: [],
        };
        currentPhase = null;
        turns.push(currentTurn);
      } else if (currentTurn && frame.method === "POST" && /\/permission\/([^/]+)\/reply$/.test(pathStr)) {
        const match = /\/permission\/([^/]+)\/reply$/.exec(pathStr);
        currentPhase = null;
        currentTurn.steps.push({
          kind: "await_permission",
          permPlaceholder: match[1],
          expectedReply: typeof frame.body?.reply === "string" ? frame.body.reply : "once",
          response: { status: 200, body: true },
        });
      } else if (currentTurn && frame.method === "POST" && pathStr.endsWith("/abort")) {
        currentPhase = null;
        currentTurn.steps.push({
          kind: "await_abort",
          response: { status: 200, body: true },
        });
      }
      continue;
    }

    if (entry.type === "emit_inbound" && frame.kind === "sse" && currentTurn && frame.event) {
      ensureTurnPhase();
      currentPhase.events.push(frame.event);
    }
  }

  if (!healthResponse || !createSessionResponse) {
    throw new Error(`${source}: transcript must include recorded /global/health and POST /session responses.`);
  }
  return { start, entries, runtimeExit, healthResponse, createSessionResponse, turns };
}
