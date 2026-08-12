# Desktop notifications

LetAgents Desktop uses native Apple Push Notification service (APNs) alerts on macOS. Alert delivery is owned by macOS, so a notification can appear while the app is not running. Clicking an alert launches or focuses LetAgents and routes to the exact room and message.

## Runtime architecture

- The signed Electron main process registers the installation with APNs and sends the device token to `POST /desktop/push/devices` using the signed-in LetAgents account. Registration serializes on the token hash and transfers that physical token away from any previous account, preventing stale-account delivery after an account switch even if an earlier unregister request was interrupted.
- Message creation inserts one `desktop_push_notifications` outbox row per eligible device in the same PostgreSQL transaction as the message.
- Immediately before delivery, the worker performs a fresh repository visibility and collaborator check for repo-backed rooms. `account_room_recents` is discovery state, not an authorization grant; a stale recent-room row can never authorize a push. A missing or expired GitHub credential is retried with the bounded worker policy instead of being mistaken for confirmed access revocation; only a credentialed access denial redacts the account/room backlog.
- The API worker claims outbox rows with `FOR UPDATE SKIP LOCKED`, sends them over APNs HTTP/2, and records delivered, retry, or dead-letter state.
- Transient APNs and network errors use bounded exponential backoff. Invalid or unregistered device tokens disable the device and retire its pending work. A device is also disabled after 50 consecutive delivery failures, and re-registration resets the counter, which bounds churn from a persistently failing registration.
- Notification identifiers make device/message delivery idempotent. `thread-id` groups alerts by room in Notification Center.
- The desktop persists a bounded notification-target map and reattaches click handlers to Notification Center history after restart. A quit-state click is recovered from Electron's macOS `ready` launch payload before the first window is created, so cold launches route through the same room/message activation path as warm clicks.

Prompt-only agent control messages are never notified. The authenticated publisher's own devices are excluded when the account identity is available. Archived rooms are excluded.

## Privacy and preference decisions

- Alert previews contain the room name, sender, and up to 1,000 characters of message text. This data transits Apple's APNs infrastructure so macOS can render useful alerts while LetAgents is quit. This is an explicit product decision; deployments that require content-free pushes must replace the preview with a wake-only payload and fetch after launch.
- Preview fields exist in the durable outbox only while delivery is queued or retrying. The worker blanks the room display name, sender, and body as soon as a row becomes delivered, dead-lettered, unauthorized, or tied to a retired device. Terminal rows retain delivery metadata for operations and are deleted by the retention worker.
- The current notification switch is deliberately app-wide, not a per-room mute. Disabling it deletes the account's installation registration, and explicit sign-out unregisters before local authentication is removed. A future per-room mute must be stored server-side and enforced by the outbox/worker; a renderer-only mute is not sufficient while the app is quit.
- The JIT, unsigned-executable-memory, and library-validation exceptions are the standard Electron hardened-runtime compatibility set. They are deliberate and limited to the signed desktop application; APNs and application-identifier entitlements remain fixed to the LetAgents bundle and team.

## Server configuration

Apply migration `0077_desktop_push_notifications` before enabling the worker.

Configure these deployment secrets and settings on the API process:

```text
APNS_TEAM_ID=<Apple Developer Team ID>
APNS_KEY_ID=<APNs authentication key ID>
APNS_PRIVATE_KEY=<complete contents of the APNs .p8 file>
APNS_TOPIC=chat.letagents.desktop
```

`APNS_PRIVATE_KEY_PATH` may be used instead of `APNS_PRIVATE_KEY` when the deployment platform mounts secrets as files. Never commit the `.p8` file. When APNs credentials are absent or unreadable, the API remains available and logs that the push worker is disabled.

## macOS packaging

The direct-download app uses:

- bundle ID `chat.letagents.desktop`;
- a Developer ID Application signing identity;
- a Developer ID provisioning profile granting the production APNs entitlement;
- hardened runtime;
- Apple notarization and stapling for both the app and DMG.

Store notarization credentials once in the login Keychain:

```sh
xcrun notarytool store-credentials letagents-notary
```

Then package with paths and identity supplied at build time:

```sh
MACOS_SIGNING_IDENTITY='<Developer ID Application identity or SHA-1>' \
MACOS_PROVISIONING_PROFILE_PATH='<path to .provisionprofile>' \
MACOS_NOTARY_KEYCHAIN_PROFILE='letagents-notary' \
npm --prefix apps/desktop run package:mac
```

The distributable is written to `apps/desktop/release/LetAgents.dmg`. `MACOS_SKIP_NOTARIZATION=1` is available only for local signing tests; those DMGs are not release artifacts and will not pass normal Gatekeeper distribution checks.

The APNs authentication key and Developer ID certificate serve different purposes. The `.p8` key belongs only on the API server; it is never embedded in the desktop application. The certificate and provisioning profile are used only by the packaging machine.

## Live signed verification

The production APNs path was exercised on 2026-08-10 with a locally signed Developer ID build:

- strict recursive code-signing verification passed and the embedded profile exposed `com.apple.developer.aps-environment=production` for `chat.letagents.desktop`;
- the packaged app registered with APNs and received a production device token;
- after a graceful application quit, APNs accepted the alert with HTTP 200 and APNs ID `73505F7C-D910-9EF1-45D6-5710CC85C27B`;
- macOS rendered the alert while LetAgents was not running;
- clicking the alert cold-launched LetAgents, recovered the `UNNotificationResponse` launch payload, opened room `willow-creek`, and revealed message `msg_2`.

The production deployment did not yet contain this PR's `/desktop/push/devices` route, so the registration request correctly returned 404 and the alert was sent directly to APNs with the locally registered token for this verification. The test build used `MACOS_SKIP_NOTARIZATION=1`; it proves signing, registration, delivery, cold launch, and routing, but not the final notarized Gatekeeper installation flow.
