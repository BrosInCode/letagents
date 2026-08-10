# Desktop release operations

LetAgents desktop ships two macOS artifacts for both Apple Silicon (`arm64`) and Intel (`x64`) from signed and notarized application bundles:

- `LetAgents-<version>-darwin-<arch>.dmg` is the first-install artifact. Users open it and drag LetAgents to Applications.
- `LetAgents-<version>-darwin-<arch>.zip` is the Squirrel.Mac update payload. The application updater downloads it; users should not install this file manually.

Each versioned release also includes SHA-256 checksum files, `desktop-release-<arch>.json`, and `RELEASES-<arch>.json`. The latter uses Electron's static Squirrel.Mac format and points to the immutable, versioned ZIP URL. The workflow copies each architecture manifest to a dedicated rolling feed release as `RELEASES.json`; stable clients never depend on GitHub's repository-wide `releases/latest` selection.

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

## Cut a release

1. Change `apps/desktop/package.json` to the next numeric `x.y.z` desktop version and merge that change to `staging` through a reviewed PR.
2. From the exact reviewed commit, create and push the matching tag: `desktop-v<x.y.z>`.
3. Watch the **Desktop release** workflow. Its arm64 and x64 jobs verify dependencies, build the exact embedded MCP and OpenCode runtimes, sign the applications, submit each app and DMG to Apple, validate the stapled tickets, and create GitHub build-provenance attestations. A final job publishes both architectures in one immutable versioned GitHub Release, then advances the two update feeds.
4. Download the DMG on a clean Mac and complete the first-install smoke test before announcing the release.

The workflow refuses a tag that does not exactly match the desktop package version or a runner whose CPU does not match its matrix architecture. If either architecture fails signing, notarization, verification, attestation, or artifact generation, it does not publish the release.

Verify a downloaded DMG or updater ZIP against GitHub's signed provenance record with:

```sh
gh attestation verify /path/to/LetAgents-<version>-darwin-<arch>.<dmg-or-zip> --repo BrosInCode/letagents
```

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

The in-app updater consumes the signed ZIP, never the DMG. Production clients fetch `https://github.com/BrosInCode/letagents/releases/download/desktop-feed-<arch>/RELEASES.json`: Apple Silicon uses `desktop-feed-arm64`, while Intel uses `desktop-feed-x64`. These rolling discovery manifests are the only mutable release assets and always point to immutable, architecture-matched ZIP URLs in a `desktop-v<x.y.z>` release. The versioned DMGs, ZIPs, checksums, metadata, and provenance records are never replaced. Production builds check their feed at startup and every six hours, and expose an on-demand check under **Settings → Updates** and **Help → Check for Updates**. For a staging feed, launch a packaged build with `LETAGENTS_DESKTOP_UPDATE_BASE_URL` set to an HTTPS directory containing `RELEASES.json`; do not put that override in a stable build.

Squirrel downloads a newer signed ZIP in the background but never restarts the app automatically. **Restart & update** first blocks agent lifecycle mutations, asks the serving supervisor daemon to drain dispatch and relinquish its owner-only socket, and verifies that exact daemon process has exited. Provider processes are not terminated. Only after that proof does the app call Electron's installer and quit. On the next launch, the new application starts its bundled daemon and the existing startup reconciliation reconnects desired-running agents to their exact provider generations. If handoff fails, installation is cancelled, the update remains downloaded, and the current app stays open with a retryable error.

Update metadata must continue to use HTTPS and immutable versioned asset URLs. Do not rely on a normal quit as the user-controlled installation path: Squirrel.Mac may stage a downloaded replacement for the next launch. If that path applies an update, the new app's normal implementation-version handshake still retires an older serving daemon before reconciliation. **Restart & update** remains the preferred path because the current app proves the handoff first and can report a retryable failure without quitting.

Do not replace an existing GitHub release asset with different bytes after it has been announced. If a release is faulty, publish a higher patch version; clients and Squirrel.Mac are designed to move forward to a newer version, not silently downgrade. Stable and beta channels should use separate feed locations so pre-release metadata cannot reach stable clients.
