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
    @State private var pinnedOnly = false
    private var projects: [RoomProject] { RoomProject.build(rooms).filter { !pinnedOnly || $0.pinned } }
    private func ownerLabel(_ project: RoomProject) -> String {
        guard let owner = project.owner else { return "Shared rooms" }
        if owner.caseInsensitiveCompare(account.login) == .orderedSame { return account.login }
        return projects.first { $0.owner?.caseInsensitiveCompare(owner) == .orderedSame }?.owner ?? owner
    }
    private var owners: [String] {
        Array(Set(projects.map(ownerLabel))).sorted { a, b in
            if a == "Shared rooms" { return false }; if b == "Shared rooms" { return true }
            return a.localizedStandardCompare(b) == .orderedAscending
        }
    }
    var body: some View {
        NavigationStack {
            List {
                Section {
                    SearchInput(placeholder: "Search projects and rooms", text: $search, identifier: "room-search")
                    HStack(spacing: 10) {
                        filter("All projects", selected: !pinnedOnly) { pinnedOnly = false }
                        filter("Pinned", selected: pinnedOnly) { pinnedOnly = true }
                        Spacer()
                    }.padding(.vertical, 2)
                }.listRowBackground(Color.clear).listRowSeparator(.hidden)
                if let error {
                    Section { ErrorNotice(message: error); Button("Try again") { Task { await refresh() } } }
                }
                if loading && rooms.isEmpty {
                    ProgressView("Loading your rooms…").frame(maxWidth: .infinity).listRowBackground(Color.clear)
                } else if projects.isEmpty || (!search.isEmpty && !projects.contains { $0.matches(search) }) {
                    ContentUnavailableView(search.isEmpty ? "Your rooms will be here" : "No matching rooms", systemImage: "bubble.left.and.bubble.right", description: Text(search.isEmpty ? "Join a room with this GitHub account on LetAgents, then pull down to refresh." : "Search a project, branch, or focus room."))
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                } else if search.isEmpty {
                    ForEach(owners, id: \.self) { owner in
                        Section {
                            ForEach(projects.filter { ownerLabel($0) == owner }) { project in
                                NavigationLink {
                                    ProjectRoomsView(project: project, session: session)
                                } label: { ProjectRow(project: project) }
                                .listRowBackground(Theme.surface).accessibilityIdentifier("project-\(project.id)")
                            }
                        } header: { Text(owner).font(.caption.weight(.semibold)).tracking(0.8) }
                    }
                } else {
                    ForEach(projects.filter { $0.matches(search) }) { project in
                        Section(project.owner.map { "\($0) / \(project.name)" } ?? project.name) {
                            ForEach(project.rooms.filter { room in
                                project.name.localizedCaseInsensitiveContains(search) || (project.owner ?? "").localizedCaseInsensitiveContains(search)
                                || [room.displayName, room.branchName, room.id].contains { $0.localizedCaseInsensitiveContains(search) }
                            }) { room in roomLink(room, project: project) }
                        }
                    }
                }
            }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.background)
                .navigationTitle("Projects").navigationBarTitleDisplayMode(.large)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showingAccount = true } label: { HStack(spacing: 6) { AvatarView(name: account.name, size: 26, url: account.avatarUrl); Text("Account").font(.subheadline.weight(.medium)) }.frame(minHeight: 44).contentShape(Rectangle()) }
                            .accessibilityLabel("Account").accessibilityIdentifier("account-button")
                    }.companionToolbarStyle()
                }
                .sheet(isPresented: $showingAccount) { AccountView(session: session, account: account) }
                .refreshable { await refresh() }
                .task(id: scenePhase) { if scenePhase == .active { await refresh() } }
        }
    }
    private func filter(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(label).font(.subheadline.weight(.medium)).padding(.horizontal, 14).padding(.vertical, 8)
            .foregroundStyle(selected ? Theme.accent : Theme.muted).background(selected ? Theme.accent.opacity(0.12) : Theme.surface, in: Capsule())
        }.buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
    }
    private func roomLink(_ room: Room, project: RoomProject) -> some View {
        NavigationLink { ConversationView(room: room, context: project.name, session: session) } label: {
            RoomRow(room: room, subtitle: room.parentRoomId.flatMap { id in project.rooms.first { $0.id == id }?.branchName } ?? room.subtitle)
        }.listRowBackground(Theme.surface).accessibilityIdentifier("room-\(room.id)")
    }
    private func refresh() async {
        guard let token = session.token else { return }
        loading = true; defer { loading = false }
        do {
            let result = try await session.client.rooms(token: token)
            try Task.checkCancellation(); rooms = result; error = nil
        } catch is CancellationError { }
        catch let error as URLError where error.code == .cancelled { }
        catch { self.error = error.localizedDescription; session.handleUnauthorized(error, token: token) }
    }
}

