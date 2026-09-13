#if DEBUG
import Foundation

// Only enabled by the UI-test launch argument. Release builds contain no fixture transport.
@MainActor enum UITestFixtures {
    static func makeSession() -> SessionStore {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FixtureProtocol.self]
        return SessionStore(client: APIClient(session: URLSession(configuration: configuration)), credentials: MemoryCredentials())
    }
    private final class MemoryCredentials: CredentialStore {
        var token: String?
        func read() throws -> String? { token }
        func write(_ token: String) throws { self.token = token }
        func remove() throws { token = nil }
    }
}
private final class FixtureProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var sent: [[String: Any]] = []
    private static var sequence = 10
    private static var attempts = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        let path = request.url!.path
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let account: [String: Any] = ["id": "account-test", "login": "EmmyMay", "display_name": "Emmy Leke"]
        let roomID = "github.com/brosincode/letagents"
        let root = Self.message(1, sender: "Codex", text: "The mobile flow is ready to review. GitHub → projects → conversation.")
        var rootWithReplies = root
        rootWithReplies["thread"] = ["root_message_id": "msg_1", "reply_count": 2]
        let defaults = [rootWithReplies, Self.message(2, sender: "EmmyMay", text: "Keep it simple. I want to pick up the conversation on my phone."), Self.message(3, sender: "Claude", text: "On it. Your rooms will be waiting right here when you sign in.")]
        var result: [String: Any] = [:]
        var status = 200
        if path == "/auth/device/start" {
            result = ["request_id": "test-device", "user_code": "ABCD-1234", "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 1]
        } else if path.contains("/auth/device/poll/") {
            result = ["status": "authorized", "letagents_token": "fixture-token", "account": account]
        } else if path == "/auth/logout" { result = ["success": true] }
        else if path == "/auth/session" { result = ["authenticated": true, "account": account] }
        else if path == "/account/rooms" {
            if ProcessInfo.processInfo.arguments.contains("--empty-rooms") { result = ["rooms": []] }
            else {
                result = ["rooms": [["room_id": roomID, "display_name": "LetAgents", "pinned": true,
                    "git_room": ["repository": ["owner": "BrosInCode", "name": "letagents"], "ref": ["name": "main"]],
                    "focus_rooms": [["room_id": "focus-mobile", "display_name": "Mobile companion", "kind": "focus"]]],
                    ["room_id": "design-notes", "display_name": "Design notes", "pinned": false, "focus_rooms": []]]]
            }
        } else if path.hasSuffix("/messages") && request.httpMethod == "POST" {
            Self.attempts += 1
            let body = readBody()
            if ProcessInfo.processInfo.arguments.contains("--fail-first-send") && Self.attempts == 1 {
                status = 503; result = ["error": "Fixture unavailable"]
            } else if let existing = Self.sent.first(where: { ($0["client_message_id"] as? String) == (body["client_message_id"] as? String) }) { result = existing }
            else {
                Self.sequence += 1
                result = Self.message(Self.sequence, sender: body["sender"] as? String ?? "EmmyMay", text: body["text"] as? String ?? "")
                result["client_message_id"] = body["client_message_id"]
                if let root = body["thread_root_id"] as? String { result["thread_root_id"] = root }
                Self.sent.append(result)
                status = 201
            }
        } else if path.hasSuffix("/thread") {
            result = ["root": rootWithReplies, "replies": [Self.message(4, sender: "EmmyMay", text: "Can I reply to a specific message?", root: "msg_1"), Self.message(5, sender: "Codex", text: "Yes. Replies stay in this thread.", root: "msg_1")] + Self.sent.filter { ($0["thread_root_id"] as? String) == "msg_1" }, "has_older": false]
        } else if path.hasSuffix("/messages/poll") {
            let after = query.first { $0.name == "after" }?.value ?? "msg_0"
            let number = Int(after.replacingOccurrences(of: "msg_", with: "")) ?? 0
            let messages = Self.sent.filter { (Int(($0["id"] as! String).replacingOccurrences(of: "msg_", with: "")) ?? 0) > number }
            result = ["messages": messages, "has_more": false, "last_observed_message_id": messages.last?["id"] ?? after]
        } else if path.hasSuffix("/messages") { result = ["messages": defaults + Self.sent, "has_more": false, "has_older": false] }
        else { status = 404; result = ["error": "No fixture route"] }
        let data = try! JSONSerialization.data(withJSONObject: result)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
    private static func message(_ id: Int, sender: String, text: String, root: String? = nil) -> [String: Any] {
        ["id": "msg_\(id)", "sender": sender, "text": text, "timestamp": "2026-09-13T09:41:00Z", "source": "browser", "thread_root_id": root ?? "msg_\(id)"]
    }
    private func readBody() -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}
#endif
