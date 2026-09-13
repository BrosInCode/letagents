import SwiftUI

// Mobile · companion in Figma. System text styles retain Dynamic Type on iPhone.
enum Theme {
    // Figma: Welcome / Soft tangerine (21:652), Onboarding / First room (22:1151),
    // Inbox / Conversation preview (41:6473). Dark values are sampled source colors.
    static let background = color(light: 0xFAF7F2, dark: 0x1C1B1A)
    static let surface = color(light: 0xFFFFFF, dark: 0x252422)
    static let line = color(light: 0xE2DBD2, dark: 0x3A3835)
    static let ink = color(light: 0x34251B, dark: 0xF3F0EA)
    static let muted = color(light: 0x736B63, dark: 0xB5B0A8)
    static let secondary = color(light: 0x857E75, dark: 0x8F8A83)
    static let accent = color(light: 0x80512A, dark: 0xDFB895)
    static let button = Color(red: 223 / 255, green: 184 / 255, blue: 149 / 255)
    static let green = color(light: 0x356A46, dark: 0xACCBB2)
    static let outgoing = color(light: 0xF0E2D4, dark: 0x39312A)
    static let code = color(light: 0xF4EFE8, dark: 0x22211F)
    static let violet = color(light: 0x80512A, dark: 0xDFB895)
    static let danger = color(light: 0xA04D3A, dark: 0xDFB895)
    static let blue = color(light: 0x45617C, dark: 0xAEC6DF)
    private static func color(light: UInt, dark: UInt) -> Color {
        Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255) / 255,
                           green: CGFloat((value >> 8) & 255) / 255,
                           blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.headline).frame(maxWidth: .infinity).padding(.vertical, 18)
            .foregroundStyle(Color(red: 52 / 255, green: 37 / 255, blue: 27 / 255))
            .background(Theme.button.opacity(configuration.isPressed ? 0.8 : 1), in: RoundedRectangle(cornerRadius: 18))
    }
}
struct AvatarView: View {
    let name: String
    var size: CGFloat = 36
    var url: String? = nil
    private var tint: Color { Theme.accent }
    var body: some View {
        ZStack {
            Circle().fill(tint.opacity(0.14))
            Text(name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased())
                .font(.system(size: size * 0.34, weight: .semibold)).foregroundStyle(tint)
            if let url, let imageURL = URL(string: url), imageURL.scheme == "https" {
                AsyncImage(url: imageURL) { image in image.resizable().scaledToFill() } placeholder: { Color.clear }
            }
        }.frame(width: size, height: size).clipShape(Circle()).accessibilityHidden(true)
    }
}
struct BrandMark: View {
    var body: some View {
        GeometryReader { geometry in
            let s = min(geometry.size.width, geometry.size.height) / 144
            Path { p in
                p.move(to: CGPoint(x: 35 * s, y: 8 * s)); p.addLine(to: CGPoint(x: 93 * s, y: 8 * s))
                p.addQuadCurve(to: CGPoint(x: 128 * s, y: 43 * s), control: CGPoint(x: 128 * s, y: 8 * s))
                p.addLine(to: CGPoint(x: 128 * s, y: 55 * s))
                p.move(to: CGPoint(x: 128 * s, y: 89 * s)); p.addLine(to: CGPoint(x: 128 * s, y: 101 * s))
                p.addQuadCurve(to: CGPoint(x: 93 * s, y: 136 * s), control: CGPoint(x: 128 * s, y: 136 * s))
                p.addLine(to: CGPoint(x: 35 * s, y: 136 * s))
                p.addQuadCurve(to: CGPoint(x: 0, y: 101 * s), control: CGPoint(x: 0, y: 136 * s))
                p.addLine(to: CGPoint(x: 0, y: 43 * s))
                p.addQuadCurve(to: CGPoint(x: 35 * s, y: 8 * s), control: CGPoint(x: 0, y: 8 * s))
                p.move(to: CGPoint(x: 34 * s, y: 103 * s)); p.addLine(to: CGPoint(x: 64 * s, y: 35 * s))
                p.addLine(to: CGPoint(x: 94 * s, y: 103 * s))
                p.move(to: CGPoint(x: 46 * s, y: 76 * s)); p.addLine(to: CGPoint(x: 82 * s, y: 76 * s))
            }.stroke(Theme.ink, style: StrokeStyle(lineWidth: 9 * s, lineCap: .round, lineJoin: .round))
            Circle().fill(Theme.accent).frame(width: 16 * s, height: 16 * s).position(x: 128 * s, y: 72 * s)
        }.accessibilityHidden(true)
    }
}
struct ErrorNotice: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.footnote).foregroundStyle(Theme.accent).frame(maxWidth: .infinity, alignment: .leading)
            .padding(14).background(Theme.surface, in: RoundedRectangle(cornerRadius: 14))
            .accessibilityIdentifier("error-notice")
    }
}
