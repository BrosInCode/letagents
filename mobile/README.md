# LetAgents for iPhone

A native SwiftUI companion for continuing your LetAgents conversations away from your computer. Requires iOS 17 or later. No third-party packages or backend changes.

## Run it

1. Open `mobile/LetAgents.xcodeproj` in Xcode 26.2 or later.
2. Select the **LetAgents** scheme and an iPhone simulator, then Run.
3. For a physical iPhone, signing is configured for team `26836KWQM6`. Sign into that team in Xcode, connect the phone, and Run. Select your own development team if working from a fork.
4. Tap **Continue with GitHub**, copy the code, and open GitHub. Approve the existing LetAgents connection and return to the app. Your account's rooms load automatically.

The default app always connects to **https://letagents.chat**. No client secret, personal access token, or manual server configuration is required. The app stores the LetAgents owner token in the iOS Keychain, accessible only while this device is unlocked and excluded from device migration. Sign out revokes that token on the server and removes it locally.

## Included

- GitHub device authorization with code copying, browser presentation, expiry, cancellation, and polling backoff.
- Projects grouped by GitHub owner and repository, with a distinct General room, collapsible branches, and focus rooms under their actual parent branch. Includes pinned filtering, search, and pull-to-refresh.
- Live conversations while the app is active, reconnect/catch-up after backgrounding, and older-message pagination.
- Thread previews with participants, latest reply and unread state; an All/Unread thread inbox; original-message context and quoted replies. Read position is synchronized through the existing API.
- Swipe right or choose **Quote reply** to quote directly in a room or within a thread. **Reply in thread** opens a separate thread. The composer lets you inspect, replace, or cancel the quote; failed sends preserve it. Tap a sent quote to highlight the loaded original, then **Back to reply** to return. Older originals open in a sheet with full Markdown, copy, and retry.
- Native Markdown headings, lists, task lists, quotes, tables, inline styles, and horizontally scrolling code blocks with highlighting, copy, and full-screen expansion.
- Caret-aware @ mention completion from the room roster, owner labels for agents with the same name, highlighted mentions, and participant details.
- Structured GitHub cards for pull requests, issues, reviews, comments, and checks, with status and source links.
- Drafts retained during navigation while the app is open. Failed sends keep their submission ID so retrying cannot duplicate an accepted message.
- Account details, session restoration, explicit connection errors, empty states, and sign-out.
- Native navigation, software-keyboard avoidance, Dynamic Type, accessibility labels, and light/dark appearance.

Project/agent administration, background push notifications, and attachment upload/download are outside this first companion release. Existing attachments display their filenames; open them in the desktop app. Drafts and message history are held in memory, not persisted offline. Account room discovery uses the existing server's maximum of 100 parent rooms.

## Design

