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
                        Menu { messageActions } label: { Image(systemName: "ellipsis").font(.caption).foregroundStyle(Theme.muted).frame(width: 44, height: 44).contentShape(Rectangle()) }
                        .accessibilityLabel("Message actions for \(message.author)").accessibilityIdentifier("actions-\(message.id)")
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    if original { Label("Original message · \(message.author)", systemImage: "text.bubble").font(.caption.weight(.semibold)).foregroundStyle(Theme.accent) }
                    if let quote = message.replyTo {
                        Button { jumpTo?(quote.id) } label: { QuotePreview(quote: quote) }.buttonStyle(.plain)
                            .accessibilityLabel("Quoted message from \(quote.author): \(quote.body)")
                            .accessibilityHint("Read the original message")
                            .accessibilityIdentifier("quote-\(message.id)")
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
                    .contextMenu { messageActions }
                    .accessibilityAction(named: Text("Quote reply"), reply)
                if let summary = threadSummary, summary.replyCount > 0, let openThread {
                    Button(action: openThread) { ThreadPreview(summary: summary) }.buttonStyle(.plain)
                        .accessibilityIdentifier("thread-\(message.id)")
                }
            }
            if !mine && !original { Spacer(minLength: 2) }
        }.modifier(SwipeToReply(reply: reply))
    }
    @ViewBuilder private var messageActions: some View {
        Button("Quote reply", systemImage: "arrowshape.turn.up.left", action: reply)
        if let openThread { Button("Reply in thread", systemImage: "bubble.left.and.bubble.right", action: openThread) }
        Button("Copy message", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.body }
    }
}
struct QuotePreview: View {
    let quote: ReplyPreview
    var composing = false
    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            RoundedRectangle(cornerRadius: 2).fill(Theme.accent).frame(width: 3)
            VStack(alignment: .leading, spacing: 3) {
                Text(composing ? "Replying to \(quote.author)" : quote.author).font(.caption.weight(.semibold)).foregroundStyle(Theme.accent)
                Text(quote.body).font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.fixedSize(horizontal: false, vertical: true).padding(9).background(Theme.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }
}

// Directional UIKit recognition leaves vertical scrolling, text selection, and
// nested horizontal code scrolling with their existing recognizers on iOS 17+.
struct SwipeToReply: ViewModifier {
    let reply: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var distance: CGFloat = 0
    func body(content: Content) -> some View {
        content.offset(x: reduceMotion ? 0 : distance)
            .background(alignment: .leading) {
                Image(systemName: "arrowshape.turn.up.left.fill").foregroundStyle(Theme.accent)
                    .frame(width: 34, height: 34).background(Theme.surface, in: Circle())
                    .opacity(min(distance / 64, 1)).accessibilityHidden(true)
            }
            .background(ReplyPan(changed: { distance = $0 }, ended: { committed in
                withAnimation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.85)) { distance = 0 }
                if committed { reply() }
            }))
    }
}
private struct ReplyPan: UIViewRepresentable {
    var changed: (CGFloat) -> Void
    var ended: (Bool) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> Marker {
        let view = Marker(); view.isUserInteractionEnabled = false
        view.attach = { [weak coordinator = context.coordinator] marker in coordinator?.attach(marker) }
        return view
    }
    func updateUIView(_ uiView: Marker, context: Context) { context.coordinator.parent = self }
    static func dismantleUIView(_ uiView: Marker, coordinator: Coordinator) { coordinator.pan.view?.removeGestureRecognizer(coordinator.pan) }
    final class Marker: UIView {
        var attach: ((UIView) -> Void)?
        override func didMoveToWindow() { super.didMoveToWindow(); attach?(self) }
        override func layoutSubviews() { super.layoutSubviews(); attach?(self) }
    }
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: ReplyPan
        weak var marker: UIView?
        private var crossedThreshold = false
        private let feedback = UISelectionFeedbackGenerator()
        lazy var pan: UIPanGestureRecognizer = {
            let pan = UIPanGestureRecognizer(target: self, action: #selector(moved))
            pan.delegate = self; pan.maximumNumberOfTouches = 1; pan.cancelsTouchesInView = false
            return pan
        }()
        init(_ parent: ReplyPan) { self.parent = parent }
        func attach(_ marker: UIView) {
            self.marker = marker
            guard marker.window != nil else { pan.view?.removeGestureRecognizer(pan); return }
            var ancestor = marker.superview
            while let view = ancestor {
                if let scroll = view as? UIScrollView {
                    if pan.view !== scroll { pan.view?.removeGestureRecognizer(pan); scroll.addGestureRecognizer(pan) }
                    return
                }
                ancestor = view.superview
            }
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard let marker, marker.bounds.contains(touch.location(in: marker)),
                  touch.location(in: marker.window).x > 24 else { return false }
            var touched = touch.view
            while let view = touched, view !== pan.view {
                if let scroll = view as? UIScrollView,
                   scroll.alwaysBounceHorizontal || scroll.contentSize.width > scroll.bounds.width + 1 { return false }
                touched = view.superview
            }
            return true
        }
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            let velocity = pan.velocity(in: pan.view)
            return velocity.x > abs(velocity.y) * 1.5
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            other === (pan.view as? UIScrollView)?.panGestureRecognizer
        }
        @objc private func moved() {
            let translation = max(0, pan.translation(in: pan.view).x)
            switch pan.state {
            case .began, .changed:
                parent.changed(min(translation, 80) + max(0, translation - 80) * 0.12)
                if translation >= 64 && !crossedThreshold { feedback.selectionChanged(); crossedThreshold = true }
            case .ended, .cancelled, .failed:
                parent.ended(pan.state == .ended && translation >= 64); crossedThreshold = false
            default: break
            }
        }
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
