import SwiftUI

@main struct LetAgentsApp: App {
    @State private var session: SessionStore
    init() {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-testing") {
            _session = State(initialValue: UITestFixtures.makeSession())
            return
        }
        #endif
        _session = State(initialValue: SessionStore())
    }
    var body: some Scene {
        WindowGroup {
            RootView(session: session).buttonStyle(.plain).tint(Theme.accent).foregroundStyle(Theme.ink)
        }
    }
}
struct RootView: View {
    @Bindable var session: SessionStore
    var body: some View {
        Group {
            if session.isRestoring {
                ProgressView("Connecting to LetAgents…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if session.restoreFailed {
                ContentUnavailableView {
                    Label("Unable to reconnect", systemImage: "wifi.exclamationmark")
                } description: { Text(session.error ?? "Check your connection and try again.") }
                actions: { Button("Try again") { Task { await session.restore() } }.buttonStyle(.borderedProminent) }
            } else if let account = session.account {
                ProjectsView(session: session, account: account).id(session.sessionID)
            } else {
                WelcomeView(session: session)
            }
        }.background(Theme.background.ignoresSafeArea()).task { await session.restore() }
    }
}
