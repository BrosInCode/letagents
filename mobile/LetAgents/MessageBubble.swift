import SwiftUI

struct MessageBubble: View {
    let message: Message
    let mine: Bool
    var grouped = false
    var original = false
    var threadSummary: ThreadSummary? = nil
    let reply: () -> Void
    var openThread: (() -> Void)? = nil
    var jumpTo: ((String) -> Void)? = nil
    @State private var expanded = false
    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            if mine { Spacer(minLength: 30) }
            else if !original {
                if grouped { Color.clear.frame(width: 30) }
                else { AvatarView(name: message.author, size: 30).padding(.top, 2) }
            }
            VStack(alignment: mine ? .trailing : .leading, spacing: 7) {
                if !grouped && !original {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(mine ? "You" : message.author).font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
                        if let attribution = message.attribution {
                            Text(attribution).font(.caption2).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Menu {
                            Button(message.isThreadReply ? "Reply to message" : "Reply in thread", systemImage: "arrowshape.turn.up.left", action: reply)
                            Button("Copy message", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.body }
                        } label: { Image(systemName: "ellipsis").font(.caption).foregroundStyle(Theme.muted).frame(width: 30, height: 22) }
                        .accessibilityLabel("Message actions for \(message.author)").accessibilityIdentifier("actions-\(message.id)")
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    if original { Label("Original message · \(message.author)", systemImage: "text.bubble").font(.caption.weight(.semibold)).foregroundStyle(Theme.accent) }
                    if let quote = message.replyTo {
                        Button { jumpTo?(quote.id) } label: { QuotePreview(quote: quote) }.buttonStyle(.plain)
                            .accessibilityLabel("Quoted message from \(quote.author): \(quote.body)")
                    }
                    if message.body.count > 2400 && !expanded {
                        Text(String(message.body.prefix(400)) + "…").font(.body).lineSpacing(3)
                        Button("Read full message") { expanded = true }.font(.subheadline.weight(.semibold))
                    } else { RichMessage(message.body) }
                    if let attachments = message.attachments, !attachments.isEmpty {
                        ForEach(attachments) { attachment in
                            Label(attachment.filename, systemImage: "doc.text").font(.caption).foregroundStyle(Theme.muted)
                                .padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Theme.code, in: RoundedRectangle(cornerRadius: 8))
                        }
                        Text("Attachments are available on desktop.").font(.caption2).foregroundStyle(Theme.muted)
                    }
                    HStack(spacing: 4) {
                        Spacer()
                        if let date = message.date { Text(date, style: .time).font(.caption2).foregroundStyle(Theme.secondary) }
                        if mine { Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted).accessibilityLabel("Sent") }
                    }
                }.padding(13).frame(maxWidth: .infinity, alignment: .leading)
                    .background(mine ? Theme.outgoing : Theme.surface, in: RoundedRectangle(cornerRadius: 16))
                    .contextMenu {
                        Button(message.isThreadReply ? "Reply to message" : "Reply in thread", systemImage: "arrowshape.turn.up.left", action: reply)
                        Button("Copy message", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.body }
                    }
                    .accessibilityAction(named: Text("Reply to message"), reply)
                if let summary = threadSummary, summary.replyCount > 0, let openThread {
                    Button(action: openThread) { ThreadPreview(summary: summary) }.buttonStyle(.plain)
                        .accessibilityIdentifier("thread-\(message.id)")
                }
            }
            if !mine && !original { Spacer(minLength: 2) }
        }
    }
}
struct QuotePreview: View {
    let quote: ReplyPreview
    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            RoundedRectangle(cornerRadius: 2).fill(Theme.accent).frame(width: 3)
            VStack(alignment: .leading, spacing: 3) {
                Text(quote.author).font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
                Text(quote.body).font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.fixedSize(horizontal: false, vertical: true).padding(9).background(Theme.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }
}
struct ThreadPreview: View {
    let summary: ThreadSummary
    var body: some View {
        HStack(spacing: 9) {
            HStack(spacing: -8) {
                ForEach(Array((summary.participants ?? []).prefix(3).enumerated()), id: \.offset) { _, person in
                    AvatarView(name: person.sender.components(separatedBy: " | ")[0], size: 25)
                        .overlay(Circle().stroke(Theme.background, lineWidth: 2))
                }
                if (summary.participants ?? []).isEmpty { Image(systemName: "bubble.left.and.bubble.right").font(.subheadline).foregroundStyle(Theme.accent) }
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text("\(summary.replyCount) \(summary.replyCount == 1 ? "reply" : "replies")").font(.caption.weight(.semibold))
                    if summary.unread {
                        Circle().fill(Theme.accent).frame(width: 5, height: 5)
                        Text((summary.unreadCount ?? 0) > 0 ? "\(summary.unreadCount!) new" : "New").font(.caption2.weight(.medium))
                    }
                }.foregroundStyle(Theme.accent)
                if let latest = summary.latestReply {
                    Text("\(latest.author): \(latest.body)").font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Theme.secondary)
        }.padding(11).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .combine)
    }
}
