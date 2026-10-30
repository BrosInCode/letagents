import Foundation
import Observation

@MainActor @Observable final class RoomDirectoryStore {
    private let session: SessionStore
    private let sessionID: UUID
    private(set) var rooms: [Room] = []
    private(set) var isLoading = true
    private(set) var hasLoaded = false
    private(set) var error: String?
    private var requestID = UUID()
    var projects: [RoomProject] { RoomProject.build(rooms) }
    var recentRooms: [Room] {
        projects.flatMap(\.rooms).filter { $0.latestMessageAt != nil && $0.focusStatus != "concluded" }
            .sorted {
                let left = $0.latestMessageAt.flatMap(MessageDate.parse) ?? .distantPast
                let right = $1.latestMessageAt.flatMap(MessageDate.parse) ?? .distantPast
                return left == right ? $0.id < $1.id : left > right
            }
    }
    init(session: SessionStore) { self.session = session; sessionID = session.sessionID }
    func room(_ id: String) -> Room? { projects.lazy.flatMap(\.rooms).first { $0.id == id } }
    func project(containing id: String) -> RoomProject? { projects.first { $0.rooms.contains { $0.id == id } } }
    func refresh() async {
        guard session.sessionID == sessionID, let token = session.token else { return }
        let request = UUID(); requestID = request; isLoading = true
        defer { if requestID == request { isLoading = false } }
        do {
            let result = try await session.client.rooms(token: token)
            try Task.checkCancellation()
            guard requestID == request, session.sessionID == sessionID else { return }
            rooms = result; error = nil; hasLoaded = true
        } catch is CancellationError { }
        catch let error as URLError where error.code == .cancelled { }
        catch {
            guard requestID == request, session.sessionID == sessionID else { return }
            self.error = "Couldn’t refresh your rooms. \(rooms.isEmpty ? "Check your connection and try again." : "Showing the rooms already loaded.")"
            session.handleUnauthorized(error, token: token)
        }
    }
}
