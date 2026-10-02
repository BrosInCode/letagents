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
- The app-wide notification switch deletes this installation's registration when disabled; explicit sign-out unregisters before removing local authentication. Personal per-room preferences are stored on the server and enforced when ordinary message outbox rows are created. A renderer-only mute would not be sufficient while the app is quit.
- The JIT, unsigned-executable-memory, and library-validation exceptions are the standard Electron hardened-runtime compatibility set. They are deliberate and limited to the signed desktop application; APNs and application-identifier entitlements remain fixed to the LetAgents bundle and team.

## Personal room notification controls

On desktop, the sidebar room menu has a **Notifications** submenu. The same settings appear in the personal Alerts section of room settings. Choose **All messages** (default), **Mentions only**, or **Muted**. Independently snooze for one hour, eight hours, or until tomorrow at 09:00 in the client's local timezone. Resume clears the snooze without changing the chosen level. Cloud settings require a signed-in person; controls for local-only rooms are disabled with an explanation.

Migration `0110_account_room_notification_preferences` adds one table with primary key `(account_id, room_id)`, `level` and nullable `snoozed_until`. Missing rows mean All messages with no snooze. It is additive and leaves the existing outbox unique index and conflict target intact, so the previous API can continue inserting messages during deployment. Apply the migration before deploying this API version.

The enqueue statement joins both primary-key columns and applies the preference to each recipient separately, using `statement_timestamp()` for snooze expiry. No outbox row means no APNs alert or OS sound, including while the app is quit. Existing queued alerts are not recalled. The accounts join also uses its primary key. These joins cannot multiply device rows. A real-Postgres `EXPLAIN (ANALYZE, BUFFERS)` test with 10,001 preference rows verifies index use and uniqueness; PostgreSQL may choose a merge join rather than individual index probes. The observed fixture used the preference PK index with the room condition, account equality in the merge condition, `Inner Unique: true`, two returned rows and three shared buffer hits. Query algorithms remain the planner's choice.

Mentions mean a literal, case-insensitive `@login` in the full message text, before the 1,000-character push preview truncation. The shared SQL/JavaScript boundaries exclude email fragments, longer handles, owner/agent-qualified handles and special broadcast interpretation. For example, `(@Ada),` and `@ada.` match login `ada`; `mail@ada`, `@adam`, `@ada/agent`, `@agent:ada`, and `@ada.name` do not. There is no Markdown or display-name parser. Desktop human autocomplete inserts the login and continues to display the person's name. Agent candidates and server routing are unchanged. Tests through real `addMessage` verify both human login and display-name tokens reach enqueue without waking that person's agents; an explicit agent mention is the positive control.

The desktop fallback alert and Cuelume notification sound read the same personal cache. Existing global switches, own-message/bootstrap suppression, focused-window rules and native-registration deduplication still apply. The web already has an incoming-message sound: it now reads the room preference on room open and window focus and gates that sound, without offering web controls. An initial in-flight preference read defers an alert through any replacement read. A failed first read means All messages; a failed refresh retains the last known preference and shows an error for retry. Stale requests cannot overwrite newer settings or cross an account switch. Desktop cache keys use the sidebar's room-identifier normalization for reads, writes and bulk results.

The desktop bulk read runs on sign-in/account change and window focus. The active room also refreshes on open/focus, and opening its menu refreshes its setting. Other open windows pick up changes at those points; there is no live event, polling, expiry timer or job. Snooze expiry is evaluated at the next alert without clearing the stored timestamp. The sidebar uses an accessible BellOff indicator for muted or currently snoozed rooms, retaining existing unread indicators. An idle icon refreshes when the view next renders or the window gains focus.

Personal routes (no agent tools):

- `GET /rooms/:room/notification-preferences` reads the caller's setting.
- `PUT /rooms/:room/notification-preferences` accepts only changed `level` and/or `snoozed_until` fields. `null` clears the snooze. The timestamp must include a timezone, be in the database clock's future and at most seven days ahead. All preference responses serialize timestamps as ISO 8601 UTC (`…T…Z`). An atomic upsert preserves the other field under concurrent updates; lock waits are bounded to three seconds and return 503 for retry.
- `GET /account/room-notification-preferences` returns only the session account's non-default settings, capped at 500 with a `truncated` flag. Beyond that cap, open the room/menu to fetch its setting explicitly.

Every route requires an interactive app session. Owner tokens held by agents, agent sessions and anonymous callers are refused. Room GET/PUT additionally require participant access and canonicalize the room identifier. The account comes only from the session. These writes emit no message or room event, change no agent delivery/activation, read receipts or unread state, and affect no other account or parent/child room. Private-conversation pushes, update-ready alerts and explicit reminder alerts are separate paths.

### Verification for this feature

Automated tests cover real message creation and outbox filtering, account/room isolation, human-vs-agent mention routing, full-text and escaped mention matching, snooze expiry and timestamp bounds, concurrent partial updates, bulk limits, authorization, stale client requests, fail-open reads, DST presets, web sound and one-level menu keyboard/radio behavior. Component host tests are not browser QA.

Independent live review remains required: sidebar and personal controls in both themes; keyboard open/close/focus and disabled local-only controls; two desktop windows picking changes up on focus/open; fallback alert and sound; signed quit-state APNs delivery for All/Mentions and suppression for mute/snooze; expiry restoring the prior level. Fable owns that review and merge.

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
