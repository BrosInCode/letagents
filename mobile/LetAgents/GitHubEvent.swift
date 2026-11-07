import SwiftUI

struct GitHubEvent: Equatable {
    let kind: String
    let headline: String
    var detail: String? = nil
    var repository: String? = nil
    var status: String? = nil
    var task: String? = nil
    var url: URL? = nil
    var symbol: String {
        switch kind {
        case "Pull request": return "arrow.triangle.pull"
        case "Issue": return "exclamationmark.circle"
        case "Review": return "checkmark.bubble"
        case "Check run": return status == "success" ? "checkmark.circle" : "checklist"
        case "Comment": return "text.bubble"
        case "Repository": return "folder"
        default: return "arrow.triangle.branch"
        }
    }
    var color: Color {
        if ["merged", "approved", "success"].contains(status ?? "") { return Theme.green }
        return kind == "Pull request" || kind == "Comment" ? Theme.blue : Theme.accent
    }
    static func parse(_ message: Message) -> GitHubEvent? {
        guard message.source == "github" || message.sender.lowercased() == "github" else { return nil }
        var text = message.body.trimmingCharacters(in: .whitespacesAndNewlines)
        var url: URL?
        if let match = MessageMarkdown.captures(#"\s(https?://\S+)$"#, text), let candidate = URL(string: match[0]) {
            if ["http", "https"].contains(candidate.scheme ?? "") { url = candidate }
            text = String(text.dropLast(match[0].count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let m = MessageMarkdown.captures(#"(?i)^(.+?)\s+(approved|requested changes on|reviewed)\s+(PR #\d+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?$"#, text) {
            return .init(kind: "Review", headline: "\(m[0]) \(m[1]) \(m[2])", repository: m[3], status: m[1] == "requested changes on" ? "changes requested" : m[1], task: m[4].nilIfEmpty, url: url)
        }
        if let m = MessageMarkdown.captures(#"(?i)^(.+?)\s+commented on\s+(PR #\d+|Issue #\d+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?:\s+\"([\s\S]*)\"$"#, text) {
            return .init(kind: "Comment", headline: "\(m[0]) commented on \(m[1])", detail: m[4], repository: m[2], status: "new comment", task: m[3].nilIfEmpty, url: url)
        }
        if let m = MessageMarkdown.captures(#"(?i)^Check \"([^\"]+)\"(?: \(([^)]+)\))?\s+([a-z_]+)\s+in\s+([^\s]+?)(?:\s+linked to\s+(task_\d+))?$"#, text) {
            return .init(kind: "Check run", headline: m[0], detail: m[1].nilIfEmpty.map { "Reported by \($0)" }, repository: m[3], status: m[2].replacingOccurrences(of: "_", with: " "), task: m[4].nilIfEmpty, url: url)
        }
        if let m = MessageMarkdown.captures(#"(?i)^(PR #\d+|Issue #\d+)\s+(.+?)\s+in\s+([^\s:]+)(?:\s+linked to\s+(task_\d+))?(?::\s*([\s\S]*))?$"#, text) {
            let action = m[1].lowercased()
            let status = ["ready for review", "merged", "closed", "reopened", "opened", "draft"].first { action.contains($0) }
            return .init(kind: m[0].hasPrefix("PR") ? "Pull request" : "Issue", headline: "\(m[0]) \(m[1])", detail: m[4].nilIfEmpty, repository: m[2], status: status, task: m[3].nilIfEmpty, url: url)
        }
        return .init(kind: text.hasPrefix("Repository") ? "Repository" : "GitHub event", headline: text, url: url)
    }
}
private extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

struct GitHubEventCard: View {
    let event: GitHubEvent
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: event.symbol).font(.subheadline).foregroundStyle(event.color)
                Text("GitHub · \(event.kind)").font(.caption.weight(.medium)).foregroundStyle(Theme.muted)
                Spacer(minLength: 0)
            }
            Text(event.headline).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
            if let detail = event.detail { RichMessage(detail).font(.callout) }
            if let repository = event.repository {
                Text(repository + (event.task.map { " · \($0)" } ?? "")).font(.caption).foregroundStyle(Theme.muted)
            }
            HStack {
                if let status = event.status {
                    Text(status.capitalized).font(.caption2.weight(.medium)).foregroundStyle(event.color)
                        .padding(.horizontal, 8).padding(.vertical, 4).background(event.color.opacity(0.10), in: Capsule())
                }
                Spacer(minLength: 0)
                if let url = event.url {
                    Link(destination: url) { Label("Open on GitHub", systemImage: "arrow.up.right").font(.caption.weight(.medium)).frame(minHeight: 36) }
                }
            }
        }.padding(14).background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.line, lineWidth: 0.5))
            .accessibilityIdentifier("github-event-card")
    }
}
