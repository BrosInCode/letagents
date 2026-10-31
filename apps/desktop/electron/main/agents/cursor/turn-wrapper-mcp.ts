// Slice of the Cursor turn wrapper program (see turn-launcher.ts):
// the wrapper-hosted MCP connector, credential and runtime-data purges, and
// authority retirement.
// The slices concatenate in order into one script run with `node -e` (on
// Windows from an owner-private file); keep each slice's text exactly as the
// wrapper needs it. Windows-only text is chosen by `platform`.

export function cursorWrapperMcpSource(platform: NodeJS.Platform = process.platform): string {
  const windows = platform === "win32";
  // Windows reports a killed runtime's exit later. Most exits arrive in this
  // wait, which stays under the evidence deadline of 3 s, and then its folder goes too.
  const killWaitMs = windows ? 2000 : 500;
  return String.raw`async function closeMcpConnector() {
  if (mcpCapabilityDeadline) clearTimeout(mcpCapabilityDeadline);
  mcpCapabilityDeadline = null;
  let runtimeClosed = true;
  let runtimeGroupClosed = true;
  const runtime = mcpRuntime;
  let groupMembers = null;
  let signalRuntimeGroup = null;
  let termSignaled = false;
${windows ? "  let runtimeTerminated = false;\n" : ""}  if (runtime) {
    const runtimeGroupId = runtime.pid;
    runtimeClosed = runtime.exitCode !== null || runtime.signalCode !== null;
    runtime.once("exit", () => { runtimeClosed = true; });
    runtime.once("error", () => { runtimeClosed = true; });
    if (process.platform === "win32") {
      runtimeGroupClosed = runtimeClosed;
      // No signals on Windows: any kill ends the runtime at once. Closing its
      // stdin (below) is the stop request; only the escalation kills it.
      signalRuntimeGroup = (signal) => {
        if (signal !== "SIGKILL") return false;
        try { ${windows ? "runtimeTerminated = runtime.kill(signal) === true;" : "runtime.kill(signal);"} } catch {}
        return true;
      };
    } else if (Number.isSafeInteger(runtimeGroupId) && runtimeGroupId > 1) {
      groupMembers = () => processGroupMembers(runtimeGroupId);
      signalRuntimeGroup = (signal) => {
        if (!runtimeGroupSignalAuthorized
          || typeof mcpRuntimeProcessIdentity !== "string") {
          runtimeGroupSignalAuthorized = false;
          return false;
        }
        const currentIdentity = exactProcessGroupLeaderIdentity(runtimeGroupId, process.pid);
        if (currentIdentity === undefined) return false;
        if (currentIdentity !== mcpRuntimeProcessIdentity) {
          runtimeGroupSignalAuthorized = false;
          return false;
        }
        try { process.kill(-runtimeGroupId, signal); }
        catch (error) {
          // EPERM is not proof of absence. Keep polling the exact PGID below and
          // return false unless both the runtime and every group member vanish.
          if (error && (error.code === "ESRCH" || error.code === "EPERM")) return true;
          throw error;
        }
        return true;
      };
      // Re-prove the captured leader's birth and ancestry inside every signal
      // attempt, including escalation. POSIX offers no atomic identity+signal
      // primitive here, so this minimizes—but cannot erase—the final syscall
      // race. An absent or changed leader permanently revokes signal authority.
      // An unavailable probe sends no signal and can retry within the deadline.
      if (!runtimeClosed && runtimeGroupSignalAuthorized) termSignaled = signalRuntimeGroup("SIGTERM");
    }
  }
  if (mcpConnectorServer) { try { mcpConnectorServer.close(); } catch {} }
  mcpConnectorServer = null;
  let socketClosed = true;
  if (mcpConnectorSocket && !mcpConnectorSocket.destroyed) {
    socketClosed = false;
    mcpConnectorSocket.once("close", () => { socketClosed = true; });
    try { mcpConnectorSocket.destroy(); } catch {}
  }
  if (runtime) {
    try { runtime.stdin.end(); } catch {}
    // Escalate a still-live exact runtime before enumerating the whole process
    // table. A slow membership probe must not strand a TERM-resistant runtime;
    // the unchanged birth/ancestry check still fences every signal attempt.
    const graceDeadline = Date.now() + 500;
    while (!runtimeClosed && Date.now() < graceDeadline) {
      if (!termSignaled && signalRuntimeGroup
        && (process.platform === "win32" || runtimeGroupSignalAuthorized)) {
        termSignaled = signalRuntimeGroup("SIGTERM");
      }
      await wait(25);
    }
    const killDeadline = Math.max(Date.now(), graceDeadline) + ${killWaitMs};
    while (!runtimeClosed && Date.now() < killDeadline
      && signalRuntimeGroup
      && (process.platform === "win32" || runtimeGroupSignalAuthorized)) {
      if (signalRuntimeGroup("SIGKILL")) break;
      await wait(25);
    }
    // Exit alone does not prove descendant retirement. Require a successful
    // empty-group observation, and never let an ambiguous/empty observation
    // authorize a later cleanup call to signal a recycled numeric PGID.
    do {
      if (process.platform === "win32") {
        runtimeGroupClosed = runtimeClosed;
      } else {
        const members = groupMembers ? groupMembers() : null;
        runtimeGroupClosed = members !== null && members.length === 0;
        if (members === null || runtimeGroupClosed) runtimeGroupSignalAuthorized = false;
      }
      if (runtimeClosed && runtimeGroupClosed) break;
      await wait(25);
    } while (Date.now() < killDeadline);
${windows ? String.raw`    // Windows said the kill succeeded, so the runtime runs no more of its code.
    // It may report its exit seconds later under CPU load.
    if (runtimeTerminated) runtimeClosed = true;
    runtimeGroupClosed = runtimeClosed;
` : ""}  }
  const socketDeadline = Date.now() + 500;
  while (!socketClosed && Date.now() < socketDeadline) await wait(5);
  const revoked = socketClosed && runtimeClosed && runtimeGroupClosed;
  noteRevocation("mcp_socket", !socketClosed);
  noteRevocation("mcp_runtime", !runtimeClosed);
  noteRevocation("mcp_runtime_group", !runtimeGroupClosed);
  if (socketClosed) mcpConnectorSocket = null;
  // Preserve ambiguous runtime evidence across repeated close attempts. Some
  // not-started paths deliberately call close twice around an in-flight start;
  // forgetting a non-retired group here would let the second call falsely
  // report that all remote authority was revoked.
  if (runtimeClosed && runtimeGroupClosed) {
    mcpRuntime = null;
    mcpRuntimeProcessIdentity = null;
  }
  const connectorRoot = path.dirname(mcpConnectorSocketPath || "");
  if (revoked && mcpConnectorRootPattern.test(connectorRoot)) {
    ${windows ? "// A killed runtime can still hold its files open here; the folder stays private.\n    try { rmSync(connectorRoot, { recursive: true, force: true }); } catch {}" : "rmSync(connectorRoot, { recursive: true, force: true });"}
  }
  return revoked;
}
function purgePublicPlaceholderCredentialFile() {
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) throw new Error("missing private HOME");
  const credentialPath = path.join(home, ".cursor", "auth.json");
  let stat;
  try { stat = lstatSync(credentialPath); }
  catch (error) { if (error && error.code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("unexpected Cursor credential file");
  const parsed = JSON.parse(readFileSync(credentialPath, "utf8"));
  const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).sort() : [];
  if (keys.length !== 2 || keys[0] !== "accessToken" || keys[1] !== "refreshToken"
    || parsed.accessToken !== publicAuthPlaceholder || parsed.refreshToken !== publicAuthPlaceholder) {
    throw new Error("Cursor credential file contains unexpected authority");
  }
  unlinkSync(credentialPath);
}
function purgeTurnRuntimeDataRoot() {
  if (!restrictRemoteAuthority) return true;
  const root = process.env.CURSOR_DATA_DIR;
  if (typeof root !== "string"
    || ${windows
    ? String.raw`path.dirname(root) !== windowsTurn.temporaryRoot
    || !/^letagents-cursor-data-[A-Za-z0-9]{6}$/.test(path.basename(root))) {`
    : String.raw`!/^\/(?:private\/)?tmp\/letagents-cursor-data-[A-Za-z0-9]{6}$/.test(root)) {`}
    throw new Error("unexpected Cursor turn data root");
  }
  let stat;
  try { stat = lstatSync(root); }
  catch (error) { if (error && error.code === "ENOENT") return true; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("redirected Cursor turn data root");
  }
  rmSync(root, { recursive: true, force: true });
  try { lstatSync(root); }
  catch (error) { if (error && error.code === "ENOENT") return true; throw error; }
  throw new Error("Cursor turn data root survived retirement");
}
function validatedMcpRuntimeEnv(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("missing MCP runtime environment");
  const allowed = new Set(${JSON.stringify([
    "ELECTRON_RUN_AS_NODE", "LETAGENTS_API_URL", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "XDG_CACHE_HOME", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "NODE_COMPILE_CACHE", "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN", "LETAGENTS_SUPERVISOR_ENTRY_ID", "LETAGENTS_SUPERVISOR_DAEMON_SOCKET",
    "LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID", "LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID",
    "LETAGENTS_SUPERVISOR_PROVIDER", "LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID",
    "LETAGENTS_SUPERVISOR_AGENT_SESSION_ID", "LETAGENTS_SUPERVISOR_ROOM_ID",
    "LETAGENTS_SUPERVISOR_AGENT_DISPLAY_NAME", "LETAGENTS_SUPERVISED_BOUNDED_TURNS",
    "LETAGENTS_EXECUTION_PROFILE", "LETAGENTS_PERMISSION_PROFILE_ID",
    // Windows: home folders inside the connector root, and the daemon's state
    // folder, where the MCP runtime finds the daemon pipe's proof.
    ...(windows ? ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "LETAGENTS_SUPERVISOR_DAEMON_STATE_DIR"] : []),
  ])});
  const result = {};
  const entries = Object.entries(value);
  if (entries.length > allowed.size) throw new Error("oversized MCP runtime environment");
  for (const [key, entry] of entries) {
    if (!allowed.has(key) || typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry, "utf8") > 16 * 1024) {
      throw new Error("invalid MCP runtime environment");
    }
    result[key] = entry;
  }
  const required = [
    "LETAGENTS_API_URL", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "NODE_COMPILE_CACHE", "LETAGENTS_SUPERVISOR_ENTRY_ID",
    "LETAGENTS_SUPERVISOR_DAEMON_SOCKET", "LETAGENTS_SUPERVISOR_WORK_ATTEMPT_ID",
    "LETAGENTS_SUPERVISOR_EXECUTION_GENERATION_ID", "LETAGENTS_SUPERVISOR_PROVIDER_TURN_ID",
    "LETAGENTS_SUPERVISOR_AGENT_SESSION_ID", "LETAGENTS_SUPERVISOR_ROOM_ID",
    "LETAGENTS_PERMISSION_PROFILE_ID",
  ];
  if (required.some((key) => !result[key])
    || result.ELECTRON_RUN_AS_NODE !== "1"
    || result.LETAGENTS_SUPERVISOR_PROVIDER !== "cursor"
    || result.LETAGENTS_SUPERVISED_BOUNDED_TURNS !== "1"
    || result.LETAGENTS_EXECUTION_PROFILE !== "supervised_room_turn"
    || !["read_only", "sandboxed_write", "full_access"].includes(result.LETAGENTS_PERMISSION_PROFILE_ID)
    || result.CURSOR_API_KEY !== ""
    || result.CURSOR_AUTH_TOKEN !== "") {
    throw new Error("incomplete MCP runtime environment");
  }
  return result;
}
function hasRequiredCompletionContract(response) {
  const tools = response && response.result && response.result.tools;
  if (!Array.isArray(tools)) return false;
  const matches = tools.filter((tool) => tool && tool.name === "complete_room_turn");
  if (matches.length !== 1) return false;
  const schema = matches[0].inputSchema;
  const properties = schema && schema.properties;
  const outcome = properties && properties.outcome;
  const text = properties && properties.text;
  return schema && typeof schema === "object" && !Array.isArray(schema)
    && schema.type === "object"
    && properties && typeof properties === "object" && !Array.isArray(properties)
    && outcome && typeof outcome === "object" && !Array.isArray(outcome)
    && outcome.type === "string"
    && Array.isArray(outcome.enum)
    && outcome.enum.length === 2
    && new Set(outcome.enum).size === 2
    && outcome.enum.includes("reply")
    && outcome.enum.includes("no_reply")
    && text && typeof text === "object" && !Array.isArray(text)
    && text.type === "string"
    && Array.isArray(schema.required)
    && schema.required.length === 1
    && schema.required[0] === "outcome";
}
// The wrapper hosts the MCP runtime itself, so it proves the complete_room_turn
// contract with its own bounded initialize/tools/list handshake before Cursor
// is launched. Attestation must never wait for the client's tools/list: Cursor
// defers tool listing until its agent bootstrap succeeds, and that bootstrap is
// exactly what the authority hold suspends, so gating model authority on client
// traffic deadlocks every supervised turn against its own hold.
function verifyHostedMcpRuntimeContract(runtime) {
  return new Promise((resolve, reject) => {
    const initializeId = "letagents-attest-init-" + randomUUID();
    const listId = "letagents-attest-tools-" + randomUUID();
    let inspectionBuffer = Buffer.alloc(0);
    let inspectionBytes = 0;
    let inspectionFrames = 0;
    const maxInspectionBytes = 1024 * 1024;
    const maxInspectionFrames = 256;
    let settled = false;
    let deadline = null;
    const finish = (error, leftover) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      deadline = null;
      runtime.stdout.removeListener("data", onData);
      runtime.removeListener("error", onRuntimeError);
      runtime.removeListener("close", onRuntimeClose);
      // Any bytes the runtime pipelined after the attested tools/list response
      // belong to the client stream; return them unconsumed for the connector.
      if (!error && leftover && leftover.length > 0) runtime.stdout.unshift(leftover);
      if (error) reject(error); else resolve();
    };
    const onRuntimeError = () => finish(new Error("Cursor's live MCP runtime failed before capability attestation."));
    const onRuntimeClose = () => finish(new Error("Cursor's live MCP runtime ended before capability attestation."));
    const onData = (chunk) => {
      if (settled) return;
      inspectionBytes += chunk.length;
      if (inspectionBytes > maxInspectionBytes) {
        finish(new Error("Cursor's live MCP runtime exceeded the bounded capability-attestation exchange."));
        return;
      }
      inspectionBuffer = Buffer.concat([inspectionBuffer, chunk]);
      for (;;) {
        const newline = inspectionBuffer.indexOf(10);
        if (newline < 0) break;
        inspectionFrames += 1;
        if (inspectionFrames > maxInspectionFrames) {
          finish(new Error("Cursor's live MCP runtime exceeded the bounded capability-attestation exchange."));
          return;
        }
        const line = inspectionBuffer.subarray(0, newline).toString("utf8").trim();
        inspectionBuffer = inspectionBuffer.subarray(newline + 1);
        if (!line) continue;
        let response;
        try { response = JSON.parse(line); }
        catch {
          finish(new Error("Cursor's live MCP runtime emitted invalid capability-attestation protocol."));
          return;
        }
        // Startup notifications from the runtime are legitimate protocol; only
        // the wrapper's own request ids participate in attestation.
        if (!response || (response.id !== initializeId && response.id !== listId)) continue;
        if (response.id === initializeId) {
          try {
            runtime.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            runtime.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: listId, method: "tools/list", params: {} }) + "\n");
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          continue;
        }
        if (!hasRequiredCompletionContract(response)) {
          finish(new Error("Cursor's live MCP runtime does not expose the required complete_room_turn contract."));
          return;
        }
        finish(null, inspectionBuffer);
        return;
      }
    };
    deadline = setTimeout(() => {
      finish(new Error("Cursor's hosted MCP runtime did not prove the complete_room_turn contract before launch."));
    }, mcpCapabilityTimeoutMs);
    runtime.stdout.on("data", onData);
    runtime.once("error", onRuntimeError);
    runtime.once("close", onRuntimeClose);
    try {
      runtime.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: initializeId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "letagents-cursor-turn-wrapper", version: "1.0.0" },
        },
      }) + "\n");
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
function startMcpConnector() {
  if (!restrictRemoteAuthority) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const failStart = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const connectorRoot = path.dirname(mcpConnectorSocketPath);
${windows ? String.raw`    // Windows: the socket path names the turn; the wrapper listens on its pipe.
    if (!mcpConnectorRootPattern.test(connectorRoot)
      || mcpConnectorSocketPath !== path.join(connectorRoot, "stdio.sock")
      || mcpConnectorSocketPath.includes("\0")
      || !/^\\\\[.]\\pipe\\letagents-cursor-mcp-[0-9a-f]{32}$/.test(windowsTurn.connectorListenPath)
      || !path.isAbsolute(mcpRuntimeEntryPath)
      || !path.isAbsolute(mcpRuntimeCwd)) {` : String.raw`    if (!mcpConnectorRootPattern.test(connectorRoot)
      || mcpConnectorSocketPath !== connectorRoot + "/stdio.sock"
      || mcpConnectorSocketPath.includes("\0")
      || Buffer.byteLength(mcpConnectorSocketPath, "utf8") > 100
      || !mcpRuntimeEntryPath.startsWith("/")
      || !mcpRuntimeCwd.startsWith("/")) {`}
      failStart(new Error("invalid MCP connector boundary"));
      return;
    }
    const expectedRuntimePaths = ${windows ? String.raw`{
      HOME: path.join(connectorRoot, "home"),
      XDG_CONFIG_HOME: path.join(connectorRoot, "config"),
      XDG_DATA_HOME: path.join(connectorRoot, "data"),
      XDG_CACHE_HOME: path.join(connectorRoot, "cache"),
      CURSOR_CONFIG_DIR: path.join(connectorRoot, "config", "cursor"),
      CURSOR_DATA_DIR: path.join(connectorRoot, "data", "cursor"),
      NODE_COMPILE_CACHE: path.join(connectorRoot, "cache", "node-compile-cache"),
      USERPROFILE: path.join(connectorRoot, "home"),
      APPDATA: path.join(connectorRoot, "home", "AppData", "Roaming"),
      LOCALAPPDATA: path.join(connectorRoot, "home", "AppData", "Local"),
    };` : String.raw`{
      HOME: connectorRoot + "/home",
      XDG_CONFIG_HOME: connectorRoot + "/config",
      XDG_DATA_HOME: connectorRoot + "/data",
      XDG_CACHE_HOME: connectorRoot + "/cache",
      CURSOR_CONFIG_DIR: connectorRoot + "/config/cursor",
      CURSOR_DATA_DIR: connectorRoot + "/data/cursor",
      NODE_COMPILE_CACHE: connectorRoot + "/cache/node-compile-cache",
    };`}
    if (Object.entries(expectedRuntimePaths).some(([key, value]) => mcpRuntimeEnv[key] !== value)) {
      failStart(new Error("MCP runtime state escaped its private connector root"));
      return;
    }
    try {
${windows ? String.raw`      // Windows: main created this folder private (inheritable DACL) before
      // the wrapper started; the folders below inherit that DACL.
      const connectorRootStat = lstatSync(connectorRoot);
      if (!connectorRootStat.isDirectory() || connectorRootStat.isSymbolicLink()) {
        throw new Error("redirected MCP connector root");
      }
      // The secret Cursor's pipe connector must send first (windowsProveConnector).
      windowsConnectorProof = readFileSync(path.join(connectorRoot, "connector.proof"), "utf8").trim();
      if (!/^[0-9a-f]{64}$/.test(windowsConnectorProof)) throw new Error("invalid MCP connector proof");
      // The connector sends the proof only to a pipe this process serves.
      writeFileSync(path.join(connectorRoot, "connector.server"), String(process.pid), { flag: "wx" });
      for (const directory of [expectedRuntimePaths.USERPROFILE, expectedRuntimePaths.APPDATA, expectedRuntimePaths.LOCALAPPDATA]) {
        mkdirSync(directory, { recursive: true });
      }` : String.raw`      mkdirSync(connectorRoot, { mode: 0o700 });`}
      for (const directory of [
        expectedRuntimePaths.HOME,
        expectedRuntimePaths.XDG_CONFIG_HOME,
        expectedRuntimePaths.XDG_DATA_HOME,
        expectedRuntimePaths.XDG_CACHE_HOME,
        expectedRuntimePaths.CURSOR_CONFIG_DIR,
        expectedRuntimePaths.CURSOR_DATA_DIR,
        expectedRuntimePaths.NODE_COMPILE_CACHE,
      ]) mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      void closeMcpConnector();
      failStart(error);
      return;
    }
    const runtime = spawn(process.execPath, [mcpRuntimeEntryPath], {
      cwd: mcpRuntimeCwd,
      env: ${windows ? String.raw`{
        // Windows programs need these system variables (Winsock reads SystemRoot);
        // the validated runtime environment decides everything else.
        ...Object.fromEntries(["SystemRoot", "windir", "SystemDrive", "TEMP", "TMP", "PATHEXT"]
          .filter((key) => typeof process.env[key] === "string")
          .map((key) => [key, process.env[key]])),
        ...mcpRuntimeEnv,
      },
      windowsHide: true,` : "mcpRuntimeEnv,"}
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    mcpRuntime = runtime;
    mcpRuntimeProcessIdentity = exactProcessGroupLeaderIdentity(runtime.pid, process.pid);
    runtimeGroupSignalAuthorized = typeof mcpRuntimeProcessIdentity === "string";
    if (process.platform !== "win32" && typeof mcpRuntimeProcessIdentity !== "string") {
      const detail = "Cursor's hosted MCP runtime did not expose an exact process-group birth identity.";
      try { runtime.kill("SIGTERM"); } catch {}
      failMcpCapabilityAttestation(detail);
      failStart(new Error(detail));
      return;
    }
    forwardBoundedStderr(runtime.stderr, "Cursor's hosted MCP runtime");
    verifyHostedMcpRuntimeContract(runtime).then(() => {
      if (finalizing || authorityRetiring) {
        failStart(new Error("Cursor MCP connector startup was cancelled."));
        return;
      }
      runtime.once("error", () => {
        failMcpCapabilityAttestation("Cursor's live MCP runtime failed before the turn became terminal.");
        if (mcpConnectorSocket) { try { mcpConnectorSocket.destroy(); } catch {} }
      });
      runtime.once("close", () => {
        failMcpCapabilityAttestation("Cursor's live MCP runtime ended before the turn became terminal.");
        if (mcpConnectorSocket) { try { mcpConnectorSocket.destroy(); } catch {} }
      });
      const server = net.createServer({ allowHalfOpen: false }, ${windows ? "(pending) => windowsProveConnector(pending, (socket) => {" : "(socket) => {"}
        if (finalizing || authorityRetiring || mcpConnectorAdmitted) { socket.destroy(); return; }
        mcpConnectorAdmitted = true;
        mcpConnectorSocket = socket;
        // Cursor initializes MCP before it can execute model-directed code. One
        // accepted stdio connection prevents a later native/escaped process from
        // replaying this otherwise-readable connector path.
        server.close();
        if (runtime.exitCode !== null || runtime.signalCode !== null) {
          failMcpCapabilityAttestation("Cursor's live MCP runtime ended before the turn became terminal.");
          socket.destroy();
          return;
        }
        // The hosted runtime proved the completion contract before this
        // listener opened, so Cursor reaching the connector is the remaining
        // live evidence. Admit held model authority on the channel itself --
        // never on later client traffic, which the hold would deadlock.
        mcpCapabilityAttested = true;
        if (mcpCapabilityDeadline) clearTimeout(mcpCapabilityDeadline);
        mcpCapabilityDeadline = null;
        settleMcpCapabilityWaiters(true);
        socket.pipe(runtime.stdin);
        runtime.stdout.pipe(socket);
        socket.once("error", () => {
          failMcpCapabilityAttestation("Cursor's live MCP connector failed before the turn became terminal.");
          try { runtime.kill("SIGTERM"); } catch {}
        });
        socket.once("close", () => {
          failMcpCapabilityAttestation("Cursor's live MCP connector ended before the turn became terminal.");
          try { runtime.stdin.end(); } catch {}
        });
      }${windows ? ")" : ""});
      mcpConnectorServer = server;
      server.once("error", failStart);
      server.once("close", () => {
        if (!settled && (finalizing || authorityRetiring)) {
          failStart(new Error("Cursor MCP connector startup was cancelled."));
        }
      });
      server.listen(${windows ? "windowsTurn.connectorListenPath" : "mcpConnectorSocketPath"}, async () => {
        await waitAtTestStartupBarrier("mcp_listen");
        if (finalizing || authorityRetiring) {
          try { server.close(); } catch {}
          failStart(new Error("Cursor MCP connector startup was cancelled."));
          return;
        }
${windows ? String.raw`        // Cursor starts only once the pipe admits this user alone.
        try { await windowsSealConnectorPipe(windowsTurn.connectorListenPath); }
        catch (error) { void closeMcpConnector(); failStart(error); return; }
        if (finalizing || authorityRetiring) {
          try { server.close(); } catch {}
          failStart(new Error("Cursor MCP connector startup was cancelled."));
          return;
        }
` : ""}        server.removeListener("error", failStart);
${windows ? String.raw`        // A named pipe has no file mode; see cursorMcpConnectorListenPath.
` : String.raw`        try { chmodSync(mcpConnectorSocketPath, 0o600); }
        catch (error) { void closeMcpConnector(); failStart(error); return; }
`}        mcpCapabilityDeadline = setTimeout(() => {
          failMcpCapabilityAttestation("Cursor never connected the attested MCP runtime before model authority.");
        }, mcpCapabilityTimeoutMs);
        settled = true;
        server.on("error", (error) => {
          const detail = "Cursor MCP connector failed: " + (error && error.message ? error.message : String(error));
          if (!native) { finishNotStarted(detail); return; }
          if (!exitEvidence) exitEvidence = { type: "error", error: detail };
          exitCode = 1;
          void beginFatalReaping();
        });
        resolve();
      });
    }, (error) => {
      const detail = error && error.message ? error.message : String(error);
      try { runtime.kill("SIGTERM"); } catch {}
      failMcpCapabilityAttestation(detail);
      failStart(error instanceof Error ? error : new Error(detail));
    });
  });
}
async function closeAuthorityProxy() {
  if (authorityProxy) {
    try { authorityProxy.close(); } catch {}
    try { authorityProxy.closeAllConnections(); } catch {}
  }
  if (agentProxy) { try { agentProxy.close(); } catch {} }
  for (const server of agentProxyInternalServers) {
    try { server.close(); } catch {}
    try { server.closeAllConnections(); } catch {}
  }
  agentProxyInternalServers.clear();
  for (const upstream of authorityProxyUpstreams) { try { upstream.destroy(); } catch {} }
  for (const stream of agentProxyUpstreamStreams) {
    try { stream.close(http2.constants.NGHTTP2_CANCEL); } catch {}
    try { stream.destroy(); } catch {}
  }
  for (const session of agentProxyUpstreamSessions) { try { session.destroy(); } catch {} }
  for (const socket of authorityProxySockets) { try { socket.destroy(); } catch {} }
  for (const session of agentProxySessions) { try { session.destroy(); } catch {} }
  for (const socket of agentProxySockets) { try { socket.destroy(); } catch {} }
  const deadline = Date.now() + 500;
  while (Date.now() < deadline && (
    authorityProxyUpstreams.size > 0
    || agentProxyUpstreamStreams.size > 0
    || agentProxyUpstreamSessions.size > 0
    || authorityProxySockets.size > 0
    || agentProxySessions.size > 0
    || agentProxySockets.size > 0
  )) await wait(5);
  const revoked = authorityProxyUpstreams.size === 0
    && agentProxyUpstreamStreams.size === 0
    && agentProxyUpstreamSessions.size === 0
    && authorityProxySockets.size === 0
    && agentProxySessions.size === 0
    && agentProxySockets.size === 0;
  noteRevocation("proxy_sockets", !revoked);
  authorityProxy = null;
  agentProxy = null;
  return revoked;
}
function beginTurnAuthorityRetirement() {
  authorityRetiring = true;
  // Any request still held for attestation can never be admitted once authority
  // is retiring; release them all as rejected so none outlives the turn.
  settleMcpCapabilityWaiters(false);
  if (!authorityRetirementPromise) {
    authorityRetirementPromise = (async () => {
      // Invoke both closures before the first await. This synchronously closes
      // every listener/socket and signals the detached MCP runtime before any
      // native-controlled cleanup or process-group escalation can block us.
      const proxyRetirement = closeAuthorityProxy().catch(() => {
        if (!exitEvidence) {
          exitEvidence = { type: "error", error: "Cursor authority proxies could not be retired." };
        }
        exitCode = 1;
        streamContractComplete = false;
        return false;
      });
      const mcpRetirement = closeMcpConnector().catch(() => {
        if (!exitEvidence) {
          exitEvidence = { type: "error", error: "Cursor MCP connector could not be retired." };
        }
        exitCode = 1;
        streamContractComplete = false;
        return false;
      });
      const [proxyAuthorityRevoked, mcpAuthorityRevoked] = await Promise.all([
        proxyRetirement,
        mcpRetirement,
      ]);
      return { proxyAuthorityRevoked, mcpAuthorityRevoked };
    })();
  }
  return authorityRetirementPromise;
}
function retireTurnRuntimeData() {
  try { runtimeDataRetirementResult = purgeTurnRuntimeDataRoot(); noteRevocation("runtime_data", false); }
  catch {
    runtimeDataRetirementResult = false;
    noteRevocation("runtime_data", true);
    if (!exitEvidence) {
      exitEvidence = { type: "error", error: "Cursor's private turn data root could not be retired safely." };
    }
    exitCode = 1;
    streamContractComplete = false;
  }
  return runtimeDataRetirementResult;
}
function denyControlPlaneRequest(request, response) {
  request.resume();
  response.writeHead(503, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "connection": "close",
  });
  response.end("Cursor remote authority is disabled for this supervised turn.");
}
`;
}
