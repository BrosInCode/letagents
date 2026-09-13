import SwiftUI

struct ThreadInboxView: View {
    let room: Room
    let context: String
    let session: SessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var items: [ThreadInboxItem] = []
    @State private var unreadOnly = false
    @State private var loading = false
    @State private var hasMore = false
    @State private var error: String?
    private var visible: [ThreadInboxItem] {
        items.map { item in
            var item = item
            item.root.thread = item.summary ?? item.root.thread
            if let read = session.threadReads[room.id + "|" + item.id],
               sequence(read.lastReadMessageId) >= sequence(item.root.thread?.latestReply?.id) {
                item.root.thread?.unreadCount = 0; item.root.thread?.hasUnread = false
            }
            return item
        }.filter { !unreadOnly || $0.root.thread?.unread == true }
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Threads", selection: $unreadOnly) { Text("All threads").tag(false); Text("Unread").tag(true) }.pickerStyle(.segmented)
                }.listRowBackground(Color.clear).listRowSeparator(.hidden)
                if let error { ErrorNotice(message: error); Button("Try again") { Task { await load() } } }
                if loading && items.isEmpty { ProgressView("Loading threads…").frame(maxWidth: .infinity).listRowBackground(Color.clear) }
                else if visible.isEmpty && error == nil {
                    ContentUnavailableView(unreadOnly ? "You’re all caught up" : "No threads yet", systemImage: "bubble.left.and.bubble.right", description: Text(unreadOnly ? "Unread replies will appear here." : "Reply to a message to start a focused conversation."))
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
                ForEach(visible) { item in
                    NavigationLink { ConversationView(room: room, rootID: item.id, context: context, session: session) } label: {
                        VStack(alignment: .leading, spacing: 9) {
                            HStack {
                                Text(item.root.author).font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
                                Spacer()
                                if let timestamp = item.root.thread?.latestReply?.timestamp,
                                   let date = MessageDate.parse(timestamp) { Text(date, style: .relative).font(.caption2).foregroundStyle(Theme.muted) }
                            }
                            Text(item.root.body).font(.subheadline.weight(.medium)).lineLimit(3)
                            if let summary = item.root.thread { ThreadPreview(summary: summary) }
                        }.padding(.vertical, 8)
                    }.listRowBackground(Theme.surface).accessibilityIdentifier("inbox-thread-\(item.id)")
                }
                if hasMore { Button("Load earlier threads") { Task { await load(older: true) } }.disabled(loading).frame(maxWidth: .infinity) }
            }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.background)
                .navigationTitle("Threads").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .refreshable { await load() }
                .task(id: unreadOnly) { items = []; await load() }
        }
    }
    private func sequence(_ id: String?) -> Int { Int(id?.replacingOccurrences(of: "msg_", with: "") ?? "") ?? 0 }
    private func load(older: Bool = false) async {
        guard let token = session.token else { return }
        loading = true; defer { loading = false }
        let filter = unreadOnly
        let before = older ? (items.last?.summary ?? items.last?.root.thread)?.latestReply?.id : nil
        do {
            let page = try await session.client.threads(roomID: room.id, token: token, unreadOnly: filter, before: before)
            try Task.checkCancellation(); guard filter == unreadOnly else { return }
            if older { let existing = Set(items.map(\.id)); items += page.threads.filter { !existing.contains($0.id) } }
            else { items = page.threads }
            hasMore = page.hasMore; error = nil
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription; session.handleUnauthorized(error, token: token) }
    }
}
