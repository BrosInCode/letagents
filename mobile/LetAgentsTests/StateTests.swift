import XCTest
@testable import LetAgents

final class MemoryCredentials: CredentialStore {
    var token: String?
    var rejectWrites = false
    init(_ token: String? = nil) { self.token = token }
    func read() throws -> String? { token }
    func write(_ token: String) throws {
        if rejectWrites { throw APIError(status: 0, message: "Keychain unavailable") }
        self.token = token
    }
    func remove() throws { token = nil }
}
@MainActor final class StateTests: XCTestCase {
    let accountJSON = #"{"authenticated":true,"account":{"id":"a","login":"EmmyMay","display_name":"Emmy"}}"#
    func testExpiredSessionClearsCredential() async {
        MockURLProtocol.handler = { _ in (200, #"{"authenticated":false}"#) }
        let credentials = MemoryCredentials("expired")
        let store = SessionStore(client: MockURLProtocol.client(), credentials: credentials)
        await store.restore()
        XCTAssertNil(store.account); XCTAssertNil(credentials.token); XCTAssertFalse(store.restoreFailed)
    }
    func testOfflineRestoreKeepsCredentialForRetry() async {
        MockURLProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        let credentials = MemoryCredentials("saved")
        let store = SessionStore(client: MockURLProtocol.client(), credentials: credentials)
        await store.restore()
        XCTAssertNil(store.account); XCTAssertEqual(credentials.token, "saved"); XCTAssertTrue(store.restoreFailed)
    }
    func testDeviceAuthorizationPersistsOwnerToken() async {
        MockURLProtocol.handler = { request in
            if request.url!.path.hasSuffix("start") {
                return (201, #"{"request_id":"req","user_code":"ABCD","verification_uri":"https://github.com/login/device","expires_in":60,"interval":1}"#)
            }
            return (200, #"{"status":"authorized","letagents_token":"new-token","account":{"id":"a","login":"EmmyMay"}}"#)
        }
        let credentials = MemoryCredentials()
        let store = SessionStore(client: MockURLProtocol.client(), credentials: credentials)
        await store.startSignIn(); await store.waitForAuthorization()
        XCTAssertEqual(credentials.token, "new-token"); XCTAssertEqual(store.account?.login, "EmmyMay"); XCTAssertNil(store.authorization)
    }
    func testCancelSignInDoesNotPollOrPersist() async {
        var calls = 0
        MockURLProtocol.handler = { _ in
            calls += 1
            return (201, #"{"request_id":"req","user_code":"ABCD","verification_uri":"https://github.com/login/device","expires_in":60,"interval":1}"#)
        }
        let credentials = MemoryCredentials()
        let store = SessionStore(client: MockURLProtocol.client(), credentials: credentials)
        await store.startSignIn(); store.cancelSignIn(); await store.waitForAuthorization()
        XCTAssertEqual(calls, 1); XCTAssertNil(credentials.token)
    }
    func testFailedSendRetainsDraftAndSameRetryID() async {
        let accountJSON = accountJSON
        var identifiers: [String] = []
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            let body = MockURLProtocol.body(request)
            identifiers.append(body["client_message_id"] as! String)
            if identifiers.count == 1 { throw URLError(.networkConnectionLost) }
            return (201, #"{"id":"msg_12","sender":"EmmyMay","text":"Hello from my phone","timestamp":"2026-09-13T09:41:00Z","thread_root_id":"msg_12"}"#)
        }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token"))
        await session.restore()
        let store = ConversationStore(room: Room(roomId: "repo", displayName: "Project"), session: session)
        store.draft = "Hello from my phone"
        await store.send()
        XCTAssertEqual(store.draft, "Hello from my phone"); XCTAssertNotNil(store.sendError)
        await store.send()
        XCTAssertEqual(identifiers.count, 2); XCTAssertEqual(identifiers[0], identifiers[1]); XCTAssertTrue(identifiers[0].hasPrefix("desktop-send:"))
        XCTAssertEqual(store.draft, ""); XCTAssertEqual(store.messages.count, 1)
    }
    func testRoomAndThreadIngestionDedupeAndKeepRepliesInThread() {
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials())
        let room = Room(roomId: "repo", displayName: "Project")
        let store = ConversationStore(room: room, session: session)
        let root = Message(id: "msg_1", sender: "Codex", text: "Root", timestamp: "", threadRootId: "msg_1")
        let reply = Message(id: "msg_3", sender: "Emmy", text: "Reply", timestamp: "", threadRootId: "msg_1", thread: .init(rootMessageId: "msg_1", replyCount: 1))
        store.ingest(.init(messages: [root, reply, reply]))
        XCTAssertEqual(store.messages.count, 2); XCTAssertEqual(store.visibleMessages.map(\.id), ["msg_1"])
        XCTAssertEqual(store.visibleMessages.first?.thread?.replyCount, 1)
        let thread = ConversationStore(room: room, rootID: "msg_1", session: session)
        let other = Message(id: "msg_4", sender: "Claude", text: "Elsewhere", timestamp: "", threadRootId: "msg_4")
        thread.ingest(.init(messages: [reply, root, other]))
        XCTAssertEqual(thread.visibleMessages.map(\.id), ["msg_1", "msg_3"])
    }
    func testSilentPollCursorAdvancesAndCancellationEndsWatch() async {
        let accountJSON = accountJSON
        var polls = 0
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            if request.url!.path.hasSuffix("/poll") {
                polls += 1
                if polls == 1 { return (200, #"{"messages":[],"last_observed_message_id":"msg_30"}"#) }
                let after = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "after" }?.value
                XCTAssertEqual(after, "msg_30")
                throw URLError(.cancelled)
            }
            return (200, #"{"messages":[{"id":"msg_9","sender":"Codex","text":"Hi","timestamp":""}],"has_older":false}"#)
        }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token"))
        await session.restore()
        let store = ConversationStore(room: Room(roomId: "repo", displayName: "Project"), session: session)
        await store.run()
        XCTAssertEqual(polls, 2); XCTAssertFalse(store.isConnected)
    }
    func testLogoutRevokesThenClearsLocalCredential() async {
        let accountJSON = accountJSON
        var revoked = false
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            XCTAssertEqual(request.url!.path, "/auth/logout"); XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer token")
            revoked = true; return (200, #"{"success":true}"#)
        }
        let credentials = MemoryCredentials("token")
        let session = SessionStore(client: MockURLProtocol.client(), credentials: credentials)
        await session.restore(); await session.signOut()
        XCTAssertTrue(revoked); XCTAssertNil(credentials.token); XCTAssertNil(session.account)
    }
    func testDraftAndSubmissionSurviveReturningToRoom() async {
        let accountJSON = accountJSON
        var identifiers: [String] = []
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            identifiers.append(MockURLProtocol.body(request)["client_message_id"] as! String)
            throw URLError(.networkConnectionLost)
        }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token"))
        await session.restore()
        let room = Room(roomId: "repo", displayName: "Project")
        let original = ConversationStore(room: room, session: session)
        original.draft = "A draft I need to keep"
        await original.send()
        let reopened = ConversationStore(room: room, session: session)
        XCTAssertEqual(reopened.draft, original.draft)
        await reopened.send()
        XCTAssertEqual(identifiers[0], identifiers[1])
        let thread = ConversationStore(room: room, rootID: "msg_1", session: session)
        XCTAssertTrue(thread.draft.isEmpty)
    }
    func testAlreadyRevokedTokenCanStillSignOut() async {
        let accountJSON = accountJSON
        MockURLProtocol.handler = { request in
            request.url!.path == "/auth/session" ? (200, accountJSON) : (401, "{}")
        }
        let credentials = MemoryCredentials("token")
        let session = SessionStore(client: MockURLProtocol.client(), credentials: credentials)
        await session.restore(); await session.signOut()
        XCTAssertNil(credentials.token); XCTAssertNil(session.account); XCTAssertNil(session.error)
    }

    func testOldRequestCannotInvalidateNewSession() async {
        let accountJSON = accountJSON
        MockURLProtocol.handler = { _ in (200, accountJSON) }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("new-token"))
        await session.restore()
        session.handleUnauthorized(APIError(status: 401, message: "Expired"), token: "old-token")
        XCTAssertNotNil(session.account); XCTAssertEqual(session.token, "new-token")
    }

    func testKeychainRoundTripOnSignedSimulator() throws {
        let credentials = KeychainCredentialStore(account: "test-" + UUID().uuidString)
        defer { try? credentials.remove() }
        XCTAssertNil(try credentials.read())
        try credentials.write("first-token")
        XCTAssertEqual(try credentials.read(), "first-token")
        try credentials.write("refreshed-token")
        XCTAssertEqual(try credentials.read(), "refreshed-token")
        try credentials.remove()
        XCTAssertNil(try credentials.read())
    }

}

extension StateTests {
    func testReplyOnlyLatestPageRecoversRootWithoutSkippingOlderHistory() async {
        let accountJSON = accountJSON
        var historyCursors: [String] = []
        MockURLProtocol.handler = { request in
            let path = request.url!.path
            if path == "/auth/session" { return (200, accountJSON) }
            if path.hasSuffix("/poll") { throw URLError(.cancelled) }
            if path.hasSuffix("/msg_1") {
                return (200, #"{"message":{"id":"msg_1","sender":"Codex","text":"Original","timestamp":"","thread_root_id":"msg_1"}}"#)
            }
            if path.hasSuffix("/msg_2") {
                return (200, #"{"message":{"id":"msg_2","sender":"Claude","text":"Older quoted message","timestamp":"","thread_root_id":"msg_2"}}"#)
            }
            let before = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "before" }!.value!
            historyCursors.append(before)
            if before == "latest" {
                return (200, #"{"messages":[{"id":"msg_100","sender":"Emmy","text":"Reply","timestamp":"","thread_root_id":"msg_1"}],"has_older":true}"#)
            }
            return (200, #"{"messages":[{"id":"msg_99","sender":"Claude","text":"Another conversation","timestamp":"","thread_root_id":"msg_99"}],"has_older":false}"#)
        }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token"))
        await session.restore()
        let store = ConversationStore(room: Room(roomId: "repo", displayName: "Project"), session: session)
        await store.run()
        XCTAssertEqual(store.visibleMessages.map(\.id), ["msg_1"])
        do {
            let quoted = try await store.quotedMessage(id: "msg_2")
            XCTAssertEqual(quoted.body, "Older quoted message")
        } catch { XCTFail("The older quote should load: \(error)") }
        XCTAssertEqual(store.visibleMessages.map(\.id), ["msg_1"], "Reading a quote must not insert a gap into the timeline")
        await store.loadOlder()
        XCTAssertEqual(historyCursors, ["latest", "msg_100"])
        XCTAssertEqual(store.visibleMessages.map(\.id), ["msg_1", "msg_99"])
        XCTAssertFalse(store.hasOlder)
    }
    func testRepositoryGroupingPreservesBranchAndFocusLineage() throws {
        let json = #"{"rooms":[{"room_id":"repo","display_name":"Renamed main","role":"admin","git_room":{"repository":{"owner":"BrosInCode","name":"letagents"},"ref":{"name":"main","is_default":true}},"focus_rooms":[{"room_id":"branch","display_name":"mobile","kind":"focus","parent_room_id":"repo","git_room":{"repository":{"owner":"brosincode","name":"letagents"},"ref":{"name":"mobile","is_default":false}}},{"room_id":"task","display_name":"Rendering","kind":"focus","parent_room_id":"branch"},{"room_id":"done","display_name":"Earlier work","kind":"focus","parent_room_id":"repo","focus_status":"concluded"}]}]}"#
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        let projects = RoomProject.build(try decoder.decode(RoomsResponse.self, from: Data(json.utf8)).rooms)
        XCTAssertEqual(projects.count, 1)
        let project = try XCTUnwrap(projects.first)
        XCTAssertEqual(project.general?.id, "repo"); XCTAssertEqual(project.branches.map(\.id), ["branch"])
        XCTAssertEqual(project.focusRooms(for: project.branches[0]).map(\.id), ["task"])
        XCTAssertEqual(project.activeFocuses.map(\.id), ["task"])
        XCTAssertEqual(project.general?.membership, "Admin")
    }
    func testBranchOnlyProjectDoesNotInventAccessibleGeneralRoom() {
        let branch = Room(roomId: "branch", displayName: "mobile", gitRoom: .init(repository: .init(owner: "org", name: "repo"), ref: .init(name: "mobile", isDefault: false)))
        let projects = RoomProject.build([branch]); XCTAssertEqual(projects.count, 1)
        XCTAssertNil(projects[0].general); XCTAssertEqual(projects[0].branches.map(\.id), ["branch"])
    }
    func testDuplicateFlatFocusKeepsItsProjectAndParent() {
        let focus = Room(roomId: "focus", displayName: "Focus", kind: "focus")
        let parent = Room(roomId: "project", displayName: "Project", focusRooms: [focus])
        let projects = RoomProject.build([focus, parent])
        XCTAssertEqual(projects.count, 1)
        XCTAssertEqual(projects.first?.focuses.first?.parentRoomId, "project")
    }
    func testMentionHandlesDisambiguateAgentsAndExcludeHiddenAndOffline() {
        let roster = [Participant(participantKey: "one", kind: "agent", displayName: "Codex", agentKey: "emmy/codex", ownerLabel: "Emmy", activityState: "active"),
                      Participant(participantKey: "two", kind: "agent", displayName: "Codex", agentKey: "noor/codex", ownerLabel: "Noor", activityState: "active"),
                      Participant(participantKey: "three", kind: "agent", displayName: "Hidden", agentKey: "h", hiddenAt: "today"),
                      Participant(participantKey: "four", kind: "agent", displayName: "Offline", activityState: "offline")]
        XCTAssertEqual(Mentions.candidates(roster, query: "Codex").map(\.handle), ["agent:emmy/codex", "agent:noor/codex"])
        XCTAssertEqual(Mentions.candidates(roster, query: "Emmy").first?.handle, "agent:emmy/codex")
        XCTAssertFalse(Mentions.candidates(roster, query: "").contains { ["Hidden", "Offline"].contains($0.name) })
    }
    func testMentionCompletionRespectsUnicodeCaretAndExistingSuffix() throws {
        let text = "🙂 Ask @Claude about this"
        let caret = ("🙂 Ask @Cla" as NSString).length
        let query = try XCTUnwrap(Mentions.query(in: text, selection: NSRange(location: caret, length: 0)))
        XCTAssertEqual(query.query, "Cla")
        let value = Mentions.inserting(.init(id: "a", name: "Claude", handle: "Claude", detail: "Agent"), into: text, query: query)
        XCTAssertEqual(value.0, "🙂 Ask @Claude about this")
        XCTAssertEqual(value.1.location, ("🙂 Ask @Claude " as NSString).length)
        XCTAssertNil(Mentions.query(in: "email@example.com", selection: NSRange(location: 17, length: 0)))
        XCTAssertNil(Mentions.query(in: "@Claude ", selection: NSRange(location: 8, length: 0)))
    }
    func testMarkdownPreservesCodeAndBuildsListsQuotesAndTables() {
        let text = "# Plan\n\n- [x] Done\n  1. Nested\n\n```swift\nlet x = \"@Codex\"\n```\n\n> A quote\n\n| Name | Value |\n| --- | --- |\n| one | `a|b` |"
        let blocks = MessageMarkdown.blocks(text)
        XCTAssertEqual(blocks, [.heading(1, "Plan"), .item("", "Done", 0, true), .item("1.", "Nested", 1, nil),
                               .code("swift", "let x = \"@Codex\""), .quote("A quote"), .table([["Name", "Value"], ["one", "`a|b`"]])])
    }
    func testInlineMentionsAreInteractiveOutsideCodeAndLinksOnly() {
        let value = MessageMarkdown.inline("**Ready** @Codex `@Claude` [@Link](https://github.com) [unsafe](javascript:alert)")
        let mentionLinks = value.runs.compactMap { $0.link }.filter { $0.scheme == "letagents" }
        XCTAssertEqual(mentionLinks.count, 1); XCTAssertEqual(mentionLinks.first?.path, "/Codex")
        XCTAssertFalse(value.runs.compactMap { $0.link }.contains { $0.scheme == "javascript" })
        XCTAssertTrue(value.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
    }
    func testGitHubEventsMatchDesktopWireFormats() throws {
        let cases = [
            ("PR #1204 merged in BrosInCode/letagents linked to task_42: Mobile https://github.com/BrosInCode/letagents/pull/1204", "Pull request", "merged"),
            ("EmmyMay approved PR #1204 in BrosInCode/letagents", "Review", "approved"),
            ("Check \"iOS\" (GitHub Actions) failure in BrosInCode/letagents", "Check run", "failure"),
            ("EmmyMay commented on Issue #4 in BrosInCode/letagents: \"Looks good\"", "Comment", "new comment")]
        for (text, kind, status) in cases {
            let event = try XCTUnwrap(GitHubEvent.parse(Message(id: "msg_1", sender: "GitHub", text: text, source: "github", timestamp: "")))
            XCTAssertEqual(event.kind, kind); XCTAssertEqual(event.status, status)
        }
        XCTAssertNil(GitHubEvent.parse(Message(id: "msg_2", sender: "Emmy", text: "PR #1 merged", timestamp: "")))
    }
    func testPostgresAndLiveTimestampFormatsRenderSameTime() {
        let reference = MessageDate.parse("2026-09-13T09:41:00.123Z")
        XCTAssertNotNil(reference)
        XCTAssertEqual(MessageDate.parse("2026-09-13 09:41:00.123+00"), reference)
        XCTAssertEqual(MessageDate.parse("2026-09-13T10:41:00.123+01:00"), reference)
        XCTAssertNil(MessageDate.parse("unavailable"))
    }
    func testReplyTargetSurvivesFailureAndNavigation() async {
        let accountJSON = accountJSON
        var ids: [String] = [], quotes: [String?] = []
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            let body = MockURLProtocol.body(request)
            ids.append(body["client_message_id"] as! String); quotes.append(body["reply_to"] as? String)
            XCTAssertEqual(body["thread_root_id"] as? String, "msg_1")
            throw URLError(.networkConnectionLost)
        }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token")); await session.restore()
        let room = Room(roomId: "room", displayName: "Room")
        let model = ConversationStore(room: room, rootID: "msg_1", session: session)
        model.quote = ReplyPreview(message: .init(id: "msg_7", sender: "Claude", text: "The detail", timestamp: ""))
        model.draft = "Follow up"; await model.send()
        let reopened = ConversationStore(room: room, rootID: "msg_1", session: session)
        XCTAssertEqual(reopened.quote?.id, "msg_7"); XCTAssertEqual(reopened.draft, "Follow up")
        await reopened.send()
        reopened.quote = ReplyPreview(message: .init(id: "msg_8", sender: "Codex", text: "New target", timestamp: ""))
        await reopened.send()
        reopened.quote = nil; await reopened.send()
        XCTAssertEqual(quotes, ["msg_7", "msg_7", "msg_8", nil])
        XCTAssertEqual(ids[0], ids[1], "Retry must reuse the original submission")
        XCTAssertNotEqual(ids[1], ids[2], "Changing the quote creates a new submission")
        XCTAssertNotEqual(ids[2], ids[3], "Removing the quote creates a new submission")
        XCTAssertNil(ConversationStore(room: room, rootID: "msg_1", session: session).quote)
    }
    func testRoomQuoteStaysInRoomAndClearsOnlyTheSubmittedDraft() async {
        let accountJSON = accountJSON
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            let body = MockURLProtocol.body(request)
            XCTAssertNil(body["thread_root_id"])
            XCTAssertEqual(body["reply_to"] as? String, "msg_7")
            return (201, #"{"id":"msg_9","sender":"EmmyMay","text":"With context","timestamp":"","thread_root_id":"msg_9","reply_to":{"id":"msg_7","sender":"Claude","text":"Original","timestamp":""}}"#)
        }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token")); await session.restore()
        let store = ConversationStore(room: .init(roomId: "room", displayName: "Room"), session: session)
        store.quote = .init(message: .init(id: "msg_7", sender: "Claude", text: "Original", timestamp: ""))
        store.draft = "With context"; await store.send()
        XCTAssertEqual(store.visibleMessages.map(\.id), ["msg_9"])
        XCTAssertEqual(store.visibleMessages.first?.replyTo?.id, "msg_7")
        XCTAssertEqual(store.draft, ""); XCTAssertNil(store.quote); XCTAssertNil(store.sendError)
    }
}

extension StateTests {
    func testAccountSignOutClearsDraftsAndOldConversationCannotSend() async throws {
        let accountJSON = accountJSON
        var sends = 0
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            if request.url!.path == "/auth/logout" { return (200, #"{"success":true}"#) }
            sends += 1; return (500, "{}")
        }
        let credentials = MemoryCredentials("first-token")
        let session = SessionStore(client: MockURLProtocol.client(), credentials: credentials)
        await session.restore()
        let room = Room(roomId: "repo", displayName: "Room")
        let old = ConversationStore(room: room, session: session)
        old.draft = "Private draft"
        old.addAttachments([try DraftAttachment(filename: "notes.txt", contentType: "text/plain", data: Data("Private file".utf8))])
        await session.signOut()
        XCTAssertNil(session.account); XCTAssertNil(credentials.token)
        XCTAssertTrue(session.workspace.drafts.isEmpty); XCTAssertTrue(session.workspace.attachments.isEmpty)
        credentials.token = "second-token"; await session.restore()
        old.draft = "A late edit"; await old.send()
        let reopened = ConversationStore(room: room, session: session)
        XCTAssertEqual(sends, 0); XCTAssertTrue(reopened.draft.isEmpty); XCTAssertTrue(reopened.attachments.isEmpty)
    }
    func testFailedSignOutKeepsAccountAndAllowsRetry() async {
        let accountJSON = accountJSON
        var failures = 1
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            if failures > 0 { failures -= 1; throw URLError(.notConnectedToInternet) }
            return (200, #"{"success":true}"#)
        }
        let credentials = MemoryCredentials("token")
        let session = SessionStore(client: MockURLProtocol.client(), credentials: credentials)
        await session.restore(); await session.signOut()
        XCTAssertNotNil(session.account); XCTAssertEqual(credentials.token, "token"); XCTAssertNotNil(session.error)
        await session.signOut(); XCTAssertNil(session.account); XCTAssertNil(credentials.token)
    }
    func testAttachmentOnlySendRetryKeepsUploadsAndMessageIdentityInThread() async throws {
        let accountJSON = accountJSON
        var uploads = 0
        var identifiers: [String] = []
        var references: [[String]] = []
        MockURLProtocol.handler = { request in
            let path = request.url!.path
            if path == "/auth/session" { return (200, accountJSON) }
            if path.hasSuffix("/uploads") {
                return (201, #"{"upload_id":"upl_1234567890123456","upload_url":"https://storage.example/upload","method":"PUT","headers":{"Content-Type":"text/plain"}}"#)
            }
            if request.httpMethod == "PUT" { uploads += 1; XCTAssertNil(request.value(forHTTPHeaderField: "Authorization")); return (200, "") }
            let body = MockURLProtocol.body(request)
            XCTAssertEqual(body["text"] as? String, "")
            XCTAssertEqual(body["thread_root_id"] as? String, "msg_1")
            XCTAssertEqual(body["reply_to"] as? String, "msg_2")
            identifiers.append(body["client_message_id"] as! String)
            references.append((body["attachments"] as! [[String: String]]).map { $0["upload_id"]! })
            if identifiers.count == 1 { throw URLError(.networkConnectionLost) }
            return (201, #"{"id":"msg_3","sender":"EmmyMay","text":"","timestamp":"","thread_root_id":"msg_1","attachments":[{"id":"att_1","filename":"notes.txt","download_url":"/rooms/repo/messages/msg_3/attachments/att_1"}]}"#)
        }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token"))
        await session.restore()
        let room = Room(roomId: "repo", displayName: "Room")
        let first = ConversationStore(room: room, rootID: "msg_1", session: session)
        first.quote = ReplyPreview(message: .init(id: "msg_2", sender: "Codex", text: "Please attach the notes", timestamp: ""))
        first.addAttachments([try DraftAttachment(filename: "notes.txt", contentType: "text/plain", data: Data("Notes".utf8))])
        XCTAssertTrue(first.canSend); await first.send()
        XCTAssertNotNil(first.sendError); XCTAssertEqual(first.attachments.count, 1)
        let reopened = ConversationStore(room: room, rootID: "msg_1", session: session)
        XCTAssertEqual(reopened.attachments.count, 1); await reopened.send()
        XCTAssertEqual(uploads, 1); XCTAssertEqual(identifiers.count, 2); XCTAssertEqual(identifiers[0], identifiers[1]); XCTAssertEqual(references[0], references[1])
        XCTAssertTrue(reopened.attachments.isEmpty); XCTAssertNil(reopened.quote); XCTAssertFalse(reopened.canSend)
    }
    func testExpiredAttachmentCanBeUploadedAgainAfterDefiniteRejection() async throws {
        let accountJSON = accountJSON
        var uploadCount = 0, sends = 0
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            if request.url!.path.hasSuffix("/uploads") {
                uploadCount += 1
                return (201, "{\"upload_id\":\"upl_\(uploadCount)234567890123456\",\"upload_url\":\"https://storage.example/upload\",\"method\":\"PUT\",\"headers\":{}}")
            }
            if request.httpMethod == "PUT" { return (200, "") }
            sends += 1
            if sends == 1 { return (400, #"{"error":"attachment upload not found or expired"}"#) }
            return (201, #"{"id":"msg_3","sender":"EmmyMay","text":"","timestamp":""}"#)
        }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token"))
        await session.restore()
        let model = ConversationStore(room: .init(roomId: "room", displayName: "Room"), session: session)
        model.addAttachments([try DraftAttachment(filename: "notes.txt", contentType: "text/plain", data: Data("Notes".utf8))])
        await model.send(); XCTAssertTrue(model.sendError?.contains("expired") == true)
        await model.send(); XCTAssertEqual(uploadCount, 2); XCTAssertTrue(model.attachments.isEmpty)
    }
    func testAttachmentLimitsRemovalAndNativeFileImport() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("A real imported file".utf8).write(to: url)
        let file = try DraftAttachment.read(url)
        XCTAssertEqual(String(data: file.data, encoding: .utf8), "A real imported file")
        XCTAssertEqual(file.contentType, "text/plain")
        XCTAssertThrowsError(try DraftAttachment(filename: "empty", contentType: "text/plain", data: Data()))
        XCTAssertThrowsError(try DraftAttachment(filename: "large", contentType: "text/plain", data: Data(count: DraftAttachment.maximumBytes + 1)))
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials())
        let model = ConversationStore(room: .init(roomId: "room", displayName: "Room"), session: session)
        let files = try (0..<5).map { try DraftAttachment(filename: "\($0).txt", contentType: "text/plain", data: Data("hello".utf8)) }
        model.addAttachments(files)
        XCTAssertEqual(model.attachments.count, 4); XCTAssertNotNil(model.attachmentError)
        model.removeAttachment(files[0].id)
        XCTAssertEqual(model.attachments.count, 3); XCTAssertNil(model.attachmentError)
    }
}

extension StateTests {
    func testReturningDuringAttachmentSendSharesProgressAndClearsTheSameDraft() async throws {
        let accountJSON = accountJSON
        let finish = DispatchSemaphore(value: 0)
        var messageRequests = 0
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            if request.url!.path.hasSuffix("/uploads") {
                return (201, #"{"upload_id":"upl_1234567890123456","upload_url":"https://storage.example/upload","method":"PUT","headers":{}}"#)
            }
            if request.httpMethod == "PUT" { return (200, "") }
            messageRequests += 1
            _ = finish.wait(timeout: .now() + 5)
            return (201, #"{"id":"msg_3","sender":"EmmyMay","text":"A file","timestamp":""}"#)
        }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token"))
        await session.restore()
        let room = Room(roomId: "repo", displayName: "Room")
        let original = ConversationStore(room: room, session: session)
        original.draft = "A file"
        original.addAttachments([try DraftAttachment(filename: "notes.txt", contentType: "text/plain", data: Data("Notes".utf8))])
        let sending = Task { await original.send() }
        let deadline = Date().addingTimeInterval(3)
        while !original.isSending && Date() < deadline { await Task.yield() }
        let reopened = ConversationStore(room: room, session: session)
        XCTAssertTrue(reopened.isSending); XCTAssertFalse(reopened.canSend)
        XCTAssertEqual(reopened.attachments.count, 1)
        await reopened.send()
        finish.signal(); await sending.value
        XCTAssertEqual(messageRequests, 1)
        XCTAssertTrue(reopened.attachments.isEmpty); XCTAssertTrue(reopened.draft.isEmpty); XCTAssertFalse(reopened.isSending)
    }
}

extension StateTests {
    func testWorkspaceRestoresQuotedAttachmentDraftAndRetryIdentityAfterRelaunch() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let accountJSON = accountJSON
        var identifiers: [String] = []
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            if request.url!.path.hasSuffix("/attachments/uploads") {
                return (200, #"{"upload_id":"upl_saved","upload_url":"https://storage.example/file","method":"PUT","headers":{}}"#)
            }
            if request.httpMethod == "PUT" { return (200, "{}") }
            let body = MockURLProtocol.body(request)
            identifiers.append(body["client_message_id"] as! String)
            XCTAssertEqual(body["reply_to"] as? String, "msg_1")
            XCTAssertEqual((body["attachments"] as? [[String: String]])?.first?["upload_id"], "upl_saved")
            throw URLError(.networkConnectionLost)
        }
        let credentials = MemoryCredentials("token")
        let workspace = WorkspaceStore(disk: WorkspaceDisk(directory: directory))
        let session = SessionStore(client: MockURLProtocol.client(), credentials: credentials, workspace: workspace)
        await session.restore()
        let room = Room(roomId: "repo", displayName: "Project")
        let original = ConversationStore(room: room, rootID: "msg_1", session: session)
        original.draft = "Keep the whole reply"
        original.quote = ReplyPreview(message: Message(id: "msg_1", sender: "Emmy", text: "Original", timestamp: ""))
        original.addAttachments([try DraftAttachment(filename: "notes.txt", contentType: "text/plain", data: Data("Saved bytes".utf8))])
        workspace.lastConversation = ConversationRoute(roomID: room.id, rootID: "msg_1")
        await original.send()
        let saved = await workspace.flush(); XCTAssertTrue(saved)
        let restoredWorkspace = WorkspaceStore(disk: WorkspaceDisk(directory: directory))
        let restoredSession = SessionStore(client: MockURLProtocol.client(), credentials: credentials, workspace: restoredWorkspace)
        await restoredSession.restore()
        let restored = ConversationStore(room: room, rootID: "msg_1", session: restoredSession)
        XCTAssertEqual(restored.draft, original.draft)
        XCTAssertEqual(restored.quote, original.quote)
        XCTAssertEqual(restored.attachments, original.attachments)
        XCTAssertEqual(restoredWorkspace.lastConversation, workspace.lastConversation)
        await restored.send()
        XCTAssertEqual(identifiers.count, 2); XCTAssertEqual(identifiers.first, identifiers.last)
    }

    func testWorkspaceAccountIsolationSignOutAndSuccessfulSendCleanup() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let disk = WorkspaceDisk(directory: directory)
        let workspace = WorkspaceStore(disk: disk)
        await workspace.load(accountID: "a")
        workspace.drafts["repo|room"] = "Private"
        let saved = await workspace.flush(); XCTAssertTrue(saved)
        await workspace.load(accountID: "b")
        XCTAssertTrue(workspace.drafts.isEmpty)
        await workspace.load(accountID: "a")
        XCTAssertEqual(workspace.drafts["repo|room"], "Private")
        try await workspace.clear()
        await workspace.load(accountID: "a")
        XCTAssertTrue(workspace.drafts.isEmpty)
        let accountJSON = accountJSON
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            return (200, #"{"id":"msg_2","sender":"EmmyMay","text":"Sent","timestamp":""}"#)
        }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token"), workspace: workspace)
        await session.restore()
        let conversation = ConversationStore(room: Room(roomId: "repo", displayName: "Project"), session: session)
        conversation.draft = "Sent"; await conversation.send()
        let restored = try await WorkspaceDisk(directory: directory).load(accountID: "a")
        XCTAssertTrue(restored.drafts.isEmpty); XCTAssertTrue(restored.submissions.isEmpty)
    }

    func testWorkspaceSaveFailureDoesNotSendAnUnrecoverableMessage() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data("Not a directory".utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let accountJSON = accountJSON
        var sends = 0
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            sends += 1; return (500, "{}")
        }
        let workspace = WorkspaceStore(disk: WorkspaceDisk(directory: file))
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token"), workspace: workspace)
        await session.restore()
        let conversation = ConversationStore(room: Room(roomId: "repo", displayName: "Project"), session: session)
        conversation.draft = "Keep me"; await conversation.send()
        XCTAssertEqual(sends, 0); XCTAssertEqual(conversation.draft, "Keep me")
        XCTAssertNotNil(conversation.sendError); XCTAssertNotNil(workspace.saveError)
    }

    func testDirectoryRefreshPreservesLoadedRoomsOnFailureAndUpdatesNestedRooms() async {
        let accountJSON = accountJSON
        var refreshes = 0
        MockURLProtocol.handler = { request in
            if request.url!.path == "/auth/session" { return (200, accountJSON) }
            refreshes += 1
            if refreshes == 2 { throw URLError(.notConnectedToInternet) }
            let name = refreshes == 1 ? "Earlier" : "Updated"
            return (200, "{\"rooms\":[{\"room_id\":\"repo\",\"display_name\":\"Project\",\"focus_rooms\":[{\"room_id\":\"focus\",\"display_name\":\"\(name)\",\"kind\":\"focus\",\"latest_message_at\":\"2026-10-26T12:00:00Z\"}]}]}")
        }
        let session = SessionStore(client: MockURLProtocol.client(), credentials: MemoryCredentials("token"))
        await session.restore()
        let directory = RoomDirectoryStore(session: session)
        await directory.refresh()
        XCTAssertEqual(directory.room("focus")?.displayName, "Earlier")
        await directory.refresh()
        XCTAssertEqual(directory.room("focus")?.displayName, "Earlier"); XCTAssertNotNil(directory.error)
        await directory.refresh()
        XCTAssertEqual(directory.room("focus")?.displayName, "Updated"); XCTAssertNil(directory.error)
        XCTAssertEqual(directory.recentRooms.map(\.id), ["focus"])
    }
}


extension StateTests {
    func testWorkspaceRecoveryPreservesRetryIdentityAndEditsAfterLoadFailure() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = WorkspaceStore(disk: WorkspaceDisk(directory: directory))
        await original.load(accountID: "a")
        let attachment = try DraftAttachment(filename: "notes.txt", contentType: "text/plain", data: Data("Notes".utf8))
        original.drafts["repo|room"] = "Possibly already sent"
        original.attachments["repo|room"] = [attachment]
        original.submissions["repo|room"] = MessageSubmission(text: "Possibly already sent", id: "desktop-send:original", replyTo: nil, attachmentIDs: [attachment.id])
        let saved = await original.flush(); XCTAssertTrue(saved)
        let folder = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        let file = folder.appendingPathComponent(attachment.id.uuidString)
        try FileManager.default.removeItem(at: file)
        let recovering = WorkspaceStore(disk: WorkspaceDisk(directory: directory))
        await recovering.load(accountID: "a")
        XCTAssertTrue(recovering.needsRecovery)
        recovering.drafts["other|room"] = "A new edit while recovery is unavailable"
        recovering.submissions["repo|room"] = MessageSubmission(text: "Possibly already sent", id: "desktop-send:not-sent", replyTo: nil)
        try attachment.data.write(to: file)
        await recovering.retrySaving()
        XCTAssertFalse(recovering.needsRecovery); XCTAssertNil(recovering.saveError)
        XCTAssertEqual(recovering.drafts["other|room"], "A new edit while recovery is unavailable")
        XCTAssertEqual(recovering.attachments["repo|room"], [attachment])
        XCTAssertEqual(recovering.submissions["repo|room"]?.id, "desktop-send:original")
    }

    func testCorruptWorkspaceCannotLeakPreviousAccountAndCanBeExplicitlyReset() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let workspace = WorkspaceStore(disk: WorkspaceDisk(directory: directory))
        await workspace.load(accountID: "b")
        workspace.drafts["repo|room"] = "B draft"
        let saved = await workspace.flush(); XCTAssertTrue(saved)
        let folder = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        try Data("Invalid JSON".utf8).write(to: folder.appendingPathComponent("workspace.json"))
        await workspace.load(accountID: "a")
        workspace.drafts["repo|room"] = "Private A draft"
        await workspace.load(accountID: "b")
        XCTAssertTrue(workspace.drafts.isEmpty); XCTAssertTrue(workspace.needsRecovery)
        await workspace.retrySaving()
        XCTAssertTrue(workspace.needsRecovery)
        await workspace.resetSavedDrafts()
        XCTAssertFalse(workspace.needsRecovery); XCTAssertNil(workspace.saveError)
        workspace.drafts["repo|room"] = "Fresh B draft"
        let fresh = await workspace.flush(); XCTAssertTrue(fresh)
        let loaded = try await WorkspaceDisk(directory: directory).load(accountID: "b")
        XCTAssertEqual(loaded.drafts["repo|room"], "Fresh B draft")
    }
}
