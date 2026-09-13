import Foundation

struct Account: Codable, Equatable, Sendable {
    let id: String
    let login: String
    let displayName: String?
    let avatarUrl: String?
    var name: String { displayName?.isEmpty == false ? displayName! : login }
}

struct Room: Codable, Identifiable, Hashable, Sendable {
    let roomId: String
    let displayName: String
    var kind: String? = nil
    var pinned: Bool? = nil
    var latestMessageAt: String? = nil
    var focusRooms: [Room]? = nil
    var gitRoom: GitRoom? = nil
    var id: String { roomId }
    var subtitle: String {
        if let repo = gitRoom?.repository {
            return "\(repo.owner) · \(gitRoom?.ref?.name ?? repo.name)"
        }
        return kind == "focus" ? "Focus room" : roomId
    }
    struct GitRoom: Codable, Hashable, Sendable {
        let repository: Repository?
        let ref: Ref?
        struct Repository: Codable, Hashable, Sendable { let owner: String; let name: String }
        struct Ref: Codable, Hashable, Sendable { let name: String? }
    }
}

struct Message: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let sender: String
    let text: String
    var displayText: String? = nil
    var source: String? = nil
    let timestamp: String
    var threadRootId: String? = nil
    var thread: ThreadSummary? = nil
    var clientMessageId: String? = nil
    var attachments: [Attachment]? = nil
    var body: String { displayText ?? text }
    var author: String { sender.components(separatedBy: " | ").first ?? sender }
    var isThreadReply: Bool { threadRootId != nil && threadRootId != id }
    var rootID: String { threadRootId ?? id }
    var sequence: Int { Int(id.replacingOccurrences(of: "msg_", with: "")) ?? 0 }
    var date: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: timestamp) ?? ISO8601DateFormatter().date(from: timestamp)
    }
    struct Attachment: Codable, Hashable, Identifiable, Sendable {
        let id: String
        let filename: String
        let downloadUrl: String
    }
}

struct ThreadSummary: Codable, Hashable, Sendable {
    let rootMessageId: String
    let replyCount: Int
}
struct RoomsResponse: Decodable, Sendable { let rooms: [Room] }
struct MessagesResponse: Decodable, Sendable {
    let messages: [Message]
    var hasMore: Bool? = nil
    var hasOlder: Bool? = nil
    var lastObservedMessageId: String? = nil
}
struct ThreadResponse: Decodable, Sendable {
    let root: Message
    let replies: [Message]
    let hasOlder: Bool
}
struct SessionResponse: Decodable, Sendable { let authenticated: Bool; let account: Account? }
struct DeviceAuthorization: Decodable, Sendable {
    let requestId: String
    let userCode: String
    let verificationUri: String
    let expiresIn: Int
    let interval: Int
    var verificationURL: URL? {
        guard let url = URL(string: verificationUri), url.scheme == "https", url.host == "github.com" else { return nil }
        return url
    }
}
struct DevicePoll: Decodable, Sendable {
    let status: String
    var interval: Int? = nil
    var letagentsToken: String? = nil
    var account: Account? = nil
}
struct SendMessageBody: Encodable, Sendable {
    let sender: String
    let text: String
    let threadRootId: String?
    let clientMessageId: String
}
