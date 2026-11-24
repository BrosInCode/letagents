# Electron fuses: hardening plan

Status: step 0 is built (fuse policy in `apps/desktop/electron/scripts/electron-fuses.mjs`). Steps 1-5 are plans only.

## Why

Desktop 0.1.143 shipped every Electron fuse at its default. `kill -USR1 <app pid>` opened a Node inspector on 127.0.0.1:9229 in the signed app, so any local process could run code with the app's identity: its keychain items, its TCC grants, and its signed-in session. The main app is signed with `com.apple.security.cs.disable-library-validation`, so code that runs as LetAgents can also load any unsigned native library.

## Step 0 (built): inspector fuse off, daemon without SIGUSR1

| Fuse | Packaged value | Reason |
|------|----------------|--------|
| RunAsNode | on | The daemon, the MCP servers and the Open Model runtime run on the app binary with `ELECTRON_RUN_AS_NODE=1`. |
| EnableCookieEncryption | off | Electron default; turning it on is one-way. See step 5. |
| EnableNodeOptionsEnvironmentVariable | on | Off also removes `NODE_EXTRA_CA_CERTS`. See step 2. |
| EnableNodeCliInspectArguments | **off** | Nothing in a packaged build uses SIGUSR1 or `--inspect`. |
| EnableEmbeddedAsarIntegrityValidation | off | The app is a folder, not an asar. See step 3. |
| OnlyLoadAppFromAsar | off | Same. |
| LoadBrowserProcessSpecificV8Snapshot | off | Electron default; not used. |
| GrantFileProtocolExtraPrivileges | on | The renderer loads from `file://`. See step 4. |
| WasmTrapHandlers | on | Electron default. |

Measured on Electron 42.11.16 (Node 24.19.0) with the fuses flipped:

1. The main process strips `--inspect=…` and opens no debugger on SIGUSR1. Node no longer handles that signal there, so SIGUSR1 now ends the app (the signal's default action); a JavaScript `process.on("SIGUSR1")` handler does not change that. Any local process can already end the app with SIGKILL, so this adds no new power, but `kill -USR1` is no longer a way to debug a packaged app.
2. The inspector fuse does not reach `ELECTRON_RUN_AS_NODE` processes. SIGUSR1 still opens 9229 there, and `--inspect` still works. Node's `--disable-sigusr1` flag stops it, and the process keeps running. The supervisor daemon now starts with that flag; the MCP servers do not yet (step 1).
3. With the NODE_OPTIONS fuse off, Electron deletes `NODE_OPTIONS` and `NODE_EXTRA_CA_CERTS` from the main process environment at startup. Every child (the daemon, the MCP servers, and the provider CLIs the daemon starts) then runs without them. Electron sets `NODE_USE_SYSTEM_CA=1` either way.
4. `--remote-debugging-port` still opens the Chromium DevTools protocol on the packaged app; no fuse covers it (step 5).

## Step 1: `--disable-sigusr1` in every RunAsNode launch

The MCP servers and the other RunAsNode children still accept SIGUSR1. Add `--disable-sigusr1` before the script in each launch: Claude Code, Codex and Antigravity MCP configs, the Cursor wrapper and its MCP config, the Open Model runtime, and the npm-shim path in `shared/provider-executable.mjs`. The provider adapters are imported by the daemon, so this needs a daemon implementation bump. Cursor checks its wrapper arguments exactly; update those checks in the same change. Size: about half an agent day.

## Step 2: RunAsNode off, with a separate Node runtime

`utilityProcess` cannot replace RunAsNode for the two main users:

1. The supervisor daemon is detached and outlives the app (update handoff). A `utilityProcess` child ends with the main process.
2. The MCP servers are started by provider CLIs from a command line in their MCP config. Only a real executable works there.

Plan: ship a pinned, official Node 24 binary as a separate helper executable (for example `Contents/Helpers/letagents-node`), signed with the team ID and the hardened runtime, with its own identifier and none of the app's entitlements. Download it in packaging like OpenCode, and check SHASUMS256 and its signature. Point every `process.execPath` + `ELECTRON_RUN_AS_NODE` launch at it, then set RunAsNode off. Check first: the daemon's `node:sqlite` use (built into Node 24), the Windows daemon pipe addon's ABI, Cursor's sandbox path lists, and the daemon identity check (it matches the script path, not the executable). Cost: about 45 MB more per download, and Node security releases become our job. Keep `utilityProcess` for short-lived workers that the main process owns.

Then decide the NODE_OPTIONS fuse. To turn it off without breaking company certificate authorities, read `NODE_EXTRA_CA_CERTS` (and `SSL_CERT_FILE`) in the shell environment import that already reads `PATH` (`desktop-shell-environment.ts`; the Windows user environment on Windows), and pass it to children explicitly. Size: 2-3 agent days.

## Step 3: asar archive and integrity validation

1. Pack `Resources/app` into `app.asar` with `@electron/asar` (new dev dependency; it must pass the dependency-age gate).
2. Keep real files outside the archive (`app.asar.unpacked`): `runtime/` (OpenCode, and the MCP runtime whose tree digest and Cursor sandbox paths need real files), native `.node` files, and the Windows process-tree helper.
3. Fix every `process.resourcesPath/app/...` path, and decide where `Contents/shared` goes (files outside the archive are not validated).
4. Write the header hash into `ElectronAsarIntegrity` in Info.plist before signing, then turn on EnableEmbeddedAsarIntegrityValidation and OnlyLoadAppFromAsar.
5. Extend `smoke:packaged-supervisor` to start agents from the archive layout.

On Windows the integrity hash lives in the unsigned executable, so it protects nothing until the Windows build is signed. Size: 1-2 agent days.

## Step 4: renderer off `file://`

Serve `dist-renderer` through a privileged custom scheme (`protocol.handle`) instead of `loadFile`, check module scripts, Monaco workers and the room page bridge, then turn off GrantFileProtocolExtraPrivileges. Size: about 1 agent day.

## Step 5: smaller items

1. Cookie encryption: list the cookies the app keeps (room pages, HTML demos), check keychain prompts on ad-hoc builds, and turn it on in a release that cannot be downgraded.
2. `--remote-debugging-port` has no fuse: in a packaged build, quit at startup when that switch or `--remote-debugging-pipe` is present.
3. Review `com.apple.security.cs.disable-library-validation`: keep it only if a loaded library needs it.
