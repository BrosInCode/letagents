import XCTest
@testable import LetAgents

final class MockURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) throws -> (Int, String))!
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, json) = try Self.handler(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(json.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() { }
    static func client() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return APIClient(session: URLSession(configuration: config))
    }
    static func body(_ request: URLRequest) -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }; data.append(buffer, count: count)
            }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}

final class APIClientTests: XCTestCase {
    func testRoomPathAndHumanAuthenticationContract() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer owner-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-LetAgents-Desktop-Client"), "1")
            let url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            XCTAssertEqual(url.percentEncodedPath, "/rooms/github.com%2Fowner%2Frepo%23feature%2Fmobile/messages")
            XCTAssertEqual(url.queryItems?.first(where: { $0.name == "before" })?.value, "latest")
            return (200, #"{"messages":[],"has_older":false}"#)
        }
        let result = try await MockURLProtocol.client().messages(roomID: "github.com/owner/repo#feature/mobile", token: "owner-token")
        XCTAssertTrue(result.messages.isEmpty)
    }
    func testSendEncodesThreadAndIdempotencyIdentity() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            let body = MockURLProtocol.body(request)
            XCTAssertEqual(body["thread_root_id"] as? String, "msg_41")
            XCTAssertEqual(body["client_message_id"] as? String, "desktop-send:test")
            XCTAssertEqual(body["sender"] as? String, "EmmyMay")
            return (201, #"{"id":"msg_42","sender":"EmmyMay","text":"hello","timestamp":"2026-09-13T09:41:00Z","thread_root_id":"msg_41"}"#)
        }
        let result = try await MockURLProtocol.client().send(roomID: "a/room", token: "token", message: .init(sender: "EmmyMay", text: "hello", threadRootId: "msg_41", clientMessageId: "desktop-send:test"))
        XCTAssertTrue(result.isThreadReply)
        XCTAssertEqual(result.rootID, "msg_41")
    }
    func testAccountRoomsDecodeNestedFocusRoomsAndNullMetadata() async throws {
        MockURLProtocol.handler = { _ in (200, #"{"rooms":[{"room_id":"repo","display_name":"Project","kind":"main","git_room":null,"pinned":true,"focus_rooms":[{"room_id":"focus","display_name":"Mobile","kind":"focus"}]}]}"#) }
        let rooms = try await MockURLProtocol.client().rooms(token: "token")
        XCTAssertEqual(rooms.first?.focusRooms?.first?.displayName, "Mobile")
        XCTAssertEqual(rooms.first?.pinned, true)
    }
    func testRateLimitPreservesServerPollInterval() async throws {
        MockURLProtocol.handler = { _ in (429, #"{"error":"Polling too quickly","interval":12}"#) }
        do { let _ = try await MockURLProtocol.client().pollAuthorization("request"); XCTFail("Expected rate limit") }
        catch let error as APIError { XCTAssertEqual(error.status, 429); XCTAssertEqual(error.interval, 12) }
    }
    func testUnsafeAuthorizationURLCannotOpen() throws {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        for url in ["http://github.com/login/device", "https://github.com.evil.example/login/device", "javascript:alert(1)"] {
            let data = Data("{\"request_id\":\"a\",\"user_code\":\"b\",\"verification_uri\":\"\(url)\",\"expires_in\":900,\"interval\":5}".utf8)
            XCTAssertNil(try decoder.decode(DeviceAuthorization.self, from: data).verificationURL)
        }
    }
    func testHumanDisplayTextAndFractionalTimestamp() throws {
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        let message = try decoder.decode(Message.self, from: Data(#"{"id":"msg_1","sender":"Codex | EmmyMay's agent | Agent","text":"internal payload","display_text":"Readable update","timestamp":"2026-09-13T09:41:00.123Z","thread_root_id":"msg_1"}"#.utf8))
        XCTAssertEqual(message.body, "Readable update")
        XCTAssertEqual(message.author, "Codex")
        XCTAssertNotNil(message.date)
        XCTAssertFalse(message.isThreadReply)
    }
}

extension APIClientTests {
    func testLivePresenceDoesNotTreatHistoryOrStatusAsAConnection() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertTrue(request.url!.path.hasSuffix("/presence"))
            return (200, #"{"presence":[{"actor_label":"live","session_kind":"worker","display_name":"Live","freshness":"active","source_flags":["delivery"],"status":"idle"},{"actor_label":"stale","session_kind":"worker","display_name":"Stale","freshness":"stale","source_flags":["delivery"]},{"actor_label":"history","session_kind":"worker","display_name":"History only","freshness":"active","source_flags":["messages","presence"]},{"actor_label":"controller","session_kind":"controller","display_name":"Controller","freshness":"active","source_flags":["delivery"]}]}"#)
        }
        let result = try await MockURLProtocol.client().presence(roomID: "repo", token: "token")
        XCTAssertEqual(result.connected.map(\.id), ["live"]); XCTAssertEqual(result.connected.first?.connectionLabel, "Idle")
    }
    func testActivityHistoryUsesItsOwnEndpointAndPage() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertTrue(request.url!.path.hasSuffix("/activity-history"))
            XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "page" }?.value, "2")
            return (200, #"{"entries":[{"id":"historic","participant":{"participant_key":"old","kind":"agent","display_name":"Past agent","hidden_at":"2026-01-01"},"first_seen_at":"2026-01-01","last_seen_at":"2026-01-02","last_room_activity_at":"2026-01-02","message_count":10}],"page":2,"page_count":3,"total":70}"#)
        }
        let result = try await MockURLProtocol.client().activityHistory(roomID: "repo", token: "token", page: 2)
        XCTAssertEqual(result.entries.first?.participant.displayName, "Past agent"); XCTAssertEqual(result.pageCount, 3)
    }
    func testAttachmentDownloadUsesAuthenticatedRoomPathAndCleansRedirectHeaders() async throws {
        MockURLProtocol.handler = { request in
            XCTAssertEqual(request.url!.host, "letagents.chat")
            XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.percentEncodedPath, "/rooms/owner%2Frepo/messages/msg_1/attachments/att_1")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer owner-token")
            return (200, "Preview contents")
        }
        let file = try await MockURLProtocol.client().downloadAttachment(roomID: "owner/repo", messageID: "msg_1", attachment: .init(id: "att_1", filename: "notes.txt", downloadUrl: "https://untrusted.example/file"), token: "owner-token")
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "Preview contents")
        var redirect = URLRequest(url: URL(string: "https://storage.example/signed-file")!)
        redirect.setValue("Bearer owner-token", forHTTPHeaderField: "Authorization")
        redirect.setValue("session=secret", forHTTPHeaderField: "Cookie")
        let clean = AttachmentRedirect.redirectedRequest(redirect)
        XCTAssertNil(clean?.value(forHTTPHeaderField: "Authorization")); XCTAssertNil(clean?.value(forHTTPHeaderField: "Cookie"))
        XCTAssertNil(AttachmentRedirect.redirectedRequest(URLRequest(url: URL(string: "http://storage.example/file")!)))
    }
}
