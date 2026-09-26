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
    private static var quoteAttempts = 0
    private static var uploadMetadata: [String: [String: Any]] = [:]
    private static var uploadData: [String: Data] = [:]
    private static var downloads: [String: Data] = [:]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        let path = request.url!.path
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let account: [String: Any] = ["id": "account-test", "login": "EmmyMay", "display_name": "Emmy Leke"]
        let roomID = "github.com/brosincode/letagents"
        let rich = ProcessInfo.processInfo.arguments.contains("--rich-messages")
        let root = Self.message(1, sender: "Codex", text: rich ? """
        ## Ready for review
        @EmmyMay the conversation now has:
        - [x] Clear room hierarchy
        - [x] Replies with context
        - [ ] Check the small screen

        ```swift
        let room = client.room("mobile-companion/quoted-replies/keep-horizontal-code-scrolling")
        await room.send(message)
        ```

        > Keep the conversation close to the work.

        | Screen | Status |
        | --- | --- |
        | Projects | Ready |
        | Threads | Ready |
        """ : "The mobile flow is ready to review. GitHub → projects → conversation.")
        var rootWithReplies = root
        rootWithReplies["source"] = "agent"
        rootWithReplies["agent_identity"] = ["display_name": "Codex", "owner_label": "EmmyMay", "agent_key": "codex-emmy"]
        let summary: [String: Any] = ["root_message_id": "msg_1", "reply_count": 2, "unread_count": 1, "has_unread": true,
            "latest_reply": Self.message(5, sender: "Codex", text: "Yes. Replies stay in this thread.", root: "msg_1"),
            "participants": [["sender": "EmmyMay", "message_count": 1], ["sender": "Codex", "message_count": 1]]]
        rootWithReplies["thread"] = summary
        let threadReplies = [Self.message(4, sender: "EmmyMay", text: "Can I reply to a specific message?", root: "msg_1"), Self.message(5, sender: "Codex", text: "Yes. Replies stay in this thread.", root: "msg_1")]
        var defaults = [rootWithReplies, Self.message(2, sender: "EmmyMay", text: "Keep it simple. I want to pick up the conversation on my phone."), Self.message(3, sender: "Claude", text: "On it. Your rooms will be waiting right here when you sign in.")]
        if rich {
            var event = Self.message(7, sender: "GitHub", text: "PR #1204 ready for review in BrosInCode/letagents linked to task_42: Native mobile companion https://github.com/BrosInCode/letagents/pull/1204")
            event["source"] = "github"; defaults.append(event)
        }
        if ProcessInfo.processInfo.arguments.contains("--older-quote") {
            var quoted = Self.message(100, sender: "EmmyMay", text: "An older message has the context.")
            quoted["reply_to"] = rootWithReplies
            defaults = [quoted]
        }
        var result: [String: Any] = [:]
        var status = 200
        var binary: Data?
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
                    "git_room": ["repository": ["owner": "BrosInCode", "name": "letagents"], "ref": ["name": "main", "default_branch": "main", "is_default": true]],
                    "role": "admin", "focus_rooms": [
                        ["room_id": "focus-mobile", "display_name": "Mobile companion", "kind": "focus", "parent_room_id": roomID, "focus_status": "active", "source_task_id": "task_42"],
                        ["room_id": "branch-mobile", "display_name": "mobile", "kind": "focus", "parent_room_id": roomID,
                        "git_room": ["repository": ["owner": "BrosInCode", "name": "letagents"], "ref": ["name": "mobile", "default_branch": "main", "is_default": false]]],
                        ["room_id": "focus-code", "display_name": "Code rendering", "kind": "focus", "parent_room_id": "branch-mobile", "focus_status": "active"],
                        ["room_id": "focus-old", "display_name": "Finished exploration", "kind": "focus", "parent_room_id": roomID, "focus_status": "concluded"]]],
                    ["room_id": "design-notes", "display_name": "Design notes", "pinned": false, "focus_rooms": []]]]
            }
        } else if path.hasSuffix("/attachments/uploads") && request.httpMethod == "POST" {
            let id = "upl_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
            let metadata = readBody()
            Self.uploadMetadata[id] = metadata
            result = ["upload_id": id, "upload_url": "https://storage.example/" + id, "method": "PUT", "headers": ["Content-Type": metadata["mime_type"] ?? "application/octet-stream"]]
        } else if request.url!.host == "storage.example" && request.httpMethod == "PUT" {
            Self.uploadData[request.url!.lastPathComponent] = readData(); result = [:]
        } else if path.contains("/attachments/uploads/") && request.httpMethod == "DELETE" { result = ["ok": true] }
        else if path.contains("/messages/") && path.contains("/attachments/") {
            let parts = path.components(separatedBy: "/")
            let key = parts[parts.count - 3] + "|" + parts.last!
            if let data = Self.downloads[key] { binary = data } else { status = 404; result = ["error": "Missing attachment"] }
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
                if let root = body["thread_root_id"] as? String { result["thread_root_id"] = root; result["thread"] = summary }
                if let quoted = body["reply_to"] as? String {
                    result["thread_reply_to_id"] = quoted
                    result["reply_to"] = (defaults + threadReplies + Self.sent).first { $0["id"] as? String == quoted } ?? rootWithReplies
                }
                if let references = body["attachments"] as? [[String: String]] {
                    result["attachments"] = references.enumerated().map { index, reference -> [String: Any] in
                        let uploadID = reference["upload_id"]!, metadata = Self.uploadMetadata[uploadID] ?? [:]
                        let id = "att_\(index + 1)"
                        Self.downloads["msg_\(Self.sequence)|" + id] = Self.uploadData[uploadID]
                        return ["id": id, "filename": metadata["file_name"] ?? "file", "content_type": metadata["mime_type"] ?? "application/octet-stream", "byte_size": metadata["size_bytes"] ?? 1, "download_url": "/rooms/fixture/messages/msg_\(Self.sequence)/attachments/" + id]
                    }
                }
                Self.sent.append(result)
                status = 201
            }
        } else if path.hasSuffix("/presence") {
            result = ["presence": [
                ["actor_label": "Codex | EmmyMay", "agent_session_id": "codex-live", "session_kind": "worker", "display_name": "Codex", "owner_label": "EmmyMay", "freshness": "active", "source_flags": ["delivery"], "status": "working", "status_text": "Working on the mobile companion"],
                ["actor_label": "History only", "session_kind": "worker", "display_name": "Past agent", "freshness": "active", "source_flags": ["messages"]]]]
        } else if path.hasSuffix("/activity-history") {
            let historyPage = query.first { $0.name == "page" }?.value == "2" ? 2 : 1
            result = ["entries": [["id": historyPage == 1 ? "past-agent" : "past-human", "participant": ["participant_key": "past", "kind": historyPage == 1 ? "agent" : "human", "display_name": historyPage == 1 ? "Past agent" : "Noor", "owner_label": "EmmyMay", "activity_state": "offline"], "first_seen_at": "2026-09-01T09:41:00Z", "last_seen_at": "2026-09-12T09:41:00Z", "last_room_activity_at": "2026-09-12T09:41:00Z", "message_count": 12]], "page": historyPage, "page_count": 2, "total": 2]
        } else if path.hasSuffix("/participants") {
            result = ["participants": [
                ["participant_key": "human-emmy", "kind": "human", "display_name": "EmmyMay", "github_login": "EmmyMay", "activity_state": "active"],
                ["participant_key": "agent-emmy", "kind": "agent", "display_name": "Codex", "agent_key": "codex-emmy", "owner_label": "EmmyMay", "activity_state": "active"],
                ["participant_key": "agent-noor", "kind": "agent", "display_name": "Codex", "agent_key": "codex-noor", "owner_label": "Noor", "activity_state": "active"],
                ["participant_key": "agent-claude", "kind": "agent", "display_name": "Claude", "agent_key": "claude-emmy", "owner_label": "EmmyMay", "activity_state": "active"]]]
        } else if path.hasSuffix("/messages/threads") {
            result = ["threads": [["root": rootWithReplies, "summary": summary]], "has_more": false, "unread_thread_count": 1]
        } else if path.hasSuffix("/thread/read") {
            var read = summary; read["has_unread"] = false; read["unread_count"] = 0; read["last_read_message_id"] = readBody()["message_id"] ?? "msg_5"
            result = ["thread": read]
        } else if path.hasSuffix("/thread") {
            result = ["root": rootWithReplies, "replies": threadReplies + Self.sent.filter { ($0["thread_root_id"] as? String) == "msg_1" }, "has_older": false, "summary": summary]
        } else if path.hasSuffix("/messages/poll") {
            let after = query.first { $0.name == "after" }?.value ?? "msg_0"
            let number = Int(after.replacingOccurrences(of: "msg_", with: "")) ?? 0
            let messages = Self.sent.filter { (Int(($0["id"] as! String).replacingOccurrences(of: "msg_", with: "")) ?? 0) > number }
            result = ["messages": messages, "has_more": false, "last_observed_message_id": messages.last?["id"] ?? after]
        } else if path.hasSuffix("/messages") { result = ["messages": defaults + Self.sent, "has_more": false, "has_older": false] }
        else if path.hasSuffix("/messages/msg_1") {
            Self.quoteAttempts += 1
            if ProcessInfo.processInfo.arguments.contains("--fail-first-quote") && Self.quoteAttempts == 1 { status = 503; result = ["error": "Fixture unavailable"] }
            else { result = ["message": rootWithReplies] }
        }
        else { status = 404; result = ["error": "No fixture route"] }
        let data = binary ?? (try! JSONSerialization.data(withJSONObject: result))
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
    private static func message(_ id: Int, sender: String, text: String, root: String? = nil) -> [String: Any] {
        ["id": "msg_\(id)", "sender": sender, "text": text, "timestamp": "2026-09-13T09:41:00Z", "source": "browser", "thread_root_id": root ?? "msg_\(id)"]
    }
    private func readData() -> Data {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
        }
        return data
    }
    private func readBody() -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: readData())) as? [String: Any] ?? [:]
    }
}
#endif