struct SearchInput: View {
    let placeholder: String
    @Binding var text: String
    var identifier = "search"
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted)
            TextField(placeholder, text: $text).autocorrectionDisabled().textInputAutocapitalization(.never).accessibilityIdentifier(identifier)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted) }
                    .buttonStyle(.plain).accessibilityLabel("Clear search")
            }
        }.padding(12).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct ProjectRow: View {
    let project: RoomProject
    var body: some View {
        HStack(spacing: 12) {
            AvatarView(name: project.name, size: 44)
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(project.name).font(.headline).foregroundStyle(Theme.ink)
                    if project.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(Theme.accent).accessibilityLabel("Pinned") }
                }
                Text(project.summary).font(.caption).foregroundStyle(Theme.muted)
            }.padding(.vertical, 8)
        }.accessibilityElement(children: .combine)
    }
}

struct ProjectRoomsView: View {
    let project: RoomProject
    var branch: Room? = nil
    let session: SessionStore
    @State private var showConcluded = false
    @State private var branchesExpanded = false
    private var parent: Room? { branch ?? project.general }
    private var focuses: [Room] {
        let all = parent.map { project.focusRooms(for: $0) } ?? project.focuses.filter { $0.parentRoomId == nil }
        return all.filter { showConcluded || $0.focusStatus != "concluded" }
            .sorted { ($0.latestMessageAt ?? "") > ($1.latestMessageAt ?? "") }
    }
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(project.owner.map { "\($0) / \(project.name)" } ?? "Shared room").font(.subheadline).foregroundStyle(Theme.muted)
                    if let branch { Label(branch.branchName, systemImage: "arrow.triangle.branch").font(.headline) }
                }.padding(.vertical, 4)
            }.listRowBackground(Color.clear).listRowSeparator(.hidden)
            if let parent {
                Section {
                    NavigationLink { ConversationView(room: parent, context: project.name, session: session) } label: {
                        RoomRow(room: parent, title: "General", subtitle: "\(parent.gitRoom == nil ? "Main room" : parent.branchName) · \(parent.membership)", symbol: "number")
                    }.listRowBackground(Theme.outgoing).accessibilityIdentifier("room-\(parent.id)")
                }
            }
            if branch == nil && !project.branches.isEmpty {
                Section {
                    Button { branchesExpanded.toggle() } label: {
                        HStack {
                            Label("Branches", systemImage: "arrow.triangle.branch").font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                            Spacer(); Text("\(project.branches.count)").font(.subheadline).foregroundStyle(Theme.muted)
                            Image(systemName: branchesExpanded ? "chevron.down" : "chevron.right").font(.caption.weight(.semibold))
                        }.padding(.vertical, 6).contentShape(Rectangle())
                    }.listRowBackground(Theme.surface).accessibilityIdentifier("project-branches")
                    if branchesExpanded {
                    ForEach(project.branches) { room in
                        NavigationLink { ProjectRoomsView(project: project, branch: room, session: session) } label: {
                            RoomRow(room: room, title: room.branchName, subtitle: "\(project.focusRooms(for: room).filter { $0.focusStatus != "concluded" }.count) focus rooms · \(room.membership)", symbol: "arrow.triangle.branch")
                        }.listRowBackground(Theme.surface).accessibilityIdentifier("branch-\(room.id)")
                    }
                    }
                }
            }
            Section {
                ForEach(focuses) { room in
                    NavigationLink {
                        ConversationView(room: room, context: "\(project.name) › \(parent?.branchName ?? "Rooms")", session: session)
                    } label: { RoomRow(room: room) }.listRowBackground(Theme.surface).accessibilityIdentifier("room-\(room.id)")
                }
                if focuses.isEmpty { Text("No \(showConcluded ? "" : "active ")focus rooms").font(.subheadline).foregroundStyle(Theme.muted).padding(.vertical, 8) }
            } header: { HStack { Text("Focus rooms"); Spacer(); Text(parent?.gitRoom == nil ? "" : parent?.branchName ?? "").textCase(nil) } }
            Section { Toggle("Show concluded rooms", isOn: $showConcluded).font(.subheadline).listRowBackground(Theme.surface) }
        }.listStyle(.insetGrouped).scrollContentBackground(.hidden).background(Theme.background)
            .navigationTitle(branch?.branchName ?? project.name).navigationBarTitleDisplayMode(.inline)
    }
}
struct RoomRow: View {
    let room: Room
    var title: String? = nil
    var subtitle: String? = nil
    var symbol: String? = nil
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol ?? (room.focusStatus == "concluded" ? "checkmark.bubble" : "bubble.left.and.bubble.right"))
                .font(.system(size: 19, weight: .medium)).foregroundStyle(Theme.accent).frame(width: 32, height: 36)
            VStack(alignment: .leading, spacing: 5) {
                Text(title ?? room.displayName).font(.body.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(2)
                Text(subtitle ?? [room.focusStatus == "concluded" ? "Concluded" : "Active", room.role == "admin" ? "Admin" : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Theme.muted)
            }.padding(.vertical, 7)
        }.accessibilityElement(children: .combine)
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
                    AvatarView(name: account.name, size: 76, url: account.avatarUrl).padding(.top, 26)
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
            }.buttonStyle(.plain).background(Theme.background).navigationTitle("Account").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }.companionToolbarStyle() }
        }
    }
}
