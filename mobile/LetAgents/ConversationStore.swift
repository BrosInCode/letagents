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
    private(set) var lastSentMessageID: String?
    private(set) var hasOlder = false
    private(set) var isConnected = false
    private(set) var error: String?
    private(set) var sendError: String?
    private(set) var participants: [Participant] = []
    private(set) var participantsError: String?
    var quote: ReplyPreview? { didSet { session.quotes[draftKey] = quote } }
    var draft = "" { didSet { session.drafts[draftKey] = draft } }
    private var draftKey: String { room.id + "|" + (rootID ?? "room") }
    private var cursor: String?
    private var historyBefore: String?
    private var loaded = false
    private var unavailableRoots: Set<String> = []
    // Retain the id after an ambiguous network failure so retry cannot duplicate a message.
    private var submission: (text: String, id: String, replyTo: String?)? {
        get { session.submissions[draftKey] }
        set { session.submissions[draftKey] = newValue }
    }

    init(room: Room, rootID: String? = nil, session: SessionStore) {
        self.room = room
        self.rootID = rootID
        self.session = session
        draft = session.drafts[room.id + "|" + (rootID ?? "room")] ?? ""
        quote = session.quotes[room.id + "|" + (rootID ?? "room")]
    }
    var visibleMessages: [Message] {
        (rootID == nil ? messages.filter { !$0.isThreadReply } : messages).map { message in
            var message = message
            if let read = session.threadReads[room.id + "|" + message.id],
               number(read.lastReadMessageId) >= number(message.thread?.latestReply?.id) {
                message.thread?.hasUnread = false; message.thread?.unreadCount = 0
            }
            return message
        }
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
                        if let summary = page.summary, let index = messages.firstIndex(where: { $0.id == rootID }) { messages[index].thread = summary }
                        hasOlder = page.hasOlder
                    } else {
                        messages = sortedUnique(latest.messages)
                        historyBefore = messages.first?.id
                        hasOlder = latest.hasOlder ?? latest.hasMore ?? false
                    }
                    loaded = true
                    isLoading = false
                }
                try await hydrateMissingRoots(token: token)
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
                guard let before = historyBefore else { return }
                let page = try await session.client.messages(roomID: room.id, token: token, before: before)
                historyBefore = page.messages.min(by: { $0.sequence < $1.sequence })?.id
                messages = sortedUnique(page.messages + messages)
                hasOlder = page.hasOlder ?? page.hasMore ?? false
                try await hydrateMissingRoots(token: token)
            }
        } catch { self.error = error.localizedDescription; session.handleUnauthorized(error, token: token) }
    }
    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending, let token = session.token, let account = session.account else { return }
        isSending = true
        sendError = nil
        if submission?.text != text || submission?.replyTo != quote?.id { submission = (text, "desktop-send:" + UUID().uuidString, quote?.id) }
        let id = submission!.id
        let quoteID = quote?.id
        defer { isSending = false }
        do {
            let sent = try await session.client.send(roomID: room.id, token: token,
                message: SendMessageBody(sender: account.login, text: text, threadRootId: rootID, clientMessageId: id, replyTo: quoteID))
            lastSentMessageID = sent.id
            messages = sortedUnique(messages + [sent])
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text && quote?.id == quoteID { draft = ""; quote = nil }
            submission = nil
        } catch {
            sendError = "Message wasn’t confirmed. Your draft is saved here. Tap Send to retry."
            session.handleUnauthorized(error, token: token)
        }
    }
    private func hydrateMissingRoots(token: String) async throws {
        guard rootID == nil else { return }
        let known = Set(messages.map(\.id)).union(unavailableRoots)
        let missing = Array(Set(messages.filter(\.isThreadReply).map(\.rootID)).subtracting(known))
        let client = session.client, roomID = room.id
        // A busy room's latest page can contain only replies. Recover their originals so
        // the timeline still shows the conversations instead of an empty-room prompt.
        for start in stride(from: 0, to: missing.count, by: 4) {
            let batch = Array(missing.dropFirst(start).prefix(4))
            let fetched = try await withThrowingTaskGroup(of: (String, Message?).self) { group in
                for id in batch {
                    group.addTask {
                        do { return (id, try await client.message(roomID: roomID, messageID: id, token: token)) }
                        catch let error as APIError where error.status == 404 { return (id, nil) }
                    }
                }
                var results: [(String, Message?)] = []
                for try await result in group { results.append(result) }
                return results
            }
            try Task.checkCancellation()
            messages = sortedUnique(messages + fetched.compactMap(\.1))
            unavailableRoots.formUnion(fetched.filter { $0.1 == nil }.map(\.0))
        }
    }
    func watchParticipants() async {
        while !Task.isCancelled {
            await refreshParticipants()
            do { try await Task.sleep(for: .seconds(30)) } catch { return }
        }
    }
    func refreshParticipants() async {
        guard let token = session.token else { return }
        do {
            let result = try await session.client.participants(roomID: room.id, token: token)
            try Task.checkCancellation(); participants = result; participantsError = nil
        } catch is CancellationError { }
        catch { participantsError = "Couldn’t refresh the room roster."; session.handleUnauthorized(error, token: token) }
    }
    func markRead(through message: Message) async {
        guard let rootID, message.isThreadReply, let token = session.token else { return }
        let key = room.id + "|" + rootID
        guard number(session.threadReads[key]?.lastReadMessageId) < message.sequence else { return }
        do {
            let read = try await session.client.markThreadRead(roomID: room.id, rootID: rootID, messageID: message.id, token: token)
            if number(read.lastReadMessageId) > number(session.threadReads[key]?.lastReadMessageId) { session.threadReads[key] = read }
        } catch { session.handleUnauthorized(error, token: token) }
    }
    private func sortedUnique(_ input: [Message]) -> [Message] {
        var byID: [String: Message] = [:]
        for message in input { byID[message.id] = message }
        return byID.values.sorted { $0.sequence < $1.sequence }
    }
    private func number(_ id: String?) -> Int { Int(id?.replacingOccurrences(of: "msg_", with: "") ?? "") ?? 0 }
}
