import SwiftUI

struct ConversationView: View {
    let session: SessionStore
    @State private var model: ConversationStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    @State private var atBottom = true
    @State private var hasUnread = false
    @FocusState private var composing: Bool

    init(room: Room, rootID: String? = nil, session: SessionStore) {
        self.session = session
        _model = State(initialValue: ConversationStore(room: room, rootID: rootID, session: session))
    }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 28) {
                    if let error = model.error { ErrorNotice(message: error) }
                    if model.isLoading {
                        ProgressView("Loading conversation…").frame(maxWidth: .infinity).padding(.top, 40)
                    } else if model.visibleMessages.isEmpty {
                        ContentUnavailableView("Start the conversation", systemImage: "bubble.left.and.bubble.right", description: Text("Send a message to the people and agents in this room."))
                    }
                    if model.hasOlder {
                        Button { Task { await model.loadOlder() } } label: {
                            HStack { if model.isLoadingOlder { ProgressView() }; Text("Load older messages") }.frame(maxWidth: .infinity)
                        }.disabled(model.isLoadingOlder).font(.subheadline)
                    }
                    ForEach(model.visibleMessages) { message in
                        MessageRow(message: message, showThread: model.rootID == nil, room: model.room, session: session)
                            .id(message.id)
                    }
                    Color.clear.frame(height: 1).id("conversation-bottom")
                        .onAppear { atBottom = true; hasUnread = false }
                        .onDisappear { atBottom = false }
                }.padding(24)
            }.scrollDismissesKeyboard(.interactively)
                .onChange(of: model.visibleMessages.last?.id) { old, _ in
                    if old == nil || atBottom || model.isSending {
                        proxy.scrollTo("conversation-bottom", anchor: .bottom)
                    } else { hasUnread = true }
                }
                .onChange(of: composing) { _, focused in
                    if focused && atBottom { proxy.scrollTo("conversation-bottom", anchor: .bottom) }
                }
                .overlay(alignment: .bottom) {
                    if hasUnread {
                        Button { proxy.scrollTo("conversation-bottom", anchor: .bottom); hasUnread = false } label: {
                            Label("New messages", systemImage: "arrow.down").font(.subheadline.weight(.semibold)).padding(12)
                                .background(Theme.surface, in: Capsule()).overlay(Capsule().stroke(Theme.line))
                        }.padding(.bottom, 12)
                    }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        }.background(Theme.background).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 4) {
                        Text(model.rootID == nil ? model.room.displayName : "Thread").font(.headline).lineLimit(1)
                        HStack(spacing: 5) {
                            Circle().fill(model.isConnected ? Theme.green : Theme.muted).frame(width: 5, height: 5)
                            Text(model.rootID == nil ? (model.isConnected ? "Connected" : "Reconnecting…") : model.room.displayName)
                                .font(.caption2).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                    }
                }
            }
            .onAppear { visible = true }
            .onDisappear { visible = false }
            .task(id: visible && scenePhase == .active) {
                if visible && scenePhase == .active { await model.run() }
            }
    }
    private var composer: some View {
        VStack(spacing: 8) {
            if let error = model.sendError { ErrorNotice(message: error) }
            HStack(alignment: .bottom, spacing: 12) {
                TextField(model.rootID == nil ? "Message \(model.room.displayName)…" : "Reply in thread…", text: $model.draft, axis: .vertical)
                    .lineLimit(1...5).padding(.vertical, 10).focused($composing).accessibilityLabel("Message")
                    .accessibilityIdentifier("message-composer")
                Button { Task { await model.send() } } label: {
                    Group {
                        if model.isSending { ProgressView().tint(Color.black) }
                        else { Image(systemName: "arrow.up").font(.headline) }
                    }.foregroundStyle(Color.black).frame(width: 44, height: 44)
                        .background(Theme.button, in: Circle())
                }.disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
                    .opacity(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.45 : 1)
                    .accessibilityLabel("Send message").accessibilityIdentifier("send-message")
            }.padding(10).padding(.leading, 8).background(Theme.surface, in: RoundedRectangle(cornerRadius: 24))
                .overlay(RoundedRectangle(cornerRadius: 24).stroke(Theme.line, lineWidth: 1))
        }.padding(.horizontal, 16).padding(.vertical, 8).background(Theme.background)
    }
}
private struct MessageRow: View {
    let message: Message
    let showThread: Bool
    let room: Room
    let session: SessionStore
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AvatarView(name: message.author)
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(message.author).font(.subheadline.weight(.semibold))
                    if let date = message.date {
                        Text(date, format: .dateTime.month(.abbreviated).day().hour().minute()).font(.caption2).foregroundStyle(Theme.muted)
                    }
                }
                Text(.init(message.body)).font(.body).lineSpacing(4).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let attachments = message.attachments, !attachments.isEmpty {
                    ForEach(attachments) { attachment in
                        Label(attachment.filename, systemImage: "paperclip").font(.caption).foregroundStyle(Theme.muted)
                    }
                    Text("Open attachments on LetAgents desktop.").font(.caption2).foregroundStyle(Theme.muted)
                }
                if showThread {
                    NavigationLink {
                        ConversationView(room: room, rootID: message.rootID, session: session)
                    } label: {
                        Label(replyLabel, systemImage: "bubble.left").font(.caption.weight(.medium)).frame(minHeight: 32)
                    }.accessibilityIdentifier("thread-\(message.id)")
                }
            }
        }
    }
    private var replyLabel: String {
        let count = message.thread?.replyCount ?? 0
        return count == 0 ? "Reply" : "\(count) \(count == 1 ? "reply" : "replies")"
    }
}
