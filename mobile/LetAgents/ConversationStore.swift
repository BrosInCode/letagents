import Foundation
import Observation

@MainActor @Observable final class ConversationStore {
    let room: Room
    let rootID: String?
    private let session: SessionStore
    private let sessionID: UUID
    private var isCurrentSession: Bool { session.sessionID == sessionID }
    private(set) var messages: [Message] = []
    private(set) var isLoading = true
    private(set) var isLoadingOlder = false
    var isSending: Bool { isCurrentSession && session.sendingDrafts.contains(draftKey) }
    private(set) var lastSentMessageID: String?
    private(set) var hasOlder = false
    private(set) var isConnected = false
    private(set) var error: String?
    private(set) var sendError: String?
    private(set) var participants: [Participant] = []
    private(set) var participantsError: String?
    var quote: ReplyPreview? {
        get { isCurrentSession ? session.quotes[draftKey] : nil }
        set { if isCurrentSession { session.quotes[draftKey] = newValue } }
    }
    var draft: String {
        get { isCurrentSession ? session.drafts[draftKey] ?? "" : "" }
        set { if isCurrentSession { session.drafts[draftKey] = newValue } }
    }
    private(set) var attachments: [DraftAttachment] {
        get { isCurrentSession ? session.attachmentDrafts[draftKey] ?? [] : [] }
        set { if isCurrentSession { session.attachmentDrafts[draftKey] = newValue } }
    }
    var attachmentError: String?
    private(set) var uploadProgress: String?
    var canSend: Bool { isCurrentSession && !isSending && (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty) }
    private var draftKey: String { room.id + "|" + (rootID ?? "room") }
    private var cursor: String?
    private var historyBefore: String?
    private var loaded = false
    private var unavailableRoots: Set<String> = []
    // Retain the id after an ambiguous network failure so retry cannot duplicate a message.
    private var submission: MessageSubmission? {
        get { isCurrentSession ? session.submissions[draftKey] : nil }
        set { if isCurrentSession { session.submissions[draftKey] = newValue } }
    }

