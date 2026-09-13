import SwiftUI

struct MentionCandidate: Identifiable, Equatable {
    let id: String
    let name: String
    let handle: String
    let detail: String
    var isAgent = false
}
struct MentionQuery: Equatable {
    let query: String
    let range: NSRange
}
enum Mentions {
    static let handlePattern = #"[A-Za-z0-9][A-Za-z0-9_.:-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)*"#
    static func query(in text: String, selection: NSRange) -> MentionQuery? {
        let value = text as NSString
        guard selection.length == 0, selection.location <= value.length else { return nil }
        let before = value.substring(to: selection.location)
        let regex = try! NSRegularExpression(pattern: #"(?:^|[\s(])@([A-Za-z0-9_.:/-]*)$"#)
        guard let match = regex.firstMatch(in: before, range: NSRange(location: 0, length: (before as NSString).length)) else { return nil }
        let start = match.range(at: 1).location - 1
        // Completing a handle in the middle replaces its remaining characters as well.
        let after = value.substring(from: selection.location)
        let tail = after.prefix { $0.isASCII && ($0.isLetter || $0.isNumber || "_.:/-".contains($0)) }
        return .init(query: (before as NSString).substring(with: match.range(at: 1)), range: NSRange(location: start, length: selection.location - start + tail.utf16.count))
    }
    static func candidates(_ roster: [Participant], query: String) -> [MentionCandidate] {
        let safe = try! NSRegularExpression(pattern: "^" + handlePattern + "$")
        func valid(_ value: String) -> Bool { safe.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil }
        let visible = roster.filter { $0.hiddenAt == nil && $0.activityState != "offline" && !$0.displayName.isEmpty && $0.displayName.lowercased() != "anonymous" }
        let duplicates = Dictionary(grouping: visible.filter { $0.kind == "agent" }, by: { $0.displayName.lowercased() })
        var result: [MentionCandidate] = []
        for person in visible.sorted(by: { a, b in
            if (a.kind == "agent") != (b.kind == "agent") { return a.kind == "agent" }
            return a.displayName.localizedStandardCompare(b.displayName) == .orderedAscending
        }) {
            let agent = person.kind == "agent"
            var handle = agent ? person.displayName : person.githubLogin ?? person.displayName
            if agent && (!valid(handle) || (duplicates[person.displayName.lowercased()]?.count ?? 0) > 1) {
                guard let key = person.agentKey else { continue }; handle = "agent:" + key
            }
            guard valid(handle), [person.displayName, person.ownerLabel ?? "", handle].contains(where: { $0.localizedCaseInsensitiveContains(query) || query.isEmpty }) else { continue }
            result.append(.init(id: person.id, name: person.displayName, handle: handle, detail: person.detail, isAgent: agent))
        }
        if "everyone".localizedCaseInsensitiveContains(query) || query.isEmpty { result.append(.init(id: "everyone", name: "Everyone", handle: "everyone", detail: "Everyone in this room")) }
        return Array(result.prefix(8))
    }
    static func inserting(_ candidate: MentionCandidate, into text: String, query: MentionQuery) -> (String, NSRange) {
        let suffix = (text as NSString).substring(from: NSMaxRange(query.range))
        let insert = "@\(candidate.handle)" + (suffix.first?.isWhitespace == true ? "" : " ")
        let updated = (text as NSString).replacingCharacters(in: query.range, with: insert)
        return (updated, NSRange(location: query.range.location + insert.utf16.count + (suffix.hasPrefix(" ") ? 1 : 0), length: 0))
    }
}

/// UITextView supplies a real selection/caret, multiline sizing, IME composition and native
/// text editing. Mention completion must replace the token at the caret, not the last word.
struct MessageEditor: UIViewRepresentable {
    @Binding var text: String
    @Binding var selection: NSRange
    @Binding var focused: Bool
    var editRevision = 0
    var identifier = "message-composer"
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 10, left: 0, bottom: 10, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.accessibilityIdentifier = identifier
        view.accessibilityLabel = "Message"
        view.tintColor = UIColor(Theme.accent)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        // Native input owns text and selection between explicit composer commands.
        // SwiftUI can deliver an older snapshot while UIKit is processing keystrokes.
        if view.markedTextRange == nil {
            if editRevision > (context.coordinator.appliedRevision ?? -1) {
                context.coordinator.updating = true
                context.coordinator.appliedRevision = editRevision
                let location = min(selection.location, (text as NSString).length)
                let desired = NSRange(location: location, length: min(selection.length, (text as NSString).length - location))
                if view.text != text { view.text = text }
                if view.selectedRange != desired { view.selectedRange = desired }
                context.coordinator.updating = false
            }
            context.coordinator.decorate(view)
        }
        if focused && !view.isFirstResponder { view.becomeFirstResponder() }
        else if !focused && view.isFirstResponder { view.resignFirstResponder() }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let height = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let maximum = UIFont.preferredFont(forTextStyle: .body).lineHeight * 5 + 20
        uiView.isScrollEnabled = height > maximum
        return CGSize(width: width, height: min(max(44, height), maximum))
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MessageEditor
        var updating = false
        var appliedRevision: Int?
        private var decoratedText: String?
        private var decoratedFont: UIFont?
        init(_ parent: MessageEditor) { self.parent = parent }
        func textViewDidChange(_ view: UITextView) {
            parent.text = view.text; parent.selection = view.selectedRange
            if !updating && view.markedTextRange == nil { decorate(view) }
        }
        func textViewDidChangeSelection(_ view: UITextView) {
            if !updating { parent.selection = view.selectedRange }
        }
        func textViewDidBeginEditing(_ view: UITextView) { if !updating { parent.focused = true } }
        func textViewDidEndEditing(_ view: UITextView) { if !updating { parent.focused = false } }
        func decorate(_ view: UITextView) {
            let selected = view.selectedRange
            let text = view.text ?? ""
            let font = UIFont.preferredFont(forTextStyle: .body)
            guard decoratedText != text || decoratedFont != font else { return }
            let wasUpdating = updating
            updating = true
            defer { updating = wasUpdating }
            decoratedText = text; decoratedFont = font
            let base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor(Theme.ink)]
            view.textStorage.beginEditing()
            view.textStorage.setAttributes(base, range: NSRange(location: 0, length: (text as NSString).length))
            let pattern = #"(?<![\w/@])@"# + Mentions.handlePattern
            if let regex = try? NSRegularExpression(pattern: pattern) {
                for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                    view.textStorage.addAttributes([.foregroundColor: UIColor(Theme.accent), .backgroundColor: UIColor(Theme.accent.opacity(0.10))], range: match.range)
                }
            }
            view.textStorage.endEditing(); view.typingAttributes = base
            if view.selectedRange != selected { view.selectedRange = selected }
        }
    }
}
