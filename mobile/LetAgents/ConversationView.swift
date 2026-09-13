import SwiftUI

private struct ThreadDestination: Identifiable {
    let id: String
}
private struct QuoteDestination: Identifiable {
    let quote: ReplyPreview
    var id: String { quote.id }
}
private struct BottomPosition: PreferenceKey {
    static var defaultValue: CGFloat = .greatestFiniteMagnitude
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct ConversationView: View {
    let session: SessionStore
    let context: String
    @State private var model: ConversationStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false
    @State private var atBottom = true
    @State private var hasUnread = false
    @State private var positionedInitially = false
    @State private var composing = false
    @State private var selection = NSRange(location: 0, length: 0)
    @State private var editRevision = 0
    @State private var thread: ThreadDestination?
    @State private var showingThreads = false
    @State private var showingPeople = false
    @State private var selectedMention: MentionCandidate?
    @State private var mentionDismissed = false
    @State private var quotedSource: QuoteDestination?
    @State private var highlightedID: String?
    @State private var returnToReplyID: String?
    @ScaledMetric(relativeTo: .subheadline) private var mentionRowHeight = 55.0
    private var active: Bool { visible && scenePhase == .active && thread == nil && !showingThreads && quotedSource == nil }
    private var mentionQuery: MentionQuery? { composing && !mentionDismissed ? Mentions.query(in: model.draft, selection: selection) : nil }
    private var mentionCandidates: [MentionCandidate] { Mentions.candidates(model.participants, query: mentionQuery?.query ?? "") }

    init(room: Room, rootID: String? = nil, context: String = "", session: SessionStore) {
        self.session = session; self.context = context
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
                                        .contextMenu {
                                            Button("Quote reply", systemImage: "arrowshape.turn.up.left") { reply(to: message) }
                                            if model.rootID == nil { Button("Reply in thread", systemImage: "bubble.left.and.bubble.right") { openThread(message.rootID) } }
                                            Button("Copy message", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.body }
                                        }
                                        .accessibilityAction(named: Text("Quote reply")) { reply(to: message) }
                                    if model.rootID == nil, let summary = message.thread, summary.replyCount > 0 {
                                        Button { openThread(message.rootID) } label: { ThreadPreview(summary: summary) }
                                            .buttonStyle(.plain).accessibilityIdentifier("thread-\(message.id)")
                                    }
                                }.padding(.leading, 39).modifier(SwipeToReply(reply: { reply(to: message) }))
                                    .overlay(highlight(for: message.id)).id(message.id)
                            } else {
                                MessageBubble(message: message, mine: !message.isAgent && message.sender.caseInsensitiveCompare(session.account?.login ?? "") == .orderedSame,
                                    grouped: isGrouped(index), original: model.rootID == message.id,
                                    threadSummary: model.rootID == nil ? message.thread : nil,
                                    reply: { reply(to: message) }, openThread: model.rootID == nil ? { openThread(message.rootID) } : nil,
                                    jumpTo: { id in
                                        composing = false
                                        if model.visibleMessages.contains(where: { $0.id == id }) {
                                            returnToReplyID = message.id; highlightedID = id
                                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .center) }
                                        } else if let quote = message.replyTo { quotedSource = .init(quote: quote) }
                                    })
                                    .overlay(highlight(for: message.id))
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
                        VStack(alignment: .trailing, spacing: 8) {
                        if let returnID = returnToReplyID {
                            Button {
                                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(returnID, anchor: .center) }
                                returnToReplyID = nil; highlightedID = returnID
                            } label: {
                                Label("Back to reply", systemImage: "arrow.uturn.backward").font(.caption.weight(.semibold))
                                    .padding(14).background(Theme.surface, in: Capsule()).overlay(Capsule().stroke(Theme.line, lineWidth: 0.5))
                            }.accessibilityIdentifier("back-to-reply")
                        }
                        if !atBottom && !model.isLoading {
                            Button { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo("conversation-bottom", anchor: .bottom) } } label: {
                                HStack(spacing: 6) { if hasUnread { Text("New messages").font(.caption.weight(.semibold)) }; Image(systemName: "arrow.down").font(.subheadline.weight(.semibold)) }
                                    .padding(13).background(Theme.surface, in: Capsule()).overlay(Capsule().stroke(Theme.line, lineWidth: 0.5))
                            }.accessibilityLabel("Jump to latest messages")
                        }
                        }.padding(14)
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
            .accessibilityHidden(thread != nil || showingThreads || showingPeople || selectedMention != nil || quotedSource != nil)
            .sheet(item: $quotedSource) { destination in
                QuotedMessageSheet(quote: destination.quote, model: model)
                    .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
            .sheet(item: $thread) { destination in
                NavigationStack {
                    ConversationView(room: model.room, rootID: destination.id, context: context, session: session)
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
                editRevision += 1
            }
            .onDisappear { visible = false; composing = false }
            .onChange(of: model.draft) { _, _ in mentionDismissed = false }
            .task(id: highlightedID) {
                guard highlightedID != nil else { return }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { highlightedID = nil }
            }
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
                    Button { composing = false; quotedSource = .init(quote: quote) } label: { QuotePreview(quote: quote, composing: true) }
                        .buttonStyle(.plain).accessibilityLabel("Replying to \(quote.author): \(quote.body)").accessibilityHint("Read the original message")
                        .accessibilityIdentifier("reply-preview")
                    Button { model.quote = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted).frame(width: 44, height: 44) }.accessibilityLabel("Cancel reply")
                }
            }
            if mentionQuery != nil { mentionPanel }
            HStack(alignment: .bottom, spacing: 8) {
                HStack(alignment: .bottom, spacing: 8) {
                    Button {
                        let location = min(selection.location, model.draft.utf16.count)
                        let prefix = location > 0 && !(model.draft as NSString).substring(to: location).hasSuffix(" ") ? " @" : "@"
                        model.draft = (model.draft as NSString).replacingCharacters(in: NSRange(location: location, length: 0), with: prefix)
                        selection = NSRange(location: location + prefix.utf16.count, length: 0); editRevision += 1; composing = true; mentionDismissed = false
                    } label: { Image(systemName: "at").font(.body).foregroundStyle(Theme.muted).frame(width: 32, height: 44) }.accessibilityLabel("Mention someone")
                    ZStack(alignment: .topLeading) {
                        if model.draft.isEmpty { Text(model.rootID == nil ? "Message…" : "Reply in thread…").foregroundStyle(Theme.secondary).padding(.top, 10).allowsHitTesting(false).accessibilityHidden(true) }
                        MessageEditor(text: $model.draft, selection: $selection, focused: $composing, editRevision: editRevision,
                                      identifier: model.rootID == nil ? "message-composer" : "thread-composer")
                    }
                }.padding(.leading, 7).padding(.trailing, 13).background(Theme.surface, in: RoundedRectangle(cornerRadius: 23))
                Button {
                    mentionDismissed = true
                    Task {
                        await model.send()
                        if model.draft.isEmpty { selection = NSRange(location: 0, length: 0); editRevision += 1 }
                    }
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
        editRevision += 1; composing = true; mentionDismissed = true
    }
    private func openThread(_ id: String) { composing = false; thread = .init(id: id) }
    private func reply(to message: Message) {
        model.quote = ReplyPreview(message: message); composing = true
    }
    private func highlight(for id: String) -> some View {
        RoundedRectangle(cornerRadius: 16).stroke(Theme.accent.opacity(highlightedID == id ? 0.9 : 0), lineWidth: 2)
            .allowsHitTesting(false).accessibilityHidden(true)
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

// An older quote can be read without inserting a disconnected message into the
// timeline, skipping intervening history, or losing the reader's current place.
private struct QuotedMessageSheet: View {
    let quote: ReplyPreview
    let model: ConversationStore
    @Environment(\.dismiss) private var dismiss
    @State private var message: Message?
    @State private var error: String?
    @State private var attempt = 0
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let message {
                        HStack(spacing: 12) {
                            AvatarView(name: message.author)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(message.author).font(.headline).foregroundStyle(Theme.accent)
                                if let attribution = message.attribution { Text(attribution).font(.caption).foregroundStyle(Theme.muted) }
                                if let date = message.date { Text(date.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(Theme.secondary) }
                            }
                        }
                        RichMessage(message.body).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
                        Button { UIPasteboard.general.string = message.body } label: { Label("Copy message", systemImage: "doc.on.doc").frame(minHeight: 44) }
                    } else if let error {
                        QuotePreview(quote: quote)
                        Text(error).foregroundStyle(Theme.muted)
                        Button("Try again") { self.error = nil; attempt += 1 }.frame(minHeight: 44)
                    } else { ProgressView("Loading original message…").frame(maxWidth: .infinity).padding(.top, 30) }
                }.padding(20)
            }.background(Theme.background).navigationTitle("Quoted message").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .task(id: attempt) {
                    do { message = try await model.quotedMessage(id: quote.id) }
                    catch is CancellationError { }
                    catch let failure as URLError where failure.code == .cancelled { }
                    catch { self.error = (error as? APIError)?.status == 404 ? "This message is no longer available." : "Couldn’t load the original message. Try again when you’re connected." }
                }
        }
    }
}
