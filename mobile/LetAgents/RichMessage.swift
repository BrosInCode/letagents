import SwiftUI

/// Block layout is native SwiftUI. Foundation handles inline Markdown so selection and links
/// remain accessible, without HTML or an embedded web view in a scrolling conversation.
enum MarkdownBlock: Equatable {
    case paragraph(String), heading(Int, String), code(String, String), quote(String)
    case item(String, String, Int, Bool?), rule, table([[String]])
}
enum MessageMarkdown {
    static func blocks(_ source: String) -> [MarkdownBlock] {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var result: [MarkdownBlock] = [], paragraph: [String] = []
        var index = 0
        func flush() { if !paragraph.isEmpty { result.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] } }
        while index < lines.count {
            let line = lines[index], trimmed = line.trimmingCharacters(in: .whitespaces)
            if let fence = captures(#"^\s*(`{3,}|~{3,})(.*)$"#, line) {
                flush(); let marker = fence[0], language = fence[1].trimmingCharacters(in: .whitespaces)
                index += 1; var code: [String] = []
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    if candidate.count >= marker.count && candidate.allSatisfy({ $0 == marker.first! }) { break }
                    code.append(lines[index]); index += 1
                }
                result.append(.code(language, code.joined(separator: "\n")))
            } else if trimmed.isEmpty { flush() }
            else if let h = captures(#"^(#{1,6})\s+(.+?)(?:\s+#+)?$"#, trimmed) { flush(); result.append(.heading(h[0].count, h[1])) }
            else if captures(#"^(?:\*\s*){3,}$|^(?:-\s*){3,}$|^(?:_\s*){3,}$"#, trimmed) != nil { flush(); result.append(.rule) }
            else if index + 1 < lines.count && line.contains("|") && isTableDivider(lines[index + 1]) {
                flush(); var rows = [cells(line)]; index += 2
                while index < lines.count && lines[index].contains("|") && !lines[index].isEmpty { rows.append(cells(lines[index])); index += 1 }
                result.append(.table(rows)); continue
            } else if trimmed.hasPrefix(">") {
                flush(); var quote: [String] = []
                while index < lines.count && lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                    var text = lines[index].trimmingCharacters(in: .whitespaces); text.removeFirst()
                    if text.hasPrefix(" ") { text.removeFirst() }; quote.append(text); index += 1
                }
                result.append(.quote(quote.joined(separator: "\n"))); continue
            } else if let list = captures(#"^(\s*)([-+*]|\d+[.)])\s+(.*)$"#, line) {
                flush(); let depth = min(list[0].replacingOccurrences(of: "\t", with: "    ").count / 2, 6)
                if let task = captures(#"^\[([ xX])\]\s+(.*)$"#, list[2]) { result.append(.item("", task[1], depth, task[0] != " ")) }
                else { result.append(.item(list[1].count == 1 ? "•" : list[1], list[2], depth, nil)) }
            } else { paragraph.append(line) }
            index += 1
        }
        flush(); return result
    }
    static func captures(_ pattern: String, _ text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern), let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (1..<match.numberOfRanges).map { i in Range(match.range(at: i), in: text).map { String(text[$0]) } ?? "" }
    }
    static func cells(_ line: String) -> [String] {
        var value = line.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }; if value.hasSuffix("|") { value.removeLast() }
        var cells: [String] = [], current = "", escaped = false, code = false
        for char in value {
            if escaped { current.append(char); escaped = false; continue }
            if char == "\\" { escaped = true; continue }
            if char == "`" { code.toggle() }
            if char == "|" && !code { cells.append(current.trimmingCharacters(in: .whitespaces)); current = "" } else { current.append(char) }
        }
        cells.append(current.trimmingCharacters(in: .whitespaces)); return cells
    }
    private static func isTableDivider(_ line: String) -> Bool {
        line.contains("|") && cells(line).allSatisfy { captures(#"^:?-{3,}:?$"#, $0) != nil }
    }
    static func inline(_ source: String) -> AttributedString {
        var value = (try? AttributedString(markdown: source, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(source)
        // Links cannot launch arbitrary app schemes supplied by a message.
        for run in value.runs {
            if let url = run.link, !["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { value[run.range].link = nil }
            if run.inlinePresentationIntent?.contains(.code) == true {
                value[run.range].font = .system(.callout, design: .monospaced)
                value[run.range].backgroundColor = Theme.code
                value[run.range].foregroundColor = Theme.accent
            }
        }
        let plain = String(value.characters)
        let regex = try! NSRegularExpression(pattern: #"(?<![\w/@])@[A-Za-z0-9][A-Za-z0-9_.:-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)*"#)
        for match in regex.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
            guard let stringRange = Range(match.range, in: plain), let range = Range(stringRange, in: value) else { continue }
            let slice = value[range]
            guard !slice.runs.contains(where: { $0.link != nil || $0.inlinePresentationIntent?.contains(.code) == true }) else { continue }
            value[range].foregroundColor = Theme.accent
            value[range].backgroundColor = Theme.accent.opacity(0.12)
            value[range].font = .body.weight(.semibold)
            var url = URLComponents(); url.scheme = "letagents"; url.host = "mention"; url.path = "/" + String(plain[stringRange].dropFirst())
            value[range].link = url.url
        }
        return value
    }
}

struct RichMessage: View {
    let blocks: [MarkdownBlock]
    init(_ text: String) { blocks = MessageMarkdown.blocks(text) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let text): inline(text).lineSpacing(3)
                case .heading(let level, let text): inline(text).font(level <= 2 ? .title3.weight(.semibold) : .headline).padding(.top, 3)
                case .code(let language, let code): CodeBlockView(language: language, code: code)
                case .quote(let text): HStack(alignment: .top, spacing: 10) {
                    RoundedRectangle(cornerRadius: 2).fill(Theme.accent.opacity(0.65)).frame(width: 3)
                    RichMessage(text).foregroundStyle(Theme.muted)
                }.fixedSize(horizontal: false, vertical: true).padding(.vertical, 3)
                case .item(let marker, let text, let depth, let checked):
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let checked { Image(systemName: checked ? "checkmark.square.fill" : "square").foregroundStyle(checked ? Theme.accent : Theme.muted).accessibilityLabel(checked ? "Completed" : "Not completed") }
                        else { Text(marker).foregroundStyle(Theme.muted).frame(minWidth: 12, alignment: .trailing) }
                        inline(text)
                    }.padding(.leading, CGFloat(depth) * 12)
                case .rule: Divider().overlay(Theme.line).padding(.vertical, 4)
                case .table(let rows): table(rows)
                }
            }
        }.font(.body).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func inline(_ text: String) -> some View { Text(MessageMarkdown.inline(text)).textSelection(.enabled).tint(Theme.accent).fixedSize(horizontal: false, vertical: true) }
    private func table(_ rows: [[String]]) -> some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    GridRow {
                        ForEach(0..<(rows.map(\.count).max() ?? 0), id: \.self) { column in
                            inline(column < row.count ? row[column] : "").font(.callout.weight(index == 0 ? .semibold : .regular))
                                .frame(minWidth: 90, maxWidth: 220, alignment: .leading).padding(10)
                                .background(index == 0 ? Theme.accent.opacity(0.08) : Color.clear)
                                .overlay(alignment: .bottom) { Divider() }
                        }
                    }
                }
            }
        }.background(Theme.code, in: RoundedRectangle(cornerRadius: 10)).accessibilityIdentifier("markdown-table")
    }
}

