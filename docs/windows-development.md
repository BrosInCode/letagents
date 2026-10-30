# Windows development

How to set up a Windows 11 PC for LetAgents development, and what to expect when you run the Windows CI suites
locally. Every step here was run on a Windows 11 machine on 2026-10-30; the results are in
[What a run looks like](#what-a-run-looks-like).

Supervised room agents run on Windows. A test that needs something Windows lacks skips itself there with a one-line
reason. Most reasons are named once in `apps/desktop/electron/__tests__/platform.ts`; some older POSIX-only tests carry
theirs inline.

## What you need

| Tool | Version | Where | Admin |
| --- | --- | --- | --- |
| Node.js (with npm) | 22.23.4, **x64** | `%LOCALAPPDATA%\Programs\node-v22.23.4-win-x64` | no |
| Git for Windows (portable, with Git Bash) | 2.56.0.4 | `%LOCALAPPDATA%\Programs\PortableGit-2.56.0.4` | no |
| GitHub CLI | 2.103.3 | `%LOCALAPPDATA%\Programs\gh-2.103.3` | no |
| Visual Studio Build Tools 2026 | 18.11.3, MSVC 14.51.36231, Windows SDK 10.0.26100.0 | `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools` | **yes** |
| `LongPathsEnabled` = 1 | | `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem` | **yes** |

- Node is x64 on every machine, also on Windows on ARM. The two sealed native pieces (the process-tree helper and the
  daemon pipe addon) have x64 seals only, the app ships x64 only, and CI runs x64 Node 22.23.4 (`actions/setup-node`
  with `22` on `windows-latest`). An arm64 Node looks for arm64 builds that have no seal, and the app refuses them.
- MSVC 14.51.36231 with SDK 10.0.26100.0 is what the seals name (CI image `windows-2025-vs2026`). With it,
  `build.mjs --check` makes the sealed bytes. Another MSVC builds other bytes: `--check` only warns, but the app and the
  tests refuse that helper and that addon. `-BuildTools` installs the current Build Tools 2026 release, so once
  Microsoft ships a newer MSVC (and CI's image moves to it), a fresh install has the newer one: the script then warns.
  Use the CI-built pieces until the seals are renewed.
- Windows puts the machine `Path` before the user `Path`. If an MSI-installed Node, Git or `gh` is on the machine
  `Path` (for example `C:\Program Files\nodejs`), new terminals start that one instead; `-Tools` warns when it finds
  one.
- No Python and no node-gyp: no dependency builds native code at install time. The only install scripts are esbuild's
  (it picks its prebuilt binary) and Electron's download.

## Set up

The script `scripts/windows/setup-dev.ps1` does every step below. It is safe to run again: each part checks what is
there and skips it. Each tool goes into its own versioned folder, so the script never removes another installation.
Every download of `-Tools` is checked against a pinned SHA-256, and each program in it against its Authenticode signer,
before it runs; the Visual Studio bootstrapper changes with each release, so it is checked by its signer only.
`-Providers` is the exception: see [Provider CLIs](#provider-clis).

1. Get the script. Without Git yet, download `scripts/windows/setup-dev.ps1` from GitHub (the raw file of `staging`).
2. Install the per-user tools (no admin). In PowerShell:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File setup-dev.ps1 -Tools
   ```

   This puts Node, `%APPDATA%\npm`, Git's `cmd` folder and `gh` first on your user `Path`, and
   sets `core.autocrlf=false` and `core.longpaths=true` in your global Git config. It removes older entries of the same
   tools (and a MinGit) from the user `Path`, and keeps every other entry as it is stored (`%VAR%` entries stay
   unexpanded).
3. Install the build tools (admin). In PowerShell started with **Run as administrator** (it starts in
   `C:\Windows\System32`, so go to the script's folder first):

   ```powershell
   cd <the folder that holds setup-dev.ps1>
   powershell -NoProfile -ExecutionPolicy Bypass -File setup-dev.ps1 -BuildTools
   ```

   This sets `LongPathsEnabled` and installs Visual Studio Build Tools 2026 with the MSVC x64 and ARM64 compilers and
   the Windows 11 SDK 26100, silently (about 9 minutes). It changes no other setting. It then asks `vcvarsall.bat` which MSVC and
   SDK the native builds get (the same Visual Studio and defaults as `build.mjs`), and warns when they differ from the
   versions the seals name.
4. Open a new terminal, so the new `Path` applies.
5. Clone the repository and switch to `staging`:

   ```powershell
   git clone https://github.com/BrosInCode/letagents.git
   cd letagents
   git switch staging
   ```

6. Install every dependency tree as CI does (no admin):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup-dev.ps1 -Dependencies
   ```

   For each of `.`, `apps/desktop`, `src/web` and `apps/desktop/electron/runtime/letagents` it runs
   `npm ci --ignore-scripts --no-audit` and `npm audit signatures`. Only then does it run the lifecycle scripts
   (`npm rebuild` in the root, `apps/desktop` and `src/web`) and download Electron (`install-electron`). It then
   writes `node_modules\.letagents-dev-setup` in each tree, and a later run skips a tree whose lock file and Node are
   unchanged. Add `-Force` to set every tree up again.
7. Install the provider CLIs (no admin), if you work on agents:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup-dev.ps1 -Providers
   ```

   With this Node, `npm install --global` puts packages in the Node folder itself. See
   [Provider CLIs](#provider-clis).

Without the script, do the same by hand: the versions and SHA-256 values are at the top of the script.

### Why portable Git

The Git for Windows installer asks for elevation (UAC) even with `/CURRENTUSER`. The portable build
(`PortableGit-<version>-<arch>.7z.exe`, from the same release) is the full Git for Windows with Git Bash, and needs no
admin. If you use the installer instead, `-Tools` still adds the portable Git first on your `Path`, and each new run
of `-Tools` adds it again: remove that entry after each run if you want the installed one. CI's `shell: bash` is Git Bash: run the commands below in Git Bash
(`%LOCALAPPDATA%\Programs\PortableGit-2.56.0.4\git-bash.exe`, or `bin\bash.exe` from a terminal).

## Run the Windows CI suites

Run these in Git Bash at the repository root. They are the steps of the jobs `mcp-tests-windows`,
`process-tree-windows` and `desktop-tests-windows` in `.github/workflows/ci.yml`.

The tests write under the home folder. Point `HOME` and `USERPROFILE` at a scratch folder first, so they never touch
your real `~/.letagents`, and point the API at an address where nothing listens. Then set the global Git settings
again: they are read from the new home, and without them Git for Windows' own default (`core.autocrlf=true`) applies,
which fails `workspace-change-capture` ("turn capture reuses four bounded buffers": `0 !== 4`). CI does the same.

```bash
scratch="$(cygpath -m "$USERPROFILE")/letagents-test-home"
export HOME="$scratch" USERPROFILE="$scratch"
mkdir -p "$HOME"
git config --global core.autocrlf false
git config --global core.longpaths true
export LETAGENTS_API_URL=http://127.0.0.1:9
```

CI's runner is an elevated administrator; a normal developer shell is not. Some tests need one or the other of these
(see [Known failures](#known-failures)):

- Tests that create symbolic links need an elevated shell or Windows **Developer Mode** (Settings → System → For
  developers). Without either, they fail with `EPERM: operation not permitted, symlink`.
- One daemon pipe test needs an elevated shell.

On a VM driven from a Mac, [SSH sessions](#run-commands-from-the-mac-with-no-windows) are elevated.

MCP server (`mcp-tests-windows`):

```bash
npm run build
node apps/desktop/native/win-daemon-pipe/build.mjs --check
node --test scripts/npm-command.test.mjs
npm run test:mcp
LETAGENTS_PACKAGE_TEST_DIST_BUILT=1 npm run test:package-runtime
node --import tsx --test apps/desktop/daemon/__tests__/workspace-capture.test.ts apps/desktop/daemon/__tests__/workspace-capture-git-for-windows.test.ts apps/desktop/daemon/__tests__/workspace-change-capture.test.ts apps/desktop/daemon/__tests__/permission-review.test.ts
```

Process-tree helper (`process-tree-windows`):

```bash
node apps/desktop/native/win-process-tree/build.mjs --check
node --test --test-timeout=120000 apps/desktop/native/win-process-tree/seal.test.mjs apps/desktop/native/win-process-tree/process-tree.windows.test.mjs
rm apps/desktop/native/win-process-tree/build/x64/letagents-process-tree.exe
```

The last line removes the helper from its default build folder, where the app's code finds it: CI builds it in its own
job, so the desktop suites run without it.

Desktop (`desktop-tests-windows`):

```bash
node apps/desktop/native/win-daemon-pipe/build.mjs --check
npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:renderer
npm --prefix apps/desktop run test:packaging
node --test --test-timeout=300000 apps/desktop/native/win-daemon-pipe/seal.test.mjs apps/desktop/native/win-daemon-pipe/daemon-pipe.windows.test.mjs
npm --prefix apps/desktop run test:daemon
```

The electron suite needs the process-tree helper outside its default folder, so that only the tests that name it use
it:

```bash
node apps/desktop/native/win-process-tree/build.mjs --check
mkdir -p "$HOME/process-tree"
mv apps/desktop/native/win-process-tree/build/x64/letagents-process-tree.exe "$HOME/process-tree/"
export LETAGENTS_TEST_PROCESS_TREE_HELPER="$HOME/process-tree/letagents-process-tree.exe"
npm --prefix apps/desktop run test:electron
```

The web app's type check (`build-checks`): `cd src/web && npx vue-tsc --noEmit`.

## Start the desktop app in dev mode

In a new terminal (not the one with the scratch `HOME`):

```bash
npm --prefix apps/desktop run dev
```

This builds the MCP server, the electron main process and the daemon, then starts Vite on port 5174, the `tsc` watchers
and Electron (about 10 minutes the first time on the ARM64 VM). It uses your real `~/.letagents`, as the installed app
does. Sign in to LetAgents in the app as usual.

- Use `npm --prefix apps/desktop run dev`, not `npm run dev:desktop`, on Windows for now: see
  [Known failures](#known-failures).
- Quit the installed LetAgents app first. On Windows the dev app and the installed app use the same user-data folder
  (`%APPDATA%\LetAgents`) and so the same single-instance lock: a dev app started beside the installed app hands over
  to it and exits. To run both, start the dev app with its own `APPDATA` (and, to keep its state apart too, its own
  `USERPROFILE` and `HOME`).

## Provider CLIs

`-Providers` installs each from its official source. Nothing signs in.

| CLI | How | Version | Program the app starts |
| --- | --- | --- | --- |
| Claude Code | `https://claude.ai/install.ps1` | latest (2.1.312 tested) | `%USERPROFILE%\.local\bin\claude.exe` |
| Codex | `npm install --global @openai/codex@0.166.0` | 0.166.0 | the npm shim's `node` + `codex.js` |
| OpenCode | `npm install --global opencode-ai@<letagentsRuntime.openCodeVersion>` | 1.18.20 today | the npm shim's `opencode.exe` (the packaged app uses its own) |
| Cursor agent | `https://cursor.com/install?win32=true` | latest (2026.10.22-27dcf5f tested) | the install's own `node.exe` + `index.js`, see below |

Codex and OpenCode come from npm at pinned versions; npm checks each package against the registry's integrity value,
and their install scripts run (OpenCode's picks its binary). Claude Code and the Cursor agent come from the vendors'
own install scripts, fetched over HTTPS and run as published, with no pin: Claude's script checks the binary's SHA-256
against its release manifest, and Cursor's checks nothing. Read them first if your policy needs it.

The app finds each program on `PATH` through `shared/provider-executable.mjs`. It starts a native program, or what a
batch file really runs, with no `cmd.exe` and no PowerShell, because `cmd.exe` would re-read the prompt's quotes and
line breaks. It reads a batch file and never runs it to find out (`shared/provider-windows-install.mjs`):

- An npm shim of a script: the `node` and the script.
- An npm shim of a native program (`opencode-ai`): that `.exe`, when it is inside the package folder the shim names and
  no link leads out of that folder.
- Cursor's official launcher (`%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd`, then `cursor-agent.ps1`): the `node.exe`
  and `index.js` in the `versions\<version>` folder with the latest date, as the script selects it (except that a
  hidden folder counts here, and not for the script). The app also sets
  the `CURSOR_INVOKED_AS` and `NODE_COMPILE_CACHE` values that the launcher sets.

A file that looks like one of these but differs stops the launch with an error that names the file, and never goes to
`cmd.exe`. That is also what happens in these three cases:

- Cursor changes the code in its launcher. Comments may change. LetAgents then needs an update.
- Two version folders have one date. The script compares only the date, and PowerShell 5.1's sort gives no defined
  order, so what it would run is not known. Delete the older folder, or set `LETAGENTS_CURSOR_AGENT_BIN` to
  `versions\<version>\cursor-agent.cmd`.
- A package or version folder is a junction or a symbolic link, as `npm link` makes. Set `LETAGENTS_OPENCODE_BIN` to
  the real `.exe`. For Cursor, set `LETAGENTS_CURSOR_AGENT_BIN` to the `cursor-agent.cmd` in the real version folder,
  not to its `node.exe`.

A batch file that plainly names any other `.exe` from its own folder, such as a shim for a `bun` script, also stops
there. Any other batch file is refused for a Cursor turn. A version check or another provider's start can still run it
through `cmd.exe`, which refuses an argument that holds a quote or a line break. These checks catch a damaged install.
They are no security boundary, because whoever can edit such a file can already make it run anything.

Cursor's launcher also applies a staged update (`versions\promote-staged.cmd`) before it starts. The app does not run
that script. A staged update waits until you next run `cursor-agent` in a terminal.

Sign in to each in a terminal before you use it as an agent:

1. Claude Code: run `claude`, then follow the browser sign-in.
2. Codex: run `codex login`, then follow the browser sign-in.
3. OpenCode: run `opencode auth login`, then choose the provider.
4. Cursor: run `cursor-agent login`, then follow the browser sign-in.

## What a run looks like

Measured on 2026-10-30 on the ARM64 VM (Windows 11 build 26300, not elevated, Developer Mode off), on `staging` at
`042ead501`. A second session used the same VM during the daemon run, so its times are high.

| Step | Result | Time |
| --- | --- | --- |
| `-Tools` (first run / again) | Node, Git, `gh` installed and checked | 4 min 21 s / 5 s |
| `-Dependencies` again | every tree skipped | 3 s |
| `-BuildTools` | Build Tools 2026 18.11.3 | about 9 min |
| `-Dependencies` (4 trees) | 138, 338, 64 and 110 packages, all with verified registry signatures | 5 min 27 s |
| Process-tree helper `build.mjs --check` | matches its seal `9ee36c1b…` | 24 s |
| Process-tree tests | 22 / 22 pass (with `--test-timeout=300000`) | 143 s |
| Pipe addon `build.mjs --check` | matches its seal `e86964be…` | 16 s |
| Pipe addon tests | 15: 13 pass, 1 fail, 1 skip (SYSTEM squatter: CI only) | 53 s |
| `npm run build` (MCP server) | pass | 56 s |
| `scripts/npm-command.test.mjs` | 6 / 6 pass | 1 s |
| `npm run test:mcp` | 522: 502 pass, 7 fail, 1 cancelled, 12 skip | 298 s |
| `test:package-runtime` | 1 / 1 pass | 80 s |
| Shared modules (capture, permission review) | 43: 39 pass, 4 fail | 40 s |
| Desktop `typecheck` | pass | 299 s |
| Desktop `build` | pass | 384 s |
| Web `vue-tsc --noEmit` | pass | 67 s |
| `test:renderer` | 2206 / 2206 pass | 871 s |
| `test:packaging` | 70 / 70 pass | 14 s |
| `test:daemon` | 2715: 2141 pass, 16 fail, 2 cancelled, 556 skip | 31 min |
| `test:electron` (3 shards) | 2838: 2374 pass, 37 fail, 1 cancelled, 426 skip | 36 min |
| Dev mode | the app opens on its first-run page | about 10 min |

Every failure has one of the causes in [Known failures](#known-failures). The 12 daemon files with failures, run again
alone, gave 241 tests: 218 pass and 9 fail (8 symbolic links, 1 time limit).

## Windows on ARM (for example a Parallels VM on a Mac)

The steps are the same on Windows 11 on ARM64, with these differences (seen on a Parallels VM on an Apple silicon
Mac, 4 virtual CPUs, 6 GB):

- Node, Electron, esbuild and every test run as x64 programs under Windows' x64 emulation. Install x64 Node (the
  script does); an arm64 Node would look for arm64 builds of the sealed helper and addon, which have no seal.
- Git and `gh` are native arm64 builds (Git's MSYS tools, such as `bash.exe`, are still x64).
- Visual Studio's x64 compiler (`Hostx64\x64`) runs emulated and still builds the sealed bytes: the process-tree
  helper and the pipe addon matched their seals (`9ee36c1b…`, `e86964be…`).
- Everything takes about twice as long as on CI. `process-tree.windows.test.mjs` then needs more than CI's
  `--test-timeout=120000` (143 s; it passes with 300000), and a few tests with their own short limits fail on time
  (see [Known failures](#known-failures)).
- In a VM, run nothing else heavy at the same time: two test runs sharing 4 CPUs make the timing tests fail.

### Run commands from the Mac with no windows

`prlctl exec "<vm>" --current-user <command>` starts the command on the VM's desktop, and Windows opens a console
window for it. The window stays open until the command ends. OpenSSH runs commands in session 0, which has no
desktop, so no window opens and the output still comes back to the Mac.

On the Mac, make a key for the VM only:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/letagents_windows_vm
```

An agent cannot type a passphrase. If agents use this key, use an empty passphrase, or load the key with
`ssh-add --apple-use-keychain`. Read the security notes below first.

In the VM, run the blocks below in order in an elevated PowerShell. From the Mac, you can run each block as SYSTEM with
`prlctl exec "<vm>" powershell -NoProfile -EncodedCommand "$(iconv -f UTF-8 -t UTF-16LE block.ps1 | base64 | tr -d '\n')"`,
without `--current-user`.
Keep each command short: 1,700 encoded characters worked and 4,600 failed with "Unable to open new session".

1. Install the server, and limit the firewall rule to the Mac's address on the VM network before anything listens
   (`10.211.55.2` here; on the Mac, see `ifconfig bridge100`). Then start the server once, so it writes `sshd_config`
   and its host keys:

   ```powershell
   Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
   Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Profile Any -RemoteAddress 10.211.55.2
   Set-Service sshd -StartupType Automatic
   Start-Service sshd
   ```

2. Turn off password login. Run this once. The lines go at the top of the file because lines below the `Match` block
   apply only to that group. Both `no` lines are needed: `keyboard-interactive` can also accept a password. Write the
   file as ASCII: `>` writes UTF-16 and `Set-Content -Encoding UTF8` adds a BOM, and `sshd` does not accept either.

   ```powershell
   $config = "$env:ProgramData\ssh\sshd_config"
   $head = "PasswordAuthentication no`r`nKbdInteractiveAuthentication no`r`nPubkeyAuthentication yes`r`n`r`n"
   [IO.File]::WriteAllText($config, $head + [IO.File]::ReadAllText($config), [Text.Encoding]::ASCII)
   ```

3. Add the public key. For a user in Administrators, the server reads `administrators_authorized_keys`, not the
   user's own `.ssh` folder, and it ignores that file unless only SYSTEM and Administrators can write to it:

   ```powershell
   $keys = "$env:ProgramData\ssh\administrators_authorized_keys"
   [IO.File]::WriteAllText($keys, "<the line of letagents_windows_vm.pub>`r`n", [Text.Encoding]::ASCII)
   icacls.exe $keys /inheritance:r /grant '*S-1-5-18:F' /grant '*S-1-5-32-544:F'
   ```

4. Check the file and restart the server. The edit of step 2 applies only after this restart:

   ```powershell
   & "$env:WINDIR\System32\OpenSSH\sshd.exe" -t
   Restart-Service sshd
   ```

On the Mac:

1. Add the host to `~/.ssh/config`. `HostKeyAlias` ties the host key to this name, so a new VM address needs only a
   new `HostName`:

   ```text
   Host windows-vm
     HostName 10.211.55.3
     HostKeyAlias windows-vm
     User <windows user>
     IdentityFile ~/.ssh/letagents_windows_vm
     IdentitiesOnly yes
     StrictHostKeyChecking yes
   ```

2. Read the host key through `prlctl`, so the first connection needs no trust prompt:

   ```bash
   prlctl exec "<vm>" cmd /c type 'C:\ProgramData\ssh\ssh_host_ed25519_key.pub' | tr -d '\r' | cut -d' ' -f1,2 | sed 's/^/windows-vm /' >> ~/.ssh/known_hosts
   ```

   If you rebuild the VM, its host key changes: run `ssh-keygen -R windows-vm`, then repeat this step.

3. Test the key login:

   ```bash
   ssh windows-vm 'whoami & node -v'
   ```

4. Test that password login is off. The last line must end in `Permission denied (publickey).` If it also names
   `keyboard-interactive` or `password`, step 2 or step 4 of the VM list did not apply:

   ```bash
   ssh -o PubkeyAuthentication=no -o NumberOfPasswordPrompts=0 windows-vm true </dev/null
   ```

Close standard input for unattended commands (`ssh windows-vm '...' </dev/null`). The remote shell is `cmd.exe`, so put
long Git Bash commands in a script file and run that. `%LOCALAPPDATA%` expands in `cmd.exe`; quote the path if your
user name has a space:

```bash
ssh windows-vm '%LOCALAPPDATA%\Programs\PortableGit-2.56.0.4\bin\bash.exe -lc "bash //Mac/Home/Downloads/run.sh"' </dev/null
```

An SSH session is not the same as a `prlctl --current-user` session:

| Item | `ssh windows-vm` | `prlctl exec --current-user` |
| --- | --- | --- |
| Window on the VM desktop | none | one for each command |
| Elevation | elevated (High integrity) | not elevated (Medium integrity) |
| Symbolic links | allowed, as on CI | `EPERM` without Developer Mode |
| Mac folders | `\\Mac\Home\...` (`Z:` is not mapped) | `Z:\...` |
| Programs with a window | cannot show (session 0) | show on the desktop |

Because SSH sessions are elevated, the tests in [Known failures](#known-failures) that need elevation behave as on CI.
Use `prlctl exec --current-user` for anything that must show on the desktop, such as the desktop app or a sign-in in a
browser.

Security notes. Keep this setup for a local test VM:

- The key gives administrator access to the VM with no UAC prompt. The firewall rule checks only the source address,
  so any program that runs as your Mac user can use a key with no passphrase. A key loaded in `ssh-agent` has the same
  risk while it is loaded.
- The risk also goes the other way. With the Mac home folder shared, a program in the VM can read the Mac's home
  folder, including `~/.ssh`, and the VM runs `npm` installs and tests. If you do not need the shared folder, turn it
  off in the VM's Parallels settings.

The VM's address can change. If `ssh` times out, check `prlctl list -i "<vm>"`, and update `HostName`.

## Known failures

Seen on 2026-10-30. None of these fails on CI, which runs elevated, without Claude Code, on x64 hardware.

Not elevated, no Developer Mode (a normal developer shell):

- **Symbolic links.** Tests that make a link fail with `EPERM: operation not permitted, symlink`: 25 electron tests
  (for example `cursor-managed-profile`, `letagents-mcp-runtime`, `desktop-development-runtime`,
  `repo-room-opening`), 8 daemon tests (for example `workspace-change-capture`, `room-turn-files`), 4 MCP tests
  (`owner-private-fs`, `local-state-owner-private`, `daemon-tool-executor`, `supervisor-bridge`) and the 4 shared-module
  tests. Turn on Developer Mode, or run the tests elevated, to run them.
- **`codex-agent-home-windows.test.ts`** (6 tests): each test passes, then its clean-up fails with
  `EPERM ... rmdir ...\codex-agent-home\rules`, because the test made that folder deny writes and only an elevated
  process (backup privilege) can still remove it.
- **`daemon-pipe.windows.test.mjs`** "a squatter with this user's SID for deny only is refused before the client
  writes": the test's squatter calls `WindowsIdentity.GetCurrent()` with a token whose user SID is deny-only, which is
  refused (`Access is denied`) unless the token also holds an enabled Administrators group, so it never reports.

Claude Code installed:

- **`claude-home-harness.test.ts`** runs only where Claude Code is installed (CI has none). On Windows its hook
  commands (`/usr/bin/env > file`, `touch`) do not run, so 5 tests fail and the file reaches its 600 s limit. Supervised
  agents are tier 3; these tests do not skip themselves on Windows yet.

ARM64 VM speed (about half CI's speed under x64 emulation; these pass on CI):

- Tests with short limits of their own: `process-tree.windows.test.mjs` (file over 120 s), the pipe addon's Electron
  probe (10 s handshake; passed when run again), `room-latency-trace` and `turn-start-latency` (10 s `spawnSync`),
  `activity-write-batcher` and `durability-store-sqlite` (30 s PowerShell answer, under load), `supervisor-bridge`
  (250 ms bounds), `local-chat-state` (foreground budget), `worker-handles-stdio` (60 s) and
  `supervised-agent-delivery-rebind-refresh` (file over 600 s, under load). Run again alone, all the daemon ones passed except
  `room-latency-trace`.

Other:

- **`npm run test:mcp` hung twice** in `room-join-runtime.test.ts` (the test process waited with an idle PowerShell
  child of `shared/owner-private-fs.mjs`), both times while other test processes ran in the VM. The file passes alone
  (8 / 8 in 12 s) and the whole suite passed a third time. `test:mcp` sets no `--test-timeout`, so a hang never ends.
  To get a failure with the test's name instead, run
  `node --import tsx --test --test-timeout=300000 src/mcp/__tests__/*.test.ts`.
- **`npm run dev:desktop`** stops at once on a fresh Windows clone: `scripts/ensure-desktop-dependencies.mjs` runs
  `npm install --prefix <repo>\apps\desktop` from the repository root, and on Windows (npm 10.9.9) that also adds the
  root package to `apps/desktop` as `"letagents": "file:../.."`, so the script refuses the changed lock file. The same
  command on macOS changes nothing. Until that is fixed, start dev mode with `npm --prefix apps/desktop run dev`, and
  if it ran once, restore the two files with `git checkout -- apps/desktop/package.json apps/desktop/package-lock.json`
  and remove the junction with `cmd /c rmdir apps\desktop\node_modules\letagents`. Do not use PowerShell's
  `rmdir` or `Remove-Item` here: on a junction they can delete what it points at, which is the repository.
- **`project-bindings-store.test.ts`** "separate desktop processes serialize whole-store updates" failed once
  (`database is locked`); a known Windows flake.