[Open the revised mobile design in Figma](https://www.figma.com/design/KFZwutz1ys5Yfore4911L9/LetAgents--Welcome?node-id=42-8181), on **Mobile · companion**, frame **Mobile v2 · Soft tangerine**. It covers projects by owner, project/branch/focus hierarchy, rich conversations, and threads with mentions. The earlier welcome, GitHub authorization, and account screens remain on the same page.

![On-theme mobile design](Design/mobile-v2.png)

[Quote-reply interaction designs](https://www.figma.com/design/KFZwutz1ys5Yfore4911L9/LetAgents--Welcome?node-id=47-8361) are in **Mobile · Quote replies** on the same page, with an export at `Design/quote-replies.png`.

The palette comes from the existing **Welcome / Soft tangerine** (`21:652`), **Onboarding / First room** (`22:1151`), and **Inbox / Conversation preview** (`41:6473`) designs:

| Role | Dark color |
| --- | --- |
| Background | `#1C1B1A` |
| Surface | `#252422` |
| Primary text | `#F3F0EA` |
| Tangerine accent | `#DFB895` |
| Secondary text | `#B5B0A8` |
| Separator | `#3A3835` |
| Outgoing message | `#39312A` |

These are editable Figma text/vector layouts. Figma uses the available Inter font; SwiftUI uses native iOS text styles for Dynamic Type. `Theme.swift` preserves the dark source colors and supplies matching light-mode colors. Navigation and keyboard controls remain native iOS. The app icon reuses the desktop artwork from `../brand/letagents-app-icon.png`: the original white mark and green dot, at the same scale and position. Its 1024px iOS PNG fills the desktop asset’s transparent outer margin with black and removes the alpha channel; iOS supplies the corner mask. `Design/AppIcon.svg` preserves the same vector artwork with an opaque background. The earlier Figma icon (`45:8355`) is superseded by this desktop asset. `Design/mobile-flow.png` records the initial six-screen pass; `mobile-v2.png` is the current conversation and hierarchy direction.

## API contract

| Flow | Existing endpoint |
| --- | --- |
| Start/poll GitHub sign-in | `POST /auth/device/start`, `GET /auth/device/poll/:requestId` |
| Restore session / sign out | `GET /auth/session`, `POST /auth/logout` |
| Project and focus rooms | `GET /account/rooms?limit=100` |
| Latest/older conversation | `GET /rooms/:roomId/messages?before=latest` or `before=msg_N` |
| Live catch-up | `GET /rooms/:roomId/messages/poll?after=msg_N&timeout=25000` |
| Original-message recovery | `GET /rooms/:roomId/messages/:messageId` |
| Room roster | `GET /rooms/:roomId/participants` |
| Thread history / inbox | `GET /rooms/:roomId/messages/:rootId/thread`, `GET /rooms/:roomId/messages/threads` |
| Thread read position | `PUT /rooms/:roomId/messages/:rootId/thread/read` |
| Send/reply | `POST /rooms/:roomId/messages` |

Authenticated requests use the existing `Authorization: Bearer` and `X-LetAgents-Desktop-Client: 1` human-companion contract. Despite the historical header name, this is needed for owner-token writes to stay human messages and preserve account-scoped agent routing. Sends use `desktop-send:<UUID>` as `client_message_id`, including on retries, and `thread_root_id` for thread replies, with optional `reply_to` for quoted message context. Poll cursors advance through `last_observed_message_id` even when no visible messages arrive.

## TestFlight

The iPhone app uses bundle ID `chat.letagents.mobile`, version `1.0`, and build `2`. Its [App Store Connect record](https://appstoreconnect.apple.com/apps/6811631290/distribution) is app `6811631290`, SKU `letagents-ios`, with English (U.S.) as its primary language. Signing is automatic for team `26836KWQM6`. The app uses only Apple-provided HTTPS and Keychain encryption, so its generated Info.plist declares `ITSAppUsesNonExemptEncryption = false`, following [Apple's encryption documentation](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations).

Run these commands from the repository root with the Apple Developer account signed into Xcode:

```sh
xcodebuild -project mobile/LetAgents.xcodeproj -scheme LetAgents \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath mobile/build-release \
  -archivePath mobile/build-release/LetAgents-1.0-2.xcarchive \
  -allowProvisioningUpdates archive

xcodebuild -exportArchive \
  -archivePath mobile/build-release/LetAgents-1.0-2.xcarchive \
  -exportOptionsPlist mobile/ExportOptions.plist \
  -exportPath mobile/build-release/TestFlight-2 \
  -allowProvisioningUpdates
```

The second command uploads the build to App Store Connect. After Apple processes it, assign it to the intended TestFlight group. Uploading does not submit an App Store release. Increment `CURRENT_PROJECT_VERSION` in both app configurations and use a new archive path before subsequent uploads; automatic build-number changes are disabled so the uploaded version matches the repository. Archives, export output, and signing credentials are not committed.

Build **1.0 (2)** is available in the internal **Mobile Preview** group for both existing testers. App Store Connect confirms the teammate installed build 2; the owner previously installed build 1 and can update through TestFlight. Automatic distribution is off, so assign later builds to this group explicitly.

The successful upload used a fresh Apple Distribution certificate paired with the **LetAgents Mobile Distribution** private key in the local login keychain. The certificate expires September 13, 2027; its SHA-1 fingerprint is `13C78D08DB9E307D8A805F44001B43BC63F690A7`. Existing signing identities remain intact. A certificate download alone does not provide the matching private key on another Mac.

## Verification

```sh
xcodebuild -project mobile/LetAgents.xcodeproj -scheme LetAgents \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath mobile/build test -parallel-testing-enabled NO

xcodebuild -project mobile/LetAgents.xcodeproj -scheme LetAgents \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath mobile/build-release build CODE_SIGNING_ALLOWED=NO
```

Keep normal signing enabled for simulator builds and tests. Xcode uses **Sign to Run Locally** automatically; an unsigned simulator executable cannot access Keychain. `CODE_SIGNING_ALLOWED=NO` is only used above for the non-installable device Release build check.

The API/state tests cover a real isolated Keychain round-trip, authentication and request encoding, session lifecycle, polling cursors, pagination when the latest page contains only thread replies, repository/branch/focus lineage, mention disambiguation and Unicode insertion, Markdown, GitHub events, timestamps, and retry/draft preservation. XCUITest covers sign-in through a room and thread to sign-out, failed-send retry, an empty account, branch focus-room navigation, selecting the correct agent mention, thread inbox and quoted replies, and code/GitHub rendering. Test cases use an in-process URLProtocol transport; they never post test messages to production.

Verified on September 13, 2026: **30 API/state tests and all nine XCUITest flows passed on iPhone 17 Pro**. Five messaging, quote, and code flows also passed on iPhone 16e with accessibility-size text in light appearance. Checks include rapid typing, swipe-to-quote, cancellation, quote-preserving retries, original-message jumps and return, older-quote fetch/retry, and horizontal code scrolling. Dark and large-text light screenshots were inspected. The generic iPhone Release build passed. The earlier project hierarchy and agent-selection flows also passed on iPhone 16e before the quote-reply update.

`UITestFixtures.swift` exists only in DEBUG builds and is activated only with the `--ui-testing` launch argument. Normal launches use the production URLSession transport, and Release builds contain no fixture transport.

Production smoke checks on September 13, 2026 confirmed GitHub device authorization and restored the signed-in account in the simulator. Its actual projects, branches, focus rooms, messages, agent attribution, and GitHub activity were inspected.

Release verification on September 13, 2026: the signed `1.0 (1)` archive succeeded, passed `codesign --verify --deep --strict`, and contains the expected bundle ID, version, and Boolean encryption declaration. Export and upload succeeded with the fresh distribution certificate. App Store Connect finished processing build 1, which was distributed through **Mobile Preview**. App Store Connect confirms build 1 was installed on the owner’s iPhone 17 Pro Max and the teammate’s iPhone 13 Pro Max; this is installation evidence, not a full physical-device regression test. No App Store release was submitted; the branch remains `mobile` pending human inspection.

Build **1.0 (2)** restores the existing desktop icon. Its signed archive and `codesign --verify --deep --strict` checks passed, export/upload succeeded, and Apple finished processing it. **Mobile Preview** has both builds and two testers, with the teammate already showing **Installed 1.0 (2)**. The simulator build installed and launched successfully; the compiled 120px icon was visually checked against the desktop artwork. The Figma icon frame still contains the superseded build 1 artwork; use the committed desktop-derived icon as the source of truth.