struct CodeBlockView: View {
    let language: String
    let code: String
    @State private var copied = false
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "Code" : language.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                Spacer()
                Button { expanded = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 32, height: 32) }.accessibilityLabel("Expand code")
                Button { UIPasteboard.general.string = code; copied = true } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc").font(.caption).frame(minHeight: 32)
                }.accessibilityLabel("Copy code")
            }.padding(.horizontal, 12).padding(.top, 3)
            ScrollView(.horizontal) {
                Text(highlighted).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false).padding(12)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.background(Theme.code, in: RoundedRectangle(cornerRadius: 12)).accessibilityIdentifier("code-block")
            .sheet(isPresented: $expanded) {
                NavigationStack {
                    ScrollView([.horizontal, .vertical]) { Text(highlighted).font(.system(.body, design: .monospaced)).textSelection(.enabled).padding(20) }
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).background(Theme.code)
                        .navigationTitle(language.isEmpty ? "Code" : language).navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { expanded = false } }.companionToolbarStyle() }
                }
            }
            .task(id: copied) { if copied { try? await Task.sleep(for: .seconds(2)); copied = false } }
    }
    private var highlighted: AttributedString {
        var value = AttributedString(code)
        // Deliberately lexical: comments/strings are a single token and never recolored as keywords.
        let pattern = #"//[^\n]*|/\*[\s\S]*?\*/|#[^\n]*|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|\b(?:let|var|const|func|function|async|await|return|if|else|guard|import|from|class|struct|enum|def|for|while|try|catch|throw|throws|true|false|null|nil|public|private|export|type|interface)\b|\b\d+(?:\.\d+)?\b"#
        guard code.count < 40_000, let regex = try? NSRegularExpression(pattern: pattern) else { return value }
        for match in regex.matches(in: code, range: NSRange(code.startIndex..., in: code)) {
            guard let r = Range(match.range, in: code), let range = Range(r, in: value) else { continue }
            let token = code[r]
            let color: Color = token.hasPrefix("//") || token.hasPrefix("/*") || token.hasPrefix("#") ? Theme.muted : token.hasPrefix("\"") || token.hasPrefix("'") ? Theme.accent : token.first?.isNumber == true ? Theme.blue : Theme.violet
            value[range].foregroundColor = color
        }
        return value
    }
}
