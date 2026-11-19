import Foundation
import Observation
import CryptoKit

struct ConversationRoute: Codable, Hashable, Sendable {
    let roomID: String
    var rootID: String? = nil
    var draftKey: String { roomID + "|" + (rootID ?? "room") }
}

// Account-owned state outlives individual screens. Network state stays in feature stores.
@MainActor @Observable final class WorkspaceStore {
    var drafts: [String: String] = [:] { didSet { scheduleSave() } }
    var quotes: [String: ReplyPreview] = [:] { didSet { scheduleSave() } }
    var attachments: [String: [DraftAttachment]] = [:] { didSet { scheduleSave() } }
    var submissions: [String: MessageSubmission] = [:] { didSet { scheduleSave() } }
    var lastConversation: ConversationRoute? { didSet { scheduleSave() } }
    private(set) var saveError: String?
    private(set) var needsRecovery = false
    @ObservationIgnored private let disk: WorkspaceDisk?
    @ObservationIgnored private var accountID: String?
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var canPersist = false

    init(disk: WorkspaceDisk? = nil) { self.disk = disk }

    func load(accountID: String) async {
        saveTask?.cancel()
        canPersist = false
        self.accountID = accountID
        drafts = [:]; quotes = [:]; attachments = [:]; submissions = [:]; lastConversation = nil
        do {
            let saved = try await disk?.load(accountID: accountID) ?? WorkspaceSnapshot()
            drafts = saved.drafts; quotes = saved.quotes; attachments = saved.attachments
            submissions = saved.submissions; lastConversation = saved.lastConversation
            saveError = nil; canPersist = true; needsRecovery = false
        } catch {
            needsRecovery = true
            saveError = "Your saved drafts couldn’t be opened. Try loading them again, or reset this iPhone’s saved drafts."
        }
    }

    func retrySaving() async {
        guard needsRecovery, let disk, let accountID else { await flush(); return }
        do {
            let saved = try await disk.load(accountID: accountID)
            guard self.accountID == accountID else { return }
            // Keep edits made while recovery was unavailable. Preserve saved retry
            // identities; send() only reuses them when the submission still matches.
            drafts = saved.drafts.merging(drafts) { _, current in current }
            quotes = saved.quotes.merging(quotes) { _, current in current }
            attachments = saved.attachments.merging(attachments) { _, current in current }
            submissions = submissions.merging(saved.submissions) { _, saved in saved }
            lastConversation = lastConversation ?? saved.lastConversation
            needsRecovery = false; canPersist = true
            await flush()
        } catch {
            saveError = "Your saved drafts still couldn’t be opened. You can reset this iPhone’s saved drafts to continue."
        }
    }

    // Only called after the user confirms loss of the unreadable local drafts.
    func resetSavedDrafts() async {
        guard let accountID else { return }
        do { try await clear(); await load(accountID: accountID) }
        catch { saveError = "The saved drafts couldn’t be reset. Free some storage and try again." }
    }

    // Explicit flushes before a send and on backgrounding close the debounce window.
    @discardableResult func flush() async -> Bool {
        saveTask?.cancel()
        guard let disk, let accountID else { return true }
        guard canPersist else { return false }
        let snapshot = WorkspaceSnapshot(drafts: drafts.filter { !$0.value.isEmpty }, quotes: quotes,
            attachments: attachments.filter { !$0.value.isEmpty }, submissions: submissions, lastConversation: lastConversation)
        revision += 1
        let savingRevision = revision
        do {
            try await disk.save(snapshot, accountID: accountID, revision: savingRevision)
            guard self.accountID == accountID else { return false }
            saveError = nil
            return true
        } catch {
            guard self.accountID == accountID else { return false }
            saveError = "Changes are kept in this session but couldn’t be saved on this iPhone. Free some storage and try again."
            return false
        }
    }

