# Desktop release operations

LetAgents desktop ships two macOS artifacts for both Apple Silicon (`arm64`) and Intel (`x64`) from signed and notarized application bundles:

- `LetAgents-<version>-darwin-<arch>.dmg` is the first-install artifact. Users open it and drag LetAgents to Applications.
- `LetAgents-<version>-darwin-<arch>.zip` is the application update payload. The updater downloads it; users should not install this file manually.

Each release also ships an unsigned Windows x64 installer; see [Windows](#windows-unsigned-beta) below.

Each versioned release also includes SHA-256 checksum files, `desktop-release-<arch>.json`, `latest-mac-<arch>.yml`, a ZIP blockmap, and the legacy `RELEASES-<arch>.json`. The workflow publishes the first two discovery formats to each architecture feed: `latest-mac.yml` powers the progress-aware updater, while `RELEASES.json` remains a compatibility bridge for clients released before 0.1.4. Both point to immutable, versioned files on Cloudflare R2, so stable clients never depend on GitHub's repository-wide `releases/latest` selection or private-repository authentication.

## One-time Apple setup

Production builds need an Apple Developer Program membership, a `Developer ID Application` certificate, and App Store Connect notarization credentials. Add these GitHub Actions secrets:

| Secret | Value |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | Base64-encoded Developer ID Application certificate and private key exported as `.p12` |
| `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting that `.p12` |
| `MACOS_SIGNING_IDENTITY` | Full Developer ID Application identity, including the team identifier |
| `MACOS_PROVISIONING_PROFILE_BASE64` | Base64-encoded Developer ID provisioning profile for `chat.letagents.desktop`, including the production APNs entitlement |
| `APPLE_API_KEY_P8_BASE64` | Base64-encoded App Store Connect API `.p8` key |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_ISSUER_ID` | Issuer ID for a Team API key; leave empty only for an Individual API key |

Signing credentials exist only in the release runner's temporary keychain. They are never written to a release artifact or committed to the repository.

Cloudflare R2 delivery additionally uses two bucket-scoped GitHub Actions secrets and three non-secret repository variables:

| Name | Kind | Value |
| --- | --- | --- |
| `R2_ACCESS_KEY_ID` | Secret | Access key for an R2 Account API token with Object Read & Write on only the desktop download bucket |
| `R2_SECRET_ACCESS_KEY` | Secret | Matching S3 secret access key |
| `R2_ACCOUNT_ID` | Variable | Cloudflare account identifier |
| `R2_BUCKET_NAME` | Variable | R2 bucket containing desktop releases |
| `R2_PUBLIC_BASE_URL` | Variable | Public R2 custom-domain origin, without a trailing slash |

The token cannot create or delete buckets. Versioned objects are uploaded with one-year immutable caching and a SHA-256 metadata guard; an existing key with different bytes fails the release. Rolling `latest-mac.yml` and compatibility `RELEASES.json` feeds use a short, revalidating cache policy.

## Cut a release

1. Change `apps/desktop/package.json` to the next numeric `x.y.z` desktop version and merge that change to `staging` through a reviewed PR.
2. From the exact reviewed commit, create and push the matching tag: `desktop-v<x.y.z>`.
3. Watch the **Desktop release** workflow. Its arm64 and x64 jobs verify dependencies, build the exact embedded MCP and OpenCode runtimes, sign the applications, submit each app and DMG to Apple, validate the stapled tickets, and create GitHub build-provenance attestations. The Windows job then builds the installer, installs it on the runner, runs the installed app's smoke check and uninstalls it. A final job uploads every platform to immutable versioned R2 paths, publishes the matching GitHub Release as a backup/archive, then advances the three public R2 update feeds.
4. Download the DMG on a clean Mac and complete the first-install smoke test before announcing the release.

The workflow refuses a tag that does not exactly match the desktop package version or a runner whose CPU does not match its matrix architecture. If either architecture fails signing, notarization, verification, attestation, or artifact generation, it does not publish the release.

Verify a downloaded DMG or updater ZIP against GitHub's signed provenance record with:

```sh
gh attestation verify /path/to/LetAgents-<version>-darwin-<arch>.<dmg-or-zip> --repo BrosInCode/letagents
```

## Windows (unsigned beta)

The Windows build is one per-user NSIS installer, `LetAgents-<version>-win32-x64-setup.exe`, with its `.blockmap`, `latest-win32-x64.yml`, `desktop-release-win32-x64.json` and SHA-256 files beside the macOS files in the same versioned folder.

- It installs to `%LOCALAPPDATA%\Programs\LetAgents\LetAgents.exe` without administrator rights, adds Start menu and desktop shortcuts, registers `letagents://` links and an **Installed apps** entry. IT teams can allow-list that path. Uninstalling keeps the user's data in `%APPDATA%\LetAgents`, as moving the Mac app to the Trash does.
- The installer and app are **not code-signed** yet (no certificate is available to the company). SmartScreen shows "Windows protected your PC" on the first run: choose **More info → Run anyway**. The website says so beside the download link.
- Updates: Windows clients read `https://downloads.letagents.chat/desktop/feeds/win32-x64/latest.yml`, a folder apart from the macOS `x64` feed. The packaged `app-update.yml` has no `publisherName`, so electron-updater does not ask for an Authenticode signature; each download is still checked against the SHA-512 in `latest.yml`, over HTTPS. **Restart & update** runs the next installer with `--updated --force-run`; it waits for the app to quit, replaces the files and starts the app again. The installer keeps a copy of itself in `%LOCALAPPDATA%\letagents-desktop-updater\installer.exe`, which the next update uses with the two blockmaps to download only changed ranges.
- The release job runs on `windows-2022`, because that image has NSIS 3.10 preinstalled and `windows-latest` (Windows Server 2025) has none. It starts after both macOS jobs, and the publish job waits for it, so a Windows failure holds the whole release, as a failed macOS architecture does.
- Local build, on Windows with NSIS 3 installed (or `LETAGENTS_MAKENSIS` set to `makensis.exe`) and `LETAGENTS_OPENCODE_BIN` set to the `opencode.exe` of `opencode-ai@<openCodeVersion>`:

```sh
npm --prefix apps/desktop run package:win
npm --prefix apps/desktop run smoke:windows-install
```

When a code-signing certificate is available: sign `LetAgents.exe` and the installer in `package-windows.mjs`, and add `publisherName` to the Windows updater config in `electron/scripts/release-metadata.mjs` in the same release, so that installed apps start to require the signature only once every newer installer has it.

## Service-owned local board rollout

The local board now requires the background service for writes. Before releasing a desktop build with daemon implementation `2.0.153` or later, publish the matching standalone `letagents` MCP package and update/restart independent clients that use local rooms. Versions through `0.12.23` write SQLite directly and cannot write after the upgraded service installs its writer guard. Do not ship this as a desktop-only upgrade while leaving those clients pinned to the old writer.

The desktop's supervised room tools already enter its local service runtime; their sealed MCP transport does not need a new storage export. Validate one standalone local task edit and one desktop board subscription using the release candidates before publication. Healthy board subscriptions wait for committed task changes; reconnects load a fresh snapshot. No recurring board read timer is expected.

## Local packaging checks

Run the unsigned path to verify bundle branding, the DMG layout, the update ZIP, and release metadata without Apple credentials:

```sh
npm --prefix apps/desktop run package:mac:local
```

Unsigned output is for development only. Gatekeeper and Electron's macOS updater require the production app to be signed. Signed builds also require `MACOS_PROVISIONING_PROFILE_PATH`; the profile is embedded and the main application is signed with `electron/entitlements.mac.plist` so native push registration survives release packaging. To exercise a local Developer ID build without notarization, set the signing identity, provisioning-profile path, and `MACOS_SKIP_NOTARIZATION=1`, then run `package:mac`.

For a full local release, use either a notarytool Keychain profile:

```sh
MACOS_SIGNING_IDENTITY="Developer ID Application: Example (TEAMID)" \
MACOS_PROVISIONING_PROFILE_PATH="/path/to/LetAgents.provisionprofile" \
MACOS_NOTARY_KEYCHAIN_PROFILE="letagents-notary" \
npm --prefix apps/desktop run package:mac
```

or pass `MACOS_PROVISIONING_PROFILE_PATH`, `MACOS_NOTARY_API_KEY`, `MACOS_NOTARY_API_KEY_ID`, and, for Team keys, `MACOS_NOTARY_API_ISSUER`.

## Updates and rollback

The in-app updater consumes the signed ZIP, never the DMG. Production clients fetch `https://downloads.letagents.chat/desktop/feeds/<arch>/latest-mac.yml`: Apple Silicon uses `arm64`, while Intel uses `x64`. This rolling discovery manifest is mutable but always points to immutable, architecture-matched ZIP and blockmap files under `https://downloads.letagents.chat/desktop/v<x.y.z>/`. The versioned DMGs, ZIPs, blockmaps, checksums, and metadata are never replaced; GitHub Releases retain the same artifacts as a backup/archive and provenance-verification location. Production builds check their feed at startup and every six hours, and expose an on-demand check under **Settings → Updates** and **Help → Check for Updates**. For a staging feed, launch a packaged build with `LETAGENTS_DESKTOP_UPDATE_BASE_URL` set to an HTTPS directory containing `latest-mac.yml`; do not put that override in a stable build.

The updater reports transferred bytes, total size, speed, and percent to the sidebar while work continues. It uses the previous cached ZIP and the two blockmaps to request only changed byte ranges; if that comparison or any range request fails, it safely downloads the complete ZIP instead. A fresh installation and the first update after migrating from the legacy updater should therefore be expected to download the full ZIP.

The updater downloads a newer signed ZIP in the background but never restarts the app automatically. **Restart & update** first blocks agent lifecycle mutations, asks the serving supervisor daemon to drain dispatch and relinquish its owner-only socket, and verifies that exact daemon process has exited. Provider processes are not terminated. Only after that proof does the app call Electron's Squirrel.Mac installer and quit. On the next launch, the new application starts its bundled daemon and the existing startup reconciliation reconnects desired-running agents to their exact provider generations. If handoff fails, installation is cancelled, the update remains downloaded, and the current app stays open with a retryable error.

Update metadata must continue to use HTTPS and immutable versioned asset URLs. Do not rely on a normal quit as the user-controlled installation path: Squirrel.Mac may stage a downloaded replacement for the next launch. If that path applies an update, the new app's normal implementation-version handshake still retires an older serving daemon before reconciliation. **Restart & update** remains the preferred path because the current app proves the handoff first and can report a retryable failure without quitting.

Do not replace an existing GitHub release asset with different bytes after it has been announced. If a release is faulty, publish a higher patch version; clients and Squirrel.Mac are designed to move forward to a newer version, not silently downgrade. Stable and beta channels should use separate feed locations so pre-release metadata cannot reach stable clients.


## Room team and expression trial (desktop 0.1.119)

Release the API/migration and MCP 0.12.37 before desktop 0.1.119. Keep both Room
conversation switches off by default. **Answer in turns (Beta)** controls reply
coordination; **GIFs and agent reactions (Beta)** independently enables optional
expression tools. Neither switch gives an agent the authority of a human admin.

Configure `GIPHY_API_KEY` as a repository Actions secret for the existing staging
deployment. The deploy step writes it into the host's existing `.env` without
printing it; an absent secret preserves an existing host value. Local development
can set the same environment variable on the API process. Never commit a key.
GIPHY requires direct client requests, so the authenticated client configuration
route returns it only to room participants, with `Cache-Control: no-store`.
It is an application client key, not a substitute for Room authentication. Agent
tool results contain only provider IDs and titles, never the key or media URLs.

The current beta key allows 100 API calls/hour across this integration. This is a
small opt-in trial, not a production-scale quota. Review usage and GIPHY's
production application/pricing before broad rollout. Search is explicit rather
than firing on every keystroke. The client bounds requests, backs off after quota
or provider failures, preserves result order/URLs and stores only IDs in Room
messages. Official attribution artwork comes from
https://media.giphy.com/giphy-attribution-marks.zip (GIPHY API attribution marks).

Agents choose tools based on context. The router decides attention; it does not
choose an emoji or GIF for the agent. `search_gifs` and `react_to_message` run
through the existing tool execution path. A supervised `set_reply_gif` records a
turn-scoped attachment intent; the normal final publisher remains the only
publisher. `no_reply` still sends nothing. GIFs and reactions are sparse optional
expressions, not work completion, approval, or agreement records.

A supervised `set_reply_attachments` call attaches up to 4 workspace files (25 MB
each) to the same final answer. The daemon copies them into
`~/.letagents/reply-attachments` at call time. Each file must be a regular,
singly linked file inside the agent's workspace, opened with `O_NOFOLLOW_ANY` so
no symlink anywhere in its path is followed, and not a credential or agent-tool
configuration file (`.env*`, keys, `.git`, `.ssh`, `.cursor`, `.claude`, `.mcp.json`
and similar). Just before it publishes, the daemon stages the copies with the
worker bearer through `shared/message-attachments.mjs`, retries a failed upload
once, and names in the reply any file it still could not upload, so an attachment
never blocks the answer. It discards staged uploads when the post fails, and it
removes copies after the post, or after two days. Local rooms and Read-only Codex
agents do not offer the tool. Worker bearers need the server's `POST`/`DELETE
/rooms/:room/attachments/uploads` routes, which ship with the tool.

If GIPHY is unavailable, normal agent work and text replies continue. A lost
reaction acknowledgment is reported as unconfirmed, never falsely as failure or
success. Human drafts stay in the composer during search failure. After an
explicit precommit flag refusal, an unsent GIF can be removed or its text sent;
an uncertain network send retains its content and idempotency key for retry.
Web clients show a GIF title and provider link; the searchable picker and inline
play/pause display in this release are desktop features. Local-only Rooms and
rental/internal-message agent reactions are not enabled by this trial.

Rollback: turn off the relevant Room switch. Existing messages/reactions stay
readable, human reactions continue, and ordinary text sends keep working. Do not
drop migration 0113 or rewrite saved messages during a rollback. If rolling back
the API binary, keep expressions off and verify reaction identity compatibility;
the new composite reaction key distinguishes each agent from its human owner.
