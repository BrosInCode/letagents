import Foundation
import Observation

@MainActor @Observable final class ConversationStore {
    let room: Room
    let rootID: String?
    private let session: SessionStore
    private(set) var messages: [Message] = []
    private(set) var isLoading = true
    private(set) var isLoadingOlder = false
    private(set) var isSending = false
    private(set) var hasOlder = false
    private(set) var isConnected = false
    private(set) var error: String?
    private(set) var sendError: String?
    var draft = "" { didSet { session.drafts[draftKey] = draft } }
    private var draftKey: String { room.id + "|" + (rootID ?? "room") }
    private var cursor: String?
    private var loaded = false
    // Retain the id after an ambiguous network failure so retry cannot duplicate a message.
    private var submission: (text: String, id: String)? {
        get { session.submissions[draftKey] }
        set { session.submissions[draftKey] = newValue }
    }

    init(room: Room, rootID: String? = nil, session: SessionStore) {
        self.room = room
        self.rootID = rootID
        self.session = session
        draft = session.drafts[room.id + "|" + (rootID ?? "room")] ?? ""
    }
    var visibleMessages: [Message] {
        rootID == nil ? messages.filter { !$0.isThreadReply } : messages
    }
    func run() async {
        guard let token = session.token else { return }
        defer { isConnected = false }
        var retrySeconds = 1
        while !Task.isCancelled {
            do {
                if !loaded {
                    let latest = try await session.client.messages(roomID: room.id, token: token)
                    try Task.checkCancellation()
                    cursor = latest.messages.max(by: { $0.sequence < $1.sequence })?.id
                    if let rootID {
                        let page = try await session.client.thread(roomID: room.id, rootID: rootID, token: token)
                        try Task.checkCancellation()
                        messages = sortedUnique([page.root] + page.replies)
                        hasOlder = page.hasOlder
                    } else {
                        messages = sortedUnique(latest.messages)
                        hasOlder = latest.hasOlder ?? latest.hasMore ?? false
                    }
                    loaded = true
                    isLoading = false
                }
                isConnected = true
                error = nil
                let page = try await session.client.poll(roomID: room.id, token: token, after: cursor)
                try Task.checkCancellation()
                ingest(page)
                retrySeconds = 1
                // A server may return an empty page immediately; avoid a hot loop.
                if page.messages.isEmpty { try await Task.sleep(for: .milliseconds(300)) }
            } catch is CancellationError { return }
            catch let error as URLError where error.code == .cancelled { return }
            catch {
                isLoading = false
                isConnected = false
                self.error = error.localizedDescription
                session.handleUnauthorized(error, token: token)
                if let apiError = error as? APIError, [401, 403, 404].contains(apiError.status) { return }
                do { try await Task.sleep(for: .seconds(retrySeconds)) } catch { return }
                retrySeconds = min(retrySeconds * 2, 30)
            }
        }
    }
    func ingest(_ page: MessagesResponse) {
        let relevant = page.messages.filter { rootID == nil || $0.rootID == rootID }
        messages = sortedUnique(messages + relevant)
        if rootID == nil {
            for reply in relevant where reply.isThreadReply {
                if let index = messages.firstIndex(where: { $0.id == reply.rootID }), let summary = reply.thread {
                    messages[index].thread = summary
                }
            }
        }
        let observed = page.lastObservedMessageId ?? page.messages.max(by: { $0.sequence < $1.sequence })?.id
        if let observed, number(observed) > number(cursor) { cursor = observed }
    }
    func loadOlder() async {
        guard hasOlder, !isLoadingOlder, let token = session.token else { return }
        isLoadingOlder = true
        defer { isLoadingOlder = false }
        do {
            if let rootID {
                guard let before = messages.first(where: { $0.id != rootID })?.id else { return }
                let page = try await session.client.thread(roomID: room.id, rootID: rootID, token: token, before: before)
                messages = sortedUnique([page.root] + page.replies + messages)
                hasOlder = page.hasOlder
            } else {
                guard let before = messages.first?.id else { return }
                let page = try await session.client.messages(roomID: room.id, token: token, before: before)
                messages = sortedUnique(page.messages + messages)
                hasOlder = page.hasOlder ?? page.hasMore ?? false
            }
        } catch { self.error = error.localizedDescription; session.handleUnauthorized(error, token: token) }
    }
    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending, let token = session.token, let account = session.account else { return }
        isSending = true
        sendError = nil
        if submission?.text != text { submission = (text, "desktop-send:" + UUID().uuidString) }
        let id = submission!.id
        defer { isSending = false }
        do {
            let sent = try await session.client.send(roomID: room.id, token: token,
                message: SendMessageBody(sender: account.login, text: text, threadRootId: rootID, clientMessageId: id))
            messages = sortedUnique(messages + [sent])
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
            submission = nil
        } catch {
            sendError = "Message wasn’t confirmed. Your draft is saved here. Tap Send to retry."
            session.handleUnauthorized(error, token: token)
        }
    }
    private func sortedUnique(_ input: [Message]) -> [Message] {
        var byID: [String: Message] = [:]
        for message in input { byID[message.id] = message }
        return byID.values.sorted { $0.sequence < $1.sequence }
    }
    private func number(_ id: String?) -> Int { Int(id?.replacingOccurrences(of: "msg_", with: "") ?? "") ?? 0 }
}