    init(room: Room, rootID: String? = nil, session: SessionStore) {
        self.room = room
        self.rootID = rootID
        self.session = session
        self.sessionID = session.sessionID
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
        guard isCurrentSession, let token = session.token else { return }
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
        guard isCurrentSession, hasOlder, !isLoadingOlder, let token = session.token else { return }
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
    func addAttachments(_ files: [DraftAttachment]) {
        guard isCurrentSession, !isSending else { return }
        let available = max(0, DraftAttachment.maximumCount - attachments.count)
        attachments.append(contentsOf: files.prefix(available))
        attachmentError = files.count > available ? "You can attach up to four files per message." : nil
    }
    func removeAttachment(_ id: UUID) {
        guard isCurrentSession, !isSending else { return }
        attachments.removeAll { $0.id == id }; attachmentError = nil
        if let token = session.token, let uploads = submission?.uploads.values.map({ $0 }), !uploads.isEmpty {
            let client = session.client, roomID = room.id
            Task { for uploadID in uploads { try? await client.discardAttachment(roomID: roomID, uploadID: uploadID, token: token) } }
        }
        submission = nil
    }
    func downloadAttachment(_ destination: AttachmentDestination) async throws -> URL {
        guard isCurrentSession, let token = session.token else { throw CancellationError() }
        do {
            let file = try await session.client.downloadAttachment(roomID: room.id, messageID: destination.messageID, attachment: destination.attachment, token: token)
            guard isCurrentSession, !Task.isCancelled else {
                try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
                throw CancellationError()
            }
            return file
        } catch { session.handleUnauthorized(error, token: token); throw error }
    }
    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, let token = session.token, let account = session.account else { return }
        session.sendingDrafts.insert(draftKey); sendError = nil; attachmentError = nil
        let selectedFiles = attachments
        let attachmentIDs = selectedFiles.map(\.id)
        if submission?.text != text || submission?.replyTo != quote?.id || submission?.attachmentIDs != attachmentIDs {
            let previousUploads = submission?.uploads.values.map { $0 } ?? []
            submission = MessageSubmission(text: text, id: "desktop-send:" + UUID().uuidString, replyTo: quote?.id, attachmentIDs: attachmentIDs)
            if !previousUploads.isEmpty {
                let client = session.client, roomID = room.id
                Task { for uploadID in previousUploads { try? await client.discardAttachment(roomID: roomID, uploadID: uploadID, token: token) } }
            }
        }
        let id = submission!.id, quoteID = quote?.id
        var requestedSend = false
        defer { if isCurrentSession { session.sendingDrafts.remove(draftKey) }; uploadProgress = nil }
        do {
            for (index, attachment) in selectedFiles.enumerated() where submission?.uploads[attachment.id] == nil {
                uploadProgress = "Uploading \(index + 1) of \(selectedFiles.count)…"
                let uploadID = try await session.client.uploadAttachment(roomID: room.id, token: token, attachment: attachment)
                guard isCurrentSession else { try? await session.client.discardAttachment(roomID: room.id, uploadID: uploadID, token: token); return }
                submission?.uploads[attachment.id] = uploadID
            }
            guard isCurrentSession else { return }
            let references = selectedFiles.compactMap { submission?.uploads[$0.id] }.map { SendMessageBody.AttachmentReference(uploadId: $0) }
            uploadProgress = nil; requestedSend = true
            let sent = try await session.client.send(roomID: room.id, token: token,
                message: SendMessageBody(sender: account.login, text: text, threadRootId: rootID, clientMessageId: id, replyTo: quoteID, attachments: references.isEmpty ? nil : references))
            guard isCurrentSession else { return }
            lastSentMessageID = sent.id
            messages = sortedUnique(messages + [sent])
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text && quote?.id == quoteID { draft = ""; quote = nil }
            attachments.removeAll { attachmentIDs.contains($0.id) }
            submission = nil
        } catch {
            guard isCurrentSession else { return }
            if let failure = error as? APIError, failure.status == 400, failure.serverMessage == "attachment upload not found or expired" {
                // The server rejected the transaction, so it is safe to upload again.
                submission?.uploads = [:]
                sendError = "The attachments expired. Tap Send to upload them again."
            } else if requestedSend {
                sendError = "Message wasn’t confirmed. Your draft is saved here. Tap Send to retry."
            } else { sendError = "Couldn’t upload the attachments. Your files are saved here. Tap Send to retry." }
            session.handleUnauthorized(error, token: token)
        }
    }
    func quotedMessage(id: String) async throws -> Message {
        if let message = messages.first(where: { $0.id == id }) { return message }
        guard let token = session.token else { throw APIError(status: 401, message: "Sign in to read the original message.") }
        do { return try await session.client.message(roomID: room.id, messageID: id, token: token) }
        catch { session.handleUnauthorized(error, token: token); throw error }
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
        guard isCurrentSession, let token = session.token else { return }
        do {
            let result = try await session.client.participants(roomID: room.id, token: token)
            try Task.checkCancellation(); participants = result; participantsError = nil
        } catch is CancellationError { }
        catch { participantsError = "Couldn’t refresh the room roster."; session.handleUnauthorized(error, token: token) }
    }
    func markRead(through message: Message) async {
        guard isCurrentSession, let rootID, message.isThreadReply, let token = session.token else { return }
        let key = room.id + "|" + rootID
        guard number(session.threadReads[key]?.lastReadMessageId) < message.sequence else { return }
        do {
            let read = try await session.client.markThreadRead(roomID: room.id, rootID: rootID, messageID: message.id, token: token)
            if isCurrentSession && number(read.lastReadMessageId) > number(session.threadReads[key]?.lastReadMessageId) { session.threadReads[key] = read }
        } catch { session.handleUnauthorized(error, token: token) }
    }
    private func sortedUnique(_ input: [Message]) -> [Message] {
        var byID: [String: Message] = [:]
        for message in input { byID[message.id] = message }
        return byID.values.sorted { $0.sequence < $1.sequence }
    }
    private func number(_ id: String?) -> Int { Int(id?.replacingOccurrences(of: "msg_", with: "") ?? "") ?? 0 }
}
