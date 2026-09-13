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
    var parentRoomId: String? = nil
    var focusStatus: String? = nil
    var sourceTaskId: String? = nil
    var role: String? = nil
    var latestMessageId: String? = nil
    var archived: Bool? = nil
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
        var host: String? = nil
        var visibility: String? = nil
        struct Repository: Codable, Hashable, Sendable { let owner: String; let name: String }
        struct Ref: Codable, Hashable, Sendable {
            let name: String?
            var type: String? = nil
            var defaultBranch: String? = nil
            var isDefault: Bool? = nil
        }
    }
    var isDefaultBranch: Bool {
        guard let ref = gitRoom?.ref else { return false }
        return ref.isDefault == true || (ref.defaultBranch != nil && ref.name == ref.defaultBranch)
    }
    var branchName: String { gitRoom?.ref?.name ?? (isDefaultBranch ? "Default branch" : displayName) }
    var membership: String { role == "admin" ? "Admin" : "Member" }
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
    var agentIdentity: AgentIdentity? = nil
    var replyTo: ReplyPreview? = nil
    var threadReplyToId: String? = nil
    var body: String { displayText ?? text }
    var author: String { agentIdentity?.displayName ?? agentIdentity?.name ?? sender.components(separatedBy: " | ").first ?? sender }
    var isAgent: Bool { source == "agent" || agentIdentity != nil || sender.contains(" | ") }
    var attribution: String? {
        if let owner = agentIdentity?.ownerAttribution { return owner }
        if let owner = agentIdentity?.ownerLabel { return owner.hasSuffix("agent") ? owner : "\(owner)’s agent" }
        let parts = sender.components(separatedBy: " | ")
        return parts.count > 1 ? parts[1] : (isAgent ? "Agent" : nil)
    }
    var isThreadReply: Bool { rootID != id }
    var rootID: String { threadRootId ?? thread?.rootMessageId ?? id }
    var sequence: Int { Int(id.replacingOccurrences(of: "msg_", with: "")) ?? 0 }
    var date: Date? { MessageDate.parse(timestamp) }
    struct Attachment: Codable, Hashable, Identifiable, Sendable {
        let id: String
        let filename: String
        let downloadUrl: String
    }
}

struct ThreadSummary: Codable, Hashable, Sendable {
    let rootMessageId: String
    let replyCount: Int
    var unreadCount: Int? = nil
    var hasUnread: Bool? = nil
    var latestReply: ReplyPreview? = nil
    var participants: [ThreadParticipant]? = nil
    var participantCount: Int? = nil
    var lastReadMessageId: String? = nil
    var unread: Bool { hasUnread == true || (unreadCount ?? 0) > 0 }
}
struct AgentIdentity: Codable, Hashable, Sendable {
    var name: String? = nil
    var displayName: String? = nil
    var ownerLabel: String? = nil
    var ownerAttribution: String? = nil
    var agentKey: String? = nil
}
struct ReplyPreview: Codable, Hashable, Sendable {
    let id: String
    let sender: String
    let text: String
    var displayText: String? = nil
    var timestamp: String? = nil
    var agentIdentity: AgentIdentity? = nil
    var author: String { agentIdentity?.displayName ?? sender.components(separatedBy: " | ")[0] }
    var body: String { displayText ?? text }
    init(message: Message) {
        id = message.id; sender = message.sender; text = message.text
        displayText = message.displayText; timestamp = message.timestamp; agentIdentity = message.agentIdentity
    }
}
struct ThreadParticipant: Codable, Hashable, Sendable { let sender: String; var messageCount: Int? = nil }
struct Participant: Codable, Identifiable, Hashable, Sendable {
    let participantKey: String
    let kind: String
    let displayName: String
    var githubLogin: String? = nil
    var agentKey: String? = nil
    var ownerLabel: String? = nil
    var actorLabel: String? = nil
    var activityState: String? = nil
    var hiddenAt: String? = nil
    var sourceFlags: [String]? = nil
    var id: String { participantKey }
    var detail: String { kind == "agent" ? (ownerLabel.map { $0.hasSuffix("agent") ? $0 : "\($0)’s agent" } ?? "Agent") : "@\(githubLogin ?? displayName)" }
}
struct ParticipantsResponse: Decodable, Sendable { let participants: [Participant] }
struct ThreadInboxItem: Decodable, Identifiable, Sendable { var root: Message; var summary: ThreadSummary? = nil; var id: String { root.id } }
struct ThreadsResponse: Decodable, Sendable { let threads: [ThreadInboxItem]; let hasMore: Bool; var unreadThreadCount: Int? = nil }
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
    var summary: ThreadSummary? = nil
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
    var replyTo: String? = nil
}


enum MessageDate {
    static func parse(_ timestamp: String) -> Date? {
        // History is stored as PostgreSQL timestamptz strings; live messages use ISO 8601.
        var normalized = timestamp.replacingOccurrences(of: " ", with: "T")
        if normalized.range(of: #"[+-]\d{2}$"#, options: .regularExpression) != nil { normalized += ":00" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: normalized) ?? ISO8601DateFormatter().date(from: normalized)
    }
}