    func clear() async throws {
        saveTask?.cancel(); canPersist = false
        do {
            if let disk, let accountID { try await disk.remove(accountID: accountID) }
        } catch { canPersist = !needsRecovery; throw error }
        accountID = nil
        drafts = [:]; quotes = [:]; attachments = [:]; submissions = [:]; lastConversation = nil
        saveError = nil; needsRecovery = false
    }

    private func scheduleSave() {
        guard canPersist, disk != nil else { return }
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            await self?.flush()
        }
    }
}

struct WorkspaceSnapshot: Sendable {
    var drafts: [String: String] = [:]
    var quotes: [String: ReplyPreview] = [:]
    var attachments: [String: [DraftAttachment]] = [:]
    var submissions: [String: MessageSubmission] = [:]
    var lastConversation: ConversationRoute?
}

// Serial disk access keeps large attachment bytes off the main actor. Metadata is
// atomic; attachment bytes are written once, protected, and excluded from backups.
actor WorkspaceDisk {
    private let directory: URL
    private var revisions: [String: Int] = [:]
    init(directory: URL = URL.applicationSupportDirectory.appendingPathComponent("MobileWorkspace", isDirectory: true)) {
        self.directory = directory
    }
    private struct StoredAttachment: Codable {
        let id: UUID
        let filename: String
        let contentType: String
    }
    private struct Metadata: Codable {
        var drafts: [String: String]
        var quotes: [String: ReplyPreview]
        var attachments: [String: [StoredAttachment]]
        var submissions: [String: MessageSubmission]
        var lastConversation: ConversationRoute?
    }
    private func folder(_ accountID: String) -> URL {
        let key = SHA256.hash(data: Data(accountID.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(key, isDirectory: true)
    }
    func load(accountID: String) throws -> WorkspaceSnapshot {
        let directory = folder(accountID), file = directory.appendingPathComponent("workspace.json")
        revisions[accountID] = nil
        guard FileManager.default.fileExists(atPath: file.path) else { return WorkspaceSnapshot() }
        let metadata = try JSONDecoder().decode(Metadata.self, from: Data(contentsOf: file))
        let attachments = try metadata.attachments.mapValues { entries in
            try entries.map { entry in
                try DraftAttachment(id: entry.id, filename: entry.filename, contentType: entry.contentType,
                    data: Data(contentsOf: directory.appendingPathComponent(entry.id.uuidString)))
            }
        }
        return WorkspaceSnapshot(drafts: metadata.drafts, quotes: metadata.quotes, attachments: attachments,
            submissions: metadata.submissions, lastConversation: metadata.lastConversation)
    }
    func save(_ snapshot: WorkspaceSnapshot, accountID: String, revision: Int) throws {
        guard revision > (revisions[accountID] ?? -1) else { return }
        var directory = folder(accountID)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        let files = snapshot.attachments.values.flatMap { $0 }
        for attachment in files {
            let file = directory.appendingPathComponent(attachment.id.uuidString)
            if !FileManager.default.fileExists(atPath: file.path) {
                try attachment.data.write(to: file, options: [.atomic, .completeFileProtection])
            }
        }
        let metadata = Metadata(drafts: snapshot.drafts, quotes: snapshot.quotes,
            attachments: snapshot.attachments.mapValues { $0.map { StoredAttachment(id: $0.id, filename: $0.filename, contentType: $0.contentType) } },
            submissions: snapshot.submissions, lastConversation: snapshot.lastConversation)
        try JSONEncoder().encode(metadata).write(to: directory.appendingPathComponent("workspace.json"), options: [.atomic, .completeFileProtection])
        revisions[accountID] = revision
        let retained = Set(files.map { $0.id.uuidString }).union(["workspace.json"])
        for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) where !retained.contains(file.lastPathComponent) {
            try? FileManager.default.removeItem(at: file)
        }
    }
    func remove(accountID: String) throws {
        let directory = folder(accountID)
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
        revisions[accountID] = Int.max // Reject any already queued writes after sign-out.
    }
}
