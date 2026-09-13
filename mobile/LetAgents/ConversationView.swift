import SwiftUI

private struct ThreadDestination: Identifiable {
    let id: String
    var quote: ReplyPreview? = nil
}
private struct BottomPosition: PreferenceKey {
    static var defaultValue: CGFloat = .greatestFiniteMagnitude
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct ConversationView: View {
    let session: SessionStore
    let context: String
    let initialQuote: ReplyPreview?
    @State private var model: ConversationStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false
    @State private var atBottom = true
    @State private var hasUnread = false
    @State private var positionedInitially = false
    @State private var composing = false
    @State private var selection = NSRange(location: 0, length: 0)
    @State private var thread: ThreadDestination?
    @State private var showingThreads = false
    @State private var showingPeople = false
    @State private var selectedMention: MentionCandidate?
    @State private var mentionDismissed = false
    @ScaledMetric(relativeTo: .subheadline) private var mentionRowHeight = 55.0
    private var active: Bool { visible && scenePhase == .active && thread == nil && !showingThreads }
    private var mentionQuery: MentionQuery? { composing && !mentionDismissed ? Mentions.query(in: model.draft, selection: selection) : nil }
    private var mentionCandidates: [MentionCandidate] { Mentions.candidates(model.participants, query: mentionQuery?.query ?? "") }

    init(room: Room, rootID: String? = nil, context: String = "", initialQuote: ReplyPreview? = nil, session: SessionStore) {
        self.session = session; self.context = context; self.initialQuote = initialQuote
        _model = State(initialValue: ConversationStore(room: room, rootID: rootID, session: session))
    }
    var body: some View {
        ScrollViewReader { proxy in
            GeometryReader { viewport in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        if let error = model.error { ErrorNotice(message: error) }
                        if model.isLoading { ProgressView("Loading conversation…").frame(maxWidth: .infinity).padding(.top, 40) }
                        else if model.visibleMessages.isEmpty {
                            ContentUnavailableView("Start the conversation", systemImage: "bubble.left.and.bubble.right", description: Text("Write to the people and agents in this room."))
                        }
                        if model.hasOlder {
                            Button {
                                let anchor = model.visibleMessages.first?.id
                                Task { await model.loadOlder(); if let anchor { proxy.scrollTo(anchor, anchor: .top) } }
                            } label: { HStack { if model.isLoadingOlder { ProgressView() }; Text("Load earlier messages") }.frame(maxWidth: .infinity).padding(.vertical, 6) }
                            .disabled(model.isLoadingOlder).font(.caption.weight(.medium))
                        }
                        ForEach(Array(model.visibleMessages.enumerated()), id: \.element.id) { index, message in
                            if showsDate(index) { dateSeparator(message) }
                            if model.rootID != nil && index == 1 {
                                HStack { Text("Replies").font(.caption.weight(.semibold)); Rectangle().fill(Theme.line).frame(height: 0.5) }.foregroundStyle(Theme.muted).padding(.vertical, 6)
                            }
                            if let event = GitHubEvent.parse(message) {
                                VStack(alignment: .leading, spacing: 7) {
                                    GitHubEventCard(event: event)
                                        .contextMenu { Button("Reply in thread", systemImage: "arrowshape.turn.up.left") { reply(to: message) } }
                                    if model.rootID == nil, let summary = message.thread, summary.replyCount > 0 {
                                        Button { openThread(message.rootID) } label: { ThreadPreview(summary: summary) }
                                            .buttonStyle(.plain).accessibilityIdentifier("thread-\(message.id)")
                                    }
                                }.padding(.leading, 39).id(message.id)
                            } else {
                                MessageBubble(message: message, mine: !message.isAgent && message.sender.caseInsensitiveCompare(session.account?.login ?? "") == .orderedSame,
                                    grouped: isGrouped(index), original: model.rootID == message.id,
                                    threadSummary: model.rootID == nil ? message.thread : nil,
                                    reply: { reply(to: message) }, openThread: model.rootID == nil ? { openThread(message.rootID) } : nil,
                                    jumpTo: { proxy.scrollTo($0, anchor: .center) })
                                    .id(message.id)
                            }
                        }
                        if model.rootID != nil && !model.isLoading && model.visibleMessages.count == 1 {
                            Label("Reply here to keep this conversation together.", systemImage: "bubble.left").font(.subheadline).foregroundStyle(Theme.muted).padding(.vertical, 30)
                        }
                        Color.clear.frame(height: 1).id("conversation-bottom")
                            .background(GeometryReader { geo in Color.clear.preference(key: BottomPosition.self, value: geo.frame(in: .named("timeline")).maxY) })
                    }.padding(.horizontal, 14).padding(.vertical, 14)
                }.coordinateSpace(name: "timeline").scrollDismissesKeyboard(.interactively)
                    .defaultScrollAnchor(.bottom)
                    .onPreferenceChange(BottomPosition.self) { bottom in
                        let reached = bottom > 0 && bottom <= viewport.size.height + 24
                        if reached { atBottom = true; hasUnread = false }
                        else { atBottom = false }
                    }
                    .onChange(of: model.visibleMessages.last?.id) { old, _ in
                        if old == nil || atBottom || model.lastSentMessageID == model.visibleMessages.last?.id {
                            hasUnread = false
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo("conversation-bottom", anchor: .bottom) }
                        }
                        else { hasUnread = true }
                    }
                    .onChange(of: composing) { _, focused in if focused && atBottom { proxy.scrollTo("conversation-bottom", anchor: .bottom) } }
                    .onChange(of: model.isConnected) { _, connected in
                        // Root recovery can prepend history after the latest page has appeared.
                        // Finish the initial positioning only once that recovery is complete.
                        if connected && !positionedInitially {
                            positionedInitially = true
                            proxy.scrollTo("conversation-bottom", anchor: .bottom)
                        }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if !atBottom && !model.isLoading {
                            Button { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo("conversation-bottom", anchor: .bottom) } } label: {
                                HStack(spacing: 6) { if hasUnread { Text("New messages").font(.caption.weight(.semibold)) }; Image(systemName: "arrow.down").font(.subheadline.weight(.semibold)) }
                                    .padding(13).background(Theme.surface, in: Capsule()).overlay(Capsule().stroke(Theme.line, lineWidth: 0.5))
                            }.accessibilityLabel("Jump to latest messages").padding(14)
                        }
                    }
            }.safeAreaInset(edge: .bottom, spacing: 0) { composer }
        }.background(Theme.background).navigationBarTitleDisplayMode(.inline)
            .toolbar { conversationToolbar }
            .environment(\.openURL, OpenURLAction { url in
                if url.scheme == "letagents", url.host == "mention" {
                    let handle = String(url.path.dropFirst())
                    selectedMention = Mentions.candidates(model.participants, query: handle).first { $0.handle.caseInsensitiveCompare(handle) == .orderedSame }
                        ?? .init(id: handle, name: handle, handle: handle, detail: "Mentioned in this conversation")
                    return .handled
                }
                return ["https", "http", "mailto"].contains(url.scheme ?? "") ? .systemAction : .discarded
            })
            .accessibilityHidden(thread != nil || showingThreads || showingPeople || selectedMention != nil)
            .sheet(item: $thread) { destination in
                NavigationStack {
                    ConversationView(room: model.room, rootID: destination.id, context: context, initialQuote: destination.quote, session: session)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { thread = nil } } }
                }.presentationDragIndicator(.visible).presentationDetents([.large])
            }
            .sheet(isPresented: $showingThreads) { ThreadInboxView(room: model.room, context: context, session: session) }
            .sheet(isPresented: $showingPeople) { peopleSheet }
            .sheet(item: $selectedMention) { mention in
                NavigationStack {
                    VStack(spacing: 18) {
                        AvatarView(name: mention.name, size: 72)
                        Text(mention.name).font(.title2.weight(.semibold))
                        Text(mention.detail).foregroundStyle(Theme.muted)
                        Text("@\(mention.handle)").font(.callout).textSelection(.enabled)
                        Button("Mention in conversation") { selectedMention = nil; insertMention(mention) }.buttonStyle(PrimaryButtonStyle()).padding(.top, 12)
                    }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.background)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { selectedMention = nil } } }
                }.presentationDetents([.medium, .large])
            }
            .onAppear {
                visible = true; selection = NSRange(location: model.draft.utf16.count, length: 0)
                if let initialQuote, model.quote == nil { model.quote = initialQuote }
            }
            .onDisappear { visible = false; composing = false }
            .onChange(of: model.draft) { _, _ in mentionDismissed = false }
            .task(id: active) { if active { await model.run() } }
            .task(id: active) { if active { await model.watchParticipants() } }
            .task(id: "\(active)-\(atBottom)-\(model.visibleMessages.last?.id ?? "")") {
                if active && atBottom, let last = model.visibleMessages.last { await model.markRead(through: last) }
            }
    }
    @ToolbarContentBuilder private var conversationToolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 3) {
                Text(model.rootID == nil ? model.room.displayName : "Thread").font(.headline).lineLimit(1)
                Text(model.rootID == nil ? (context.isEmpty ? model.room.subtitle : context) : model.room.displayName)
                    .font(.caption2).foregroundStyle(Theme.muted).lineLimit(1)
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if model.rootID == nil { Button("Threads", systemImage: "bubble.left.and.bubble.right") { composing = false; showingThreads = true } }
                Button("People & agents", systemImage: "person.2") { composing = false; showingPeople = true }
                Label(model.isConnected ? "Connected" : "Reconnecting…", systemImage: model.isConnected ? "checkmark.circle" : "wifi.exclamationmark")
            } label: { Image(systemName: "ellipsis").frame(minWidth: 28, minHeight: 32) }.accessibilityLabel("Conversation options")
        }
    }
    private var composer: some View {
        VStack(spacing: 8) {
            if let error = model.sendError { ErrorNotice(message: error) }
            if let quote = model.quote {
                HStack(alignment: .top) {
                    QuotePreview(quote: quote)
                    Button { model.quote = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted).frame(width: 32, height: 44) }.accessibilityLabel("Cancel reply")
                }
            }
            if mentionQuery != nil { mentionPanel }
            HStack(alignment: .bottom, spacing: 8) {
                HStack(alignment: .bottom, spacing: 8) {
                    Button {
                        let location = min(selection.location, model.draft.utf16.count)
                        let prefix = location > 0 && !(model.draft as NSString).substring(to: location).hasSuffix(" ") ? " @" : "@"
                        model.draft = (model.draft as NSString).replacingCharacters(in: NSRange(location: location, length: 0), with: prefix)
                        selection = NSRange(location: location + prefix.utf16.count, length: 0); composing = true; mentionDismissed = false
                    } label: { Image(systemName: "at").font(.body).foregroundStyle(Theme.muted).frame(width: 32, height: 44) }.accessibilityLabel("Mention someone")
                    ZStack(alignment: .topLeading) {
                        if model.draft.isEmpty { Text(model.rootID == nil ? "Message…" : "Reply in thread…").foregroundStyle(Theme.secondary).padding(.top, 10).allowsHitTesting(false).accessibilityHidden(true) }
                        MessageEditor(text: $model.draft, selection: $selection, focused: $composing,
                                      identifier: model.rootID == nil ? "message-composer" : "thread-composer")
                    }
                }.padding(.leading, 7).padding(.trailing, 13).background(Theme.surface, in: RoundedRectangle(cornerRadius: 23))
                Button {
                    mentionDismissed = true
                    Task { await model.send(); selection = NSRange(location: model.draft.utf16.count, length: 0) }
                } label: {
                    Group { if model.isSending { ProgressView().tint(Color(red: 52/255, green: 37/255, blue: 27/255)) } else { Image(systemName: "arrow.up").font(.headline) } }
                        .foregroundStyle(Color(red: 52/255, green: 37/255, blue: 27/255)).frame(width: 44, height: 44).background(Theme.button, in: Circle())
                }.disabled(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
                    .opacity(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
                    .accessibilityLabel("Send message").accessibilityIdentifier(model.rootID == nil ? "send-message" : "send-thread-message")
            }
        }.padding(.horizontal, 12).padding(.vertical, 8).background(Theme.background)
    }
    private var mentionPanel: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Mention people & agents").font(.caption.weight(.medium)).foregroundStyle(Theme.muted)
                Spacer()
                Button { mentionDismissed = true } label: { Image(systemName: "xmark").font(.caption).frame(width: 32, height: 32) }.accessibilityLabel("Close mentions")
            }.padding(.horizontal, 12)
            if let error = model.participantsError {
                Button { Task { await model.refreshParticipants() } } label: { Label(error + " Tap to retry.", systemImage: "arrow.clockwise").font(.caption) }.padding(10)
            }
            if mentionCandidates.isEmpty { Text("No matching participants").font(.subheadline).foregroundStyle(Theme.muted).padding(14) }
            else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(mentionCandidates) { candidate in
                            Button { insertMention(candidate) } label: {
                                HStack(spacing: 10) {
                                    AvatarView(name: candidate.name, size: 30)
                                    VStack(alignment: .leading, spacing: 2) { Text(candidate.name).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink); Text(candidate.detail).font(.caption).foregroundStyle(Theme.muted) }
                                    Spacer(); Image(systemName: "at").font(.caption).foregroundStyle(Theme.accent)
                                }.padding(.horizontal, 12).padding(.vertical, 9).contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityIdentifier("mention-\(candidate.handle)")
                        }
                    }
                }.frame(maxHeight: min(CGFloat(mentionCandidates.count) * mentionRowHeight, 210))
            }
        }.background(Theme.surface, in: RoundedRectangle(cornerRadius: 14)).overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 0.5))
    }
    private var peopleSheet: some View {
        NavigationStack {
            List {
                Section {
                    Text(context).font(.caption).foregroundStyle(Theme.muted)
                    Text(model.room.displayName).font(.headline)
                }.listRowBackground(Theme.surface)
                Section("People & agents") {
                    ForEach(model.participants.filter { $0.hiddenAt == nil }) { participant in
                        HStack(spacing: 12) {
                            AvatarView(name: participant.displayName)
                            VStack(alignment: .leading, spacing: 4) { Text(participant.displayName).font(.headline); Text(participant.detail).font(.caption).foregroundStyle(Theme.muted) }
                            Spacer()
                            Text(participant.activityState?.capitalized ?? "").font(.caption2).foregroundStyle(Theme.muted)
                        }.listRowBackground(Theme.surface)
                    }
                    if model.participants.isEmpty { Text(model.participantsError ?? "No participants to show yet.").foregroundStyle(Theme.muted) }
                }
            }.scrollContentBackground(.hidden).background(Theme.background).navigationTitle("Room details").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingPeople = false } } }
                .refreshable { await model.refreshParticipants() }
        }
    }
    private func insertMention(_ candidate: MentionCandidate) {
        if let query = mentionQuery {
            let result = Mentions.inserting(candidate, into: model.draft, query: query); model.draft = result.0; selection = result.1
        } else {
            let value = (model.draft.isEmpty || model.draft.hasSuffix(" ") ? "" : " ") + "@\(candidate.handle) "
            model.draft += value; selection = NSRange(location: model.draft.utf16.count, length: 0)
        }
        composing = true; mentionDismissed = true
    }
    private func openThread(_ id: String) { composing = false; thread = .init(id: id) }
    private func reply(to message: Message) {
        if model.rootID == nil { composing = false; thread = .init(id: message.rootID, quote: ReplyPreview(message: message)) }
        else { model.quote = ReplyPreview(message: message); composing = true }
    }
    private func showsDate(_ index: Int) -> Bool {
        guard let current = model.visibleMessages[index].date else { return false }
        guard index > 0, let previous = model.visibleMessages[index - 1].date else { return true }
        return !Calendar.current.isDate(current, inSameDayAs: previous)
    }
    private func isGrouped(_ index: Int) -> Bool {
        guard index > 0, !showsDate(index) else { return false }
        let previous = model.visibleMessages[index - 1], current = model.visibleMessages[index]
        guard previous.id != model.rootID, current.sender == previous.sender, current.source == previous.source,
              let date = current.date, let earlier = previous.date, date.timeIntervalSince(earlier) < 120 else { return false }
        return previous.thread?.replyCount ?? 0 == 0
    }
    @ViewBuilder private func dateSeparator(_ message: Message) -> some View {
        if let date = message.date {
            Text(Calendar.current.isDateInToday(date) ? "Today" : date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()))
                .font(.caption2.weight(.medium)).foregroundStyle(Theme.secondary).frame(maxWidth: .infinity).padding(.vertical, 6)
        }
    }
}
