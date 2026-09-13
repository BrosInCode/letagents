import SwiftUI

struct ProjectsView: View {
    let session: SessionStore
    let account: Account
    @Environment(\.scenePhase) private var scenePhase
    @State private var rooms: [Room] = []
    @State private var search = ""
    @State private var loading = true
    @State private var error: String?
    @State private var showingAccount = false

    private var filtered: [Room] {
        guard !search.isEmpty else { return rooms }
        return rooms.filter { room in
            ([room.displayName, room.roomId] + (room.focusRooms ?? []).flatMap { [$0.displayName, $0.roomId] })
                .contains { $0.localizedCaseInsensitiveContains(search) }
        }
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    Text("Continue where you left off.").font(.body).foregroundStyle(Theme.muted)
                    HStack(spacing: 10) {
                        Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted)
                        TextField("Search your rooms", text: $search).autocorrectionDisabled().textInputAutocapitalization(.never)
                            .accessibilityIdentifier("room-search")
                        if !search.isEmpty { Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }.accessibilityLabel("Clear search") }
                    }.padding(15).background(Theme.surface, in: RoundedRectangle(cornerRadius: 15))
                    if let error {
                        ErrorNotice(message: error)
                        Button("Try again") { Task { await refresh() } }
                    }
                    if loading && rooms.isEmpty {
                        ProgressView("Loading your rooms…").frame(maxWidth: .infinity).padding(.top, 60)
                    } else if filtered.isEmpty && error == nil {
                        ContentUnavailableView {
                            Label(search.isEmpty ? "Your rooms will be here" : "No matching rooms", systemImage: "bubble.left.and.bubble.right")
                        } description: {
                            Text(search.isEmpty ? "Open or join a room on LetAgents with this GitHub account, then pull down to refresh." : "Try a project name or room name.")
                        }
                    } else {
                        roomSection("PINNED", rooms: filtered.filter { $0.pinned == true })
                        roomSection("YOUR ROOMS", rooms: filtered.filter { $0.pinned != true })
                    }
                }.padding(24)
            }.background(Theme.background).navigationTitle("Projects")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingAccount = true } label: { AvatarView(name: account.name) }
                            .accessibilityLabel("Account").accessibilityIdentifier("account-button")
                    }
                }
                .navigationDestination(for: Room.self) { room in ConversationView(room: room, session: session) }
                .sheet(isPresented: $showingAccount) { AccountView(session: session, account: account) }
                .refreshable { await refresh() }
                .task(id: scenePhase) { if scenePhase == .active { await refresh() } }
        }
    }
    @ViewBuilder private func roomSection(_ title: String, rooms: [Room]) -> some View {
        if !rooms.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text(title).font(.caption2.weight(.semibold)).tracking(1).foregroundStyle(Theme.muted)
                ForEach(rooms) { room in
                    NavigationLink(value: room) { RoomRow(room: room) }.buttonStyle(.plain)
                    ForEach((room.focusRooms ?? []).filter { search.isEmpty || room.displayName.localizedCaseInsensitiveContains(search) || $0.displayName.localizedCaseInsensitiveContains(search) || $0.roomId.localizedCaseInsensitiveContains(search) }) { focus in
                        NavigationLink(value: focus) { RoomRow(room: focus) }.buttonStyle(.plain).padding(.leading, 16)
                    }
                }
            }
        }
    }
    private func refresh() async {
        guard let token = session.token else { return }
        loading = true
        defer { loading = false }
        do {
            let result = try await session.client.rooms(token: token)
            try Task.checkCancellation()
            rooms = result
            error = nil
        } catch is CancellationError { }
        catch let error as URLError where error.code == .cancelled { }
        catch { self.error = error.localizedDescription; session.handleUnauthorized(error, token: token) }
    }
}
private struct RoomRow: View {
    let room: Room
    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: room.kind == "focus" ? "bubble.left.and.bubble.right" : "number")
                .font(.title3).foregroundStyle(Theme.accent).frame(width: 40, height: 40)
                .background(Theme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 6) {
                Text(room.displayName).font(.headline).foregroundStyle(Theme.ink)
                Text(room.subtitle).font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Theme.line, lineWidth: 1))
            .accessibilityElement(children: .combine)
    }
}
struct AccountView: View {
    let session: SessionStore
    let account: Account
    @Environment(\.dismiss) private var dismiss
    @State private var signingOut = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 26) {
                    AvatarView(name: account.name, size: 76).padding(.top, 26)
                    VStack(spacing: 10) {
                        Text(account.name).font(.title2.weight(.semibold))
                        Text("@\(account.login) · GitHub").foregroundStyle(Theme.muted)
                    }
                    VStack(alignment: .leading, spacing: 18) {
                        Text("CONNECTED TO").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                        Text("letagents.chat").font(.headline)
                        Label("Your rooms sync across devices", systemImage: "checkmark.circle.fill").font(.footnote).foregroundStyle(Theme.green)
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading).background(Theme.surface, in: RoundedRectangle(cornerRadius: 20))
                    if let error = session.error { ErrorNotice(message: error) }
                    Button(role: .destructive) {
                        signingOut = true
                        Task { await session.signOut(); signingOut = false }
                    } label: {
                        HStack { Text("Sign out"); Spacer(); if signingOut { ProgressView() } }
                            .padding(20).background(Theme.surface, in: RoundedRectangle(cornerRadius: 18))
                    }.disabled(signingOut).accessibilityIdentifier("sign-out")
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Built for the conversation.").font(.headline)
                        Text("Manage agents and projects on desktop.").font(.subheadline).foregroundStyle(Theme.muted)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 24)
                    Text("LETAGENTS FOR IPHONE · 1.0").font(.caption2).foregroundStyle(Theme.muted).padding(.top, 28)
                }.padding(24)
            }.background(Theme.background).navigationTitle("Account").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
