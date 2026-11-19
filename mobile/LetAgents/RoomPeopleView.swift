import SwiftUI

struct AgentPresence: Decodable, Identifiable, Sendable {
    let actorLabel: String
    var agentSessionId: String? = nil
    let sessionKind: String
    let displayName: String
    var ownerLabel: String? = nil
    let freshness: String
    let sourceFlags: [String]
    var status: String? = nil
    var statusText: String? = nil
    var id: String { agentSessionId ?? actorLabel }
    var isConnected: Bool { sessionKind == "worker" && freshness == "active" && sourceFlags.contains("delivery") }
    var connectionLabel: String { status == "idle" ? "Idle" : "Connected" }
}
struct PresenceResponse: Decodable, Sendable {
    let presence: [AgentPresence]
    var fallback: String? = nil
    var connected: [AgentPresence] {
        var seen: Set<String> = []
        return presence.filter { $0.isConnected && seen.insert($0.id).inserted }
            .sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
    }
}
struct ActivityHistoryEntry: Decodable, Identifiable, Sendable {
    let id: String
    let participant: Participant
    let firstSeenAt: String
    let lastSeenAt: String
    let lastRoomActivityAt: String
    let messageCount: Int
}
struct ActivityHistoryResponse: Decodable, Sendable {
    let entries: [ActivityHistoryEntry]
    let page: Int
    let pageCount: Int
    let total: Int
}
extension APIClient {
    func presence(roomID: String, token: String) async throws -> PresenceResponse {
        try await request(path: ["rooms", roomID, "presence"], token: token, query: [.init(name: "limit", value: "500")])
    }
    func activityHistory(roomID: String, token: String, page: Int = 1) async throws -> ActivityHistoryResponse {
        try await request(path: ["rooms", roomID, "activity-history"], token: token,
                          query: [.init(name: "page", value: String(page)), .init(name: "page_size", value: "30")])
    }
}
struct RoomPeopleView: View {
    let room: Room
    let session: SessionStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingHistory = false
    @State private var connected: [AgentPresence] = []
    @State private var history: [ActivityHistoryEntry] = []
    @State private var page = 0
    @State private var pageCount = 1
    @State private var loading = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(room.displayName).font(.headline)
                    Picker("Participants view", selection: $showingHistory) {
                        Text("Connected now").tag(false)
                        Text("History").tag(true)
                    }.pickerStyle(.segmented).padding(.vertical, 6)
                    Text(showingHistory ? "People and agents who have participated in this room." : "Agents connected to this room right now. Past activity is in History.")
                        .font(.subheadline).foregroundStyle(Theme.muted)
                }.listRowBackground(Color.clear).listRowSeparator(.hidden)
                if let error {
                    Section { ErrorNotice(message: error); Button("Try again") { Task { await refresh() } } }.listRowBackground(Theme.surface)
                }
                if loading && (showingHistory ? history.isEmpty : connected.isEmpty) {
                    ProgressView(showingHistory ? "Loading history…" : "Checking connections…").frame(maxWidth: .infinity).listRowBackground(Color.clear)
                } else if showingHistory {
                    Section("Room history") {
                        ForEach(history) { entry in
                            HStack(alignment: .top, spacing: 12) {
                                AvatarView(name: entry.participant.displayName)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(entry.participant.displayName).font(.headline)
                                    Text(entry.participant.detail).font(.caption).foregroundStyle(Theme.muted)
                                    Text("\(entry.messageCount) \(entry.messageCount == 1 ? "message" : "messages")").font(.caption).foregroundStyle(Theme.muted)
                                    if let date = MessageDate.parse(entry.lastRoomActivityAt) {
                                        Text("Last active \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption2).foregroundStyle(Theme.secondary)
                                    }
                                }
                            }.padding(.vertical, 6).listRowBackground(Theme.surface).accessibilityElement(children: .combine).accessibilityIdentifier("history-\(entry.id)")
                        }
                        if history.isEmpty && error == nil { Text("No room history yet.").foregroundStyle(Theme.muted).listRowBackground(Theme.surface) }
                        if page < pageCount {
                            Button { Task { await loadHistory(more: true) } } label: { HStack { Text("Load more history"); if loading { ProgressView() } } }
                                .disabled(loading).listRowBackground(Theme.surface)
                        }
                    }
                } else {
                    Section("Connected now · \(connected.count)") {
                        ForEach(connected) { agent in
                            HStack(alignment: .top, spacing: 12) {
                                AvatarView(name: agent.displayName)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(agent.displayName).font(.headline)
                                    if let owner = agent.ownerLabel { Text("\(owner)’s agent").font(.caption).foregroundStyle(Theme.muted) }
                                    HStack(spacing: 6) { Circle().fill(Theme.green).frame(width: 6, height: 6); Text(agent.connectionLabel).font(.caption).foregroundStyle(Theme.green) }
                                    if let status = agent.statusText, !status.isEmpty { Text(status).font(.caption).foregroundStyle(Theme.muted).lineLimit(3) }
                                }
                            }.padding(.vertical, 6).listRowBackground(Theme.surface).accessibilityElement(children: .combine).accessibilityIdentifier("connected-\(agent.id)")
                        }
                        if connected.isEmpty && error == nil {
                            Text("No agents are connected right now.").foregroundStyle(Theme.muted).padding(.vertical, 12).listRowBackground(Theme.surface)
                        }
                    }
                }
            }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.background)
                .navigationTitle("People & agents").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }.companionToolbarStyle() }
                .refreshable { await refresh() }
                .task(id: "\(showingHistory)-\(scenePhase)") {
                    guard scenePhase == .active else { return }
                    error = nil
                    if showingHistory { await loadHistory(more: false) }
                    else {
                        while !Task.isCancelled {
                            await loadPresence()
                            do { try await Task.sleep(for: .seconds(15)) } catch { return }
                        }
                    }
                }
        }.buttonStyle(.plain)
    }
    private func refresh() async {
        if showingHistory { await loadHistory(more: false) } else { await loadPresence() }
    }
    private func loadPresence() async {
        guard let token = session.token else { return }
        loading = true; defer { loading = false }
        do {
            let result = try await session.client.presence(roomID: room.id, token: token)
            try Task.checkCancellation()
            guard result.fallback != "unavailable" else { throw APIError(status: 0, message: "Live connections are temporarily unavailable.") }
            connected = result.connected; error = nil
        } catch is CancellationError { }
        catch let failure as URLError where failure.code == .cancelled { }
        catch { connected = []; self.error = "Couldn’t check who is connected. Pull down to refresh."; session.handleUnauthorized(error, token: token) }
    }
    private func loadHistory(more: Bool) async {
        guard let token = session.token else { return }
        loading = true; defer { loading = false }
        do {
            let result = try await session.client.activityHistory(roomID: room.id, token: token, page: more ? page + 1 : 1)
            try Task.checkCancellation()
            let previous = more ? history : []
            var seen: Set<String> = []
            history = (previous + result.entries).filter { seen.insert($0.id).inserted }
            page = result.page; pageCount = result.pageCount; error = nil
        } catch is CancellationError { }
        catch let failure as URLError where failure.code == .cancelled { }
        catch { self.error = "Couldn’t load room history. Pull down to refresh."; session.handleUnauthorized(error, token: token) }
    }
}
