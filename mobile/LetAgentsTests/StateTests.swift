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

}
