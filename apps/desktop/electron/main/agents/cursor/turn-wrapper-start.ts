// Slice of the Cursor turn wrapper program (see turn-launcher.ts):
// native start, not-started evidence, and the wrapper's IPC and signal
// handlers.
// The slices concatenate in order into one script run with `node -e` (on
// Windows from an owner-private file); keep each slice's text exactly as the
// wrapper needs it. The operating-system sandbox comes from cursorOsSandbox:
// sandbox-exec on macOS; on Windows Cursor runs without one.

import type { CursorOsSandbox } from "../cursor-sandbox-policy.js";

export function cursorWrapperStartSource(sandbox: CursorOsSandbox = "macos-sandbox-exec"): string {
  const windows = sandbox === "windows-unsandboxed";
  return String.raw`async function start() {
  if (started || finalizing || authorityRetiring) return;
  started = true;
  let authorityProxyPort = null;
  let agentProxyPort = null;
  try {
    await startMcpConnector();
    if (finalizing || authorityRetiring) return;
    authorityProxyPort = await startAuthorityProxy();
    if (finalizing || authorityRetiring) return;
    agentProxyPort = await startAgentProxy();
    if (finalizing || authorityRetiring) return;
  } catch (error) {
    await finishNotStarted("Cursor authority proxy failed: " + (error && error.message ? error.message : String(error)), true);
    return;
  }
  const nativeEnv = { ...process.env };
  // Wrapper-only: packaged Electron needs this to execute the inline Node
  // wrapper, but an Electron-backed Cursor binary must never inherit it.
  delete nativeEnv.ELECTRON_RUN_AS_NODE;
${windows ? String.raw`  // windows-unsandboxed: no operating-system sandbox (owner decision). The
  // room's folder, profile, proxies and MCP connection still bound the turn.
  const sandboxed = false;
  // Cursor starts inside letagents-process-tree.exe's own job (windowsTurn).
  const nativeCommand = windowsTurn.helper;
  Object.assign(nativeEnv, windowsTurn.environment);
` : String.raw`  const sandboxed = !fullAccess && process.platform === "darwin"
    && (restrictRemoteAuthority
      || deniedReadPaths.length > 0
      || deniedReadSubpaths.length > 0
      || deniedReadMetadataPaths.length > 0
      || deniedReadWriteRegexes.length > 0
      || deniedWriteRegexes.length > 0
      || deniedWritePaths.length > 0
      || deniedWriteStructuralPaths.length > 0
      || deniedWriteSubpaths.length > 0
      || allowedWriteSubpaths.length > 0
      || allowedReadSubpaths.length > 0);
  const nativeCommand = sandboxed ? "/usr/bin/sandbox-exec" : bin;
`}  const cursorArgs = authorityProxyPort === null || agentProxyPort === null
    ? args
    : [
      "--endpoint", "http://127.0.0.1:" + authorityProxyPort,
      "--agent-endpoint", "http://127.0.0.1:" + agentProxyPort,
      // This Cursor path consumes its documented auth override only from
      // argv. The value is deliberately non-secret and merely suppresses a
      // credential-store lookup; both proxies replace it before forwarding.
      "--auth-token", publicAuthPlaceholder,
      "--http-version", "1.1",
      ...args,
    ];
  const nativeArgs = sandboxed
    ? [
      "-p",
      [
        "(version 1)",
        "(allow default)",
        ...(restrictRemoteAuthority ? [
          // Cursor queries its own process metadata during startup. Preserve
          // self inspection while denying native/model descendants visibility
          // into wrapper-hosted MCP and future same-UID process environments.
          "(deny process-info* (target others))",
          // Native Cursor and model-directed tools may manage themselves and
          // their own child tools, but must never signal the trusted wrapper
          // or an unrelated same-UID process. Hiding process metadata is not
          // sufficient because a known or inherited PID remains signalable.
          "(deny signal (require-not (require-any (target self) (target children))))",
          // Model-directed helpers inherit file/network rules, but macOS GUI
          // and daemon clients can delegate effects to an unsandboxed service.
          // Block those channels independently of Cursor's command classifier.
          "(deny appleevent-send)",
          // Repo-native binaries can ask launchd to create an unsupervised
          // service without executing the launchctl CLI, so deny the
          // underlying operation as well as the executable path.
          "(deny job-creation)",
          // A mount placed below the writable generation would replace its
          // vnode boundary with unrelated storage. The supervisor owns all
          // generation mounts and file flags; native descendants own neither.
          "(deny file-mount file-unmount)",
          "(deny file-write-flags)",
          // Path-scoped writes are otherwise vulnerable to inode aliases:
          // hard links can mutate an outside/protected path through an allowed
          // workspace pathname. Do not inventory the existing project tree at
          // startup; cheaply prevent the supervised process from creating new
          // aliases instead. APFS clones remain usable inside the repo and
          // still require source-read authority, so the global data-read fence
          // blocks outside imports.
          "(deny file-link)",
          "(deny mach-lookup (global-name \"com.apple.coreservices.appleevents\"))",
          "(deny mach-lookup (global-name \"com.apple.coreservices.launchservicesd\"))",
          "(deny mach-lookup (global-name \"com.apple.launchservices.mapdb\"))",
          "(deny mach-lookup (global-name \"com.apple.pasteboard.1\"))",
          // Executable path denials are not a capability boundary: a
          // repo-native binary can call Security.framework or CFPreferences
          // directly. Fence those host-data brokers at Mach lookup instead.
          "(deny mach-lookup (global-name \"com.apple.SecurityServer\"))",
          "(deny mach-lookup (global-name \"com.apple.cfprefsd.agent\"))",
          "(deny mach-lookup (global-name \"com.apple.cfprefsd.daemon\"))",
          "(deny mach-lookup (global-name \"com.apple.CoreSimulator.CoreSimulatorService\"))",
          "(deny mach-lookup (global-name \"com.apple.CoreSimulator.SimLaunchHost\"))",
          "(deny mach-lookup (global-name \"com.apple.CoreSimulator.SimulatorTrampoline\"))",
          "(deny mach-lookup (global-name \"com.apple.windowserver.active\"))",
          "(deny mach-lookup (global-name \"com.apple.windowserver\"))",
          "(deny mach-lookup (global-name \"com.apple.metadata.mds\"))",
          "(deny mach-lookup (global-name \"com.apple.DiskArbitration.diskarbitrationd\"))",
          // Cursor's headless worker spawns a helper that binds a private
          // stdio socket under its per-turn CURSOR_DATA_DIR (we relocate it
          // there so no ambient /tmp/.cursor worker is reused). A unix-socket
          // listen() is network-inbound, so an absolute inbound deny EPERMs
          // that bind and the worker dies before the MCP client ever connects.
          // Admit inbound binds only for unix sockets under that exact per-turn
          // root; every other inbound (and TCP) stays denied.
          allowedInternalUnixSocketRoots.length > 0
            ? "(deny network-inbound (require-not (require-any "
              + allowedInternalUnixSocketRoots.map((root) =>
                "(local unix-socket (subpath " + JSON.stringify(root) + "))"
              ).join(" ")
              + ")))"
            : "(deny network-inbound)",
          "(deny network-outbound (require-not (require-any "
            + "(remote ip \"localhost:" + authorityProxyPort + "\") "
            + "(remote ip \"localhost:" + agentProxyPort + "\") "
            + allowedNetworkUnixSockets.map((path) =>
              "(remote unix-socket (literal " + JSON.stringify(path) + "))"
            ).join(" ")
            // The worker's own client half connects back to that private
            // socket; permit outbound only to the same per-turn root.
            + allowedInternalUnixSocketRoots.map((root) =>
              " (remote unix-socket (subpath " + JSON.stringify(root) + "))"
            ).join("")
            + ")))",
          ...deniedDelegatingExecutables.map((path) =>
            "(deny process-exec (literal " + JSON.stringify(path) + "))"
          ),
        ] : []),
        ...deniedExecSubpaths.map((path) =>
          "(deny process-exec (subpath " + JSON.stringify(path) + "))"
        ),
        ...(allowedReadSubpaths.length > 0 ? [
          "(deny file-read-data (require-not (require-any "
            + "(literal \"/\") "
            + allowedReadSubpaths.map((path) =>
              "(subpath " + JSON.stringify(path) + ")"
            ).join(" ")
            + ")))",
        ] : []),
        ...(allowedWriteSubpaths.length > 0 ? [
          "(deny file-write* (require-not (require-any "
            + "(literal \"/dev/null\") "
            + allowedWriteSubpaths.map((path) =>
              "(subpath " + JSON.stringify(path) + ")"
            ).join(" ")
            + ")))",
        ] : []),
        ...deniedReadPaths.map((path) =>
          "(deny file-read* (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedReadSubpaths.map((path) =>
          "(deny file-read* (subpath " + JSON.stringify(path) + "))"
        ),
        ...deniedReadMetadataPaths.map((path) =>
          "(deny file-read-metadata (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedReadWriteRegexes.map((pattern) =>
          "(deny file-read* (regex #" + JSON.stringify(pattern) + "))"
        ),
        // The same authority locations are immutable for the complete native
        // process tree. This closes late-create and redirected-download races
        // for hooks, settings, plugins, Statsig gates, and bundled MCPs.
        ...deniedReadPaths.map((path) =>
          "(deny file-write* (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedReadSubpaths.map((path) =>
          "(deny file-write* (subpath " + JSON.stringify(path) + "))"
        ),
        ...deniedReadMetadataPaths.map((path) =>
          "(deny file-write* (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedReadWriteRegexes.map((pattern) =>
          "(deny file-write* (regex #" + JSON.stringify(pattern) + "))"
        ),
        ...deniedWriteRegexes.map((pattern) =>
          "(deny file-write* (regex #" + JSON.stringify(pattern) + "))"
        ),
        ...deniedWritePaths.map((path) =>
          "(deny file-write* (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedWriteStructuralPaths.map((path) =>
          "(deny file-write-unlink (literal " + JSON.stringify(path) + "))"
        ),
        ...deniedWriteSubpaths.map((path) =>
          "(deny file-write* (subpath " + JSON.stringify(path) + "))"
        ),
      ].join("\n"),
      bin,
      ...cursorArgs,
    ]
    : ${windows ? `["spawn", windowsTurn.application, windowsNativeCommandLine(cursorArgs)]` : "cursorArgs"};
  if (finalizing || authorityRetiring) return;
  native = spawn(nativeCommand, nativeArgs, {
    cwd: process.cwd(), env: nativeEnv, stdio: ["ignore", "pipe", "pipe"],
    // The durable wrapper is already a detached group leader. Keep native
    // Cursor and its descendants in that exact, still-live group so a reaped
    // native PID can never be mistaken for later group authority.
    detached: false,${windows ? " windowsHide: true," : ""}
  });${windows ? String.raw`
  nativeHelperBirth = readNativeHelperBirth(native.pid);` : ""}
  native.stdout.on("data", (chunk) => {
    if (statePath && stateFd !== null && persistedBytes < maxPersistedBytes) {
      try {
        const bounded = chunk.subarray(0, Math.max(0, maxPersistedBytes - persistedBytes));
        if (bounded.length) appendFileSync(stateFd, bounded);
        persistedBytes += bounded.length;
      } catch (error) {
        failStreamPersistence(error);
      }
    }
    consumeText(decoder.write(chunk));
  });
  forwardBoundedStderr(native.stderr, "Cursor native process");
  native.once("error", (error) => {
    if (!exitEvidence) {
      exitEvidence = { type: "error", error: error && error.message ? error.message : String(error) };
    }
    exitCode = 1;
    void beginFatalReaping();
    armEvidenceDrainDeadline();
  });
  native.once("exit", (code, signal) => {
    // A containment or protocol failure that initiated reaping is the causal
    // terminal evidence. The resulting native exit must not erase that exact,
    // actionable reason with a generic exit code.
    if (!exitEvidence) {
      exitEvidence = { type: "exit", code, signal };
      exitCode = code === 0 ? 0 : (typeof code === "number" ? code : 1);
    } else if (exitEvidence.type === "error") {
      // A provider that handles our fatal TERM and exits zero must not convert
      // the wrapper's already-recorded protocol/containment failure into a
      // successful or user-stopped attempt lifecycle.
      exitCode = 1;
    }
    // Descendants may hold stdout open. Reaping starts at native exit, while
    // terminal publication waits for close so the final result bytes drain.
    void beginFatalReaping();
    armEvidenceDrainDeadline();
  });
  native.once("close", () => { void finalize(); });
}
async function finishNotStarted(error, calledFromStart = false) {
  if (finalizing) return;
  finalizing = true;
  authorityRetiring = true;
  // A wrapper that never crossed native release still rejects any held request.
  settleMcpCapabilityWaiters(false);
  // First revoke anything already published. Then wait for the in-progress
  // startup continuation to observe the cancellation fence and close again,
  // so a late listen callback cannot outlive not_started evidence.
  try { await closeAuthorityProxy(); } catch {}
  try { await closeMcpConnector(); } catch {}
  if (!calledFromStart && startPromise) {
    try { await startPromise; } catch {}
  }
  let proxyAuthorityRevoked = false;
  let mcpAuthorityRevoked = false;
  try { proxyAuthorityRevoked = await closeAuthorityProxy(); } catch {}
  try { mcpAuthorityRevoked = await closeMcpConnector(); } catch {}
  try { purgePublicPlaceholderCredentialFile(); } catch {}
  const runtimeDataRetired = retireTurnRuntimeData();
  if (stateFd !== null) { try { closeSync(stateFd); } catch {} stateFd = null; }
  try {
    terminal({
      type: "not_started",
      ...(error ? { error } : {}),
      native_process_group_reaped: true,
      reap_scope: "native_process_group",
      remote_authority_revoked: proxyAuthorityRevoked && mcpAuthorityRevoked && runtimeDataRetired,
      remote_authority_failed_checks: [...revocationFailures],
      session_contract_valid: true,
      stream_contract_complete: true,
      workspace_generation_manifest_path: workspaceGenerationManifestPath || null,
      init: null,
      result: null,
    });
  } catch {}
  process.exit(1);
}
process.on("message", (message) => {
  // The stop request where there are no signals (Windows): the same as SIGTERM.
  if (message && message.type === "terminate") { if (native) void beginFatalReaping(); else void finishNotStarted(); return; }
  if (!message || message.type !== "start") return;
  if (restrictRemoteAuthority) {
    if (typeof message.providerAuthorization !== "string"
      || !/^Bearer [^\s\0]{1,16384}$/.test(message.providerAuthorization)) {
      void finishNotStarted("Cursor wrapper received no valid provider authorization proof.");
      return;
    }
    providerAuthorization = message.providerAuthorization;
    try { mcpRuntimeEnv = validatedMcpRuntimeEnv(message.mcpRuntimeEnv); }
    catch { void finishNotStarted("Cursor wrapper received no valid MCP runtime boundary."); return; }
  }
  const pendingStart = start();
  startPromise = pendingStart;
  void pendingStart.catch((error) => finishNotStarted(
    "Cursor wrapper startup failed: " + (error && error.message ? error.message : String(error)),
    true,
  )).finally(() => {
    if (startPromise === pendingStart) startPromise = null;
  });
});
process.on("disconnect", () => {
  if (native) return;
  void finishNotStarted();
});
process.on("SIGTERM", () => { if (native) void beginFatalReaping(); else void finishNotStarted(); });
process.on("SIGINT", () => { if (native) void beginFatalReaping(); else void finishNotStarted(); });
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
if (process.send) process.send({ type: "prepared" });
`;
}
