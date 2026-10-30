import Foundation

/// A repository is a project, including when the account only belongs to one of its branches.
/// Git-bound focus rooms are branch rooms in the desktop contract; lineage remains explicit.
struct RoomProject: Identifiable, Hashable {
    let id: String
    let name: String
    let owner: String?
    let rooms: [Room]
    var pinned: Bool { rooms.contains { $0.pinned == true } }
    var general: Room? { rooms.first { $0.gitRoom == nil && $0.parentRoomId == nil } ?? rooms.first { $0.isDefaultBranch } }
    var branches: [Room] { rooms.filter { $0.gitRoom != nil && $0.id != general?.id }.sorted { $0.branchName.localizedStandardCompare($1.branchName) == .orderedAscending } }
    var focuses: [Room] { rooms.filter { $0.kind == "focus" && $0.gitRoom == nil } }
    var activeFocuses: [Room] { focuses.filter { $0.focusStatus != "concluded" } }
    var summary: String {
        var parts: [String] = []
        if !branches.isEmpty { parts.append("\(branches.count) \(branches.count == 1 ? "branch" : "branches")") }
        if !activeFocuses.isEmpty { parts.append("\(activeFocuses.count) focus \(activeFocuses.count == 1 ? "room" : "rooms")") }
        if parts.isEmpty { parts.append(general?.branchName ?? "Shared room") }
        return parts.joined(separator: " · ")
    }
    func focusRooms(for room: Room) -> [Room] { focuses.filter { $0.parentRoomId == room.id } }
    func matches(_ query: String) -> Bool {
        ([name, owner ?? ""] + rooms.flatMap { [$0.displayName, $0.roomId, $0.branchName] })
            .contains { $0.localizedCaseInsensitiveContains(query) }
    }
    static func build(_ roots: [Room]) -> [RoomProject] {
        struct Entry { var room: Room; let group: String; let owner: String?; let name: String }
        var entries: [String: Entry] = [:]
        func collect(_ room: Room, parent: String?, group: String?, owner: String?, name: String?) {
            guard room.archived != true else { return }
            var room = room
            room.parentRoomId = room.parentRoomId ?? parent
            let repository = room.gitRoom?.repository
            let key = repository.map { "\(room.gitRoom?.host ?? "github.com")/\($0.owner)/\($0.name)".lowercased() } ?? group ?? "room:\(room.id)"
            let entry = Entry(room: room, group: key, owner: repository?.owner ?? owner, name: repository?.name ?? name ?? room.displayName)
            // A flattened duplicate must not erase the parent supplied by the nested contract.
            if var previous = entries[room.id] {
                if previous.room.parentRoomId == nil && room.parentRoomId != nil {
                    var nested = entry
                    if previous.room.pinned == true { nested.room.pinned = true }
                    previous = nested
                }
                if room.pinned == true { previous.room.pinned = true }
                entries[room.id] = previous
            } else { entries[room.id] = entry }
            for child in room.focusRooms ?? [] { collect(child, parent: room.id, group: key, owner: entry.owner, name: entry.name) }
        }
        for room in roots { collect(room, parent: nil, group: nil, owner: nil, name: nil) }
        return Dictionary(grouping: entries.values, by: \.group).map { key, values in
            let ordered = values.sorted { $0.room.id < $1.room.id }
            return RoomProject(id: key, name: ordered[0].name, owner: ordered[0].owner, rooms: ordered.map(\.room))
        }.sorted {
            if $0.pinned != $1.pinned { return $0.pinned }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
}
