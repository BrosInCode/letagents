import SwiftUI
import SafariServices

struct WelcomeView: View {
    @Bindable var session: SessionStore
    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 14) {
                        BrandMark().frame(width: 38, height: 38)
                        Text("LetAgents").font(.title2.weight(.semibold))
                    }.padding(.top, 24)
                    VStack(alignment: .leading, spacing: 20) {
                        Text("Your agents.\nIn your pocket.").font(.system(.largeTitle, design: .default, weight: .semibold)).tracking(-1)
                        Text("Pick up the conversation.\nWherever you are.").font(.title3).foregroundStyle(Theme.muted).lineSpacing(5)
                    }.padding(.top, 64)
                    VStack(alignment: .leading, spacing: 24) {
                        HStack {
                            Text("LETAGENTS / MOBILE").font(.caption2.weight(.semibold)).tracking(1)
                            Spacer()
                            Circle().fill(Theme.green).frame(width: 7, height: 7)
                        }.foregroundStyle(Theme.muted)
                        HStack(alignment: .top, spacing: 12) {
                            AvatarView(name: "Codex")
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Codex").font(.subheadline.weight(.semibold))
                                Text("The latest changes are ready.\nWant me to keep going?").font(.body).lineSpacing(4)
                            }
                        }
                    }.padding(20).background(Theme.surface, in: RoundedRectangle(cornerRadius: 24))
                        .overlay(RoundedRectangle(cornerRadius: 24).stroke(Theme.line, lineWidth: 1))
                        .padding(.top, 44)
                    Spacer(minLength: 48)
                    if let error = session.error { ErrorNotice(message: error).padding(.bottom, 16) }
                    Button { Task { await session.startSignIn() } } label: {
                        HStack { if session.isStartingSignIn { ProgressView().tint(.black) }; Text("Continue with GitHub") }
                    }.buttonStyle(PrimaryButtonStyle()).disabled(session.isStartingSignIn).accessibilityIdentifier("github-sign-in")
                    Text("Your projects. Your rooms. Same conversation.").font(.footnote).foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity).multilineTextAlignment(.center).padding(.top, 22).padding(.bottom, 28)
                }.padding(.horizontal, 24).frame(minHeight: geometry.size.height)
            }.scrollBounceBehavior(.basedOnSize)
        }.sheet(isPresented: Binding(get: { session.authorization != nil }, set: { if !$0 { session.cancelSignIn() } })) {
            DeviceSignInView(session: session)
        }
    }
}

struct DeviceSignInView: View {
    @Bindable var session: SessionStore
    @State private var showBrowser = false
    @State private var copied = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    BrandMark().frame(width: 46, height: 46).padding(.top, 26)
                    VStack(alignment: .leading, spacing: 16) {
                        Text("One quick connection.").font(.title.weight(.semibold))
                        Text("Copy this code, then enter it on GitHub. Come back here when you’re done.").foregroundStyle(Theme.muted)
                    }.padding(.top, 20)
                    if let authorization = session.authorization {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("YOUR ONE-TIME CODE").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                            HStack {
                                Text(authorization.userCode).font(.title.monospaced().weight(.semibold)).textSelection(.enabled).minimumScaleFactor(0.7)
                                    .accessibilityIdentifier("device-code")
                                Spacer()
                                Button(copied ? "Copied" : "Copy") {
                                    UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: authorization.userCode]], options: [.localOnly: true, .expirationDate: session.authorizationDeadline ?? Date().addingTimeInterval(900)])
                                    copied = true
                                }.font(.subheadline.weight(.semibold)).frame(minWidth: 44, minHeight: 44)
                            }
                        }.padding(20).background(Theme.surface, in: RoundedRectangle(cornerRadius: 22))
                        Button("Open GitHub") { showBrowser = true }.buttonStyle(PrimaryButtonStyle())
                        if let error = session.error {
                            ErrorNotice(message: error)
                            Button("Start again") { Task { await session.startSignIn() } }.disabled(session.isStartingSignIn)
                        } else {
                            HStack(spacing: 12) { ProgressView(); Text("Waiting for GitHub authorization…").font(.subheadline).foregroundStyle(Theme.muted) }
                            if let deadline = session.authorizationDeadline {
                                HStack { Text("Code expires in"); Text(timerInterval: Date()...max(Date(), deadline), countsDown: true).monospacedDigit() }
                                    .font(.caption).foregroundStyle(Theme.muted)
                            }
                        }
                    }
                }.padding(24)
            }.background(Theme.background).navigationTitle("Sign in").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { session.cancelSignIn() } } }
                .sheet(isPresented: $showBrowser) {
                    if let url = session.authorization?.verificationURL { GitHubBrowser(url: url).ignoresSafeArea() }
                }
                .task(id: session.authorization?.requestId) { await session.waitForAuthorization() }
        }
    }
}
private struct GitHubBrowser: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) { }
}
