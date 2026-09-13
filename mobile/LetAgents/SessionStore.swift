import Foundation
import Observation
import Security

protocol CredentialStore {
    func read() throws -> String?
    func write(_ token: String) throws
    func remove() throws
}

struct KeychainCredentialStore: CredentialStore {
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "chat.letagents.mobile",
         kSecAttrAccount as String: "owner-token"]
    }
    func read() throws -> String? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data, let token = String(data: data, encoding: .utf8) else { throw failure(status) }
        return token
    }
    func write(_ token: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8),
                                       kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecItemNotFound {
            let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard status == errSecSuccess else { throw failure(status) }
        } else if update != errSecSuccess { throw failure(update) }
    }
    func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw failure(status) }
    }
    private func failure(_ status: OSStatus) -> APIError {
        APIError(status: Int(status), message: "Your session couldn’t be stored securely. Please try again.")
    }
}

@MainActor @Observable final class SessionStore {
    let client: APIClient
    private let credentials: any CredentialStore
    private(set) var token: String?
    private(set) var account: Account?
    private(set) var isRestoring = true
    private(set) var isStartingSignIn = false
    var authorization: DeviceAuthorization?
    var authorizationDeadline: Date?
    var error: String?
    var restoreFailed = false
    @ObservationIgnored var drafts: [String: String] = [:]
    @ObservationIgnored var submissions: [String: (text: String, id: String)] = [:]

    init(client: APIClient = APIClient(), credentials: any CredentialStore = KeychainCredentialStore()) {
        self.client = client
        self.credentials = credentials
    }
    func restore() async {
        isRestoring = true
        restoreFailed = false
        error = nil
        defer { isRestoring = false }
        do {
            guard let saved = try credentials.read() else { return }
            let result = try await client.account(token: saved)
            try Task.checkCancellation()
            guard result.authenticated, let account = result.account else {
                try credentials.remove()
                return
            }
            token = saved
            self.account = account
        } catch is CancellationError { }
        catch {
            if (error as? APIError)?.isUnauthorized == true {
                try? credentials.remove()
            } else {
                restoreFailed = true
                self.error = error.localizedDescription
            }
        }
    }
    func startSignIn() async {
        guard !isStartingSignIn else { return }
        error = nil
        isStartingSignIn = true
        defer { isStartingSignIn = false }
        do {
            let result = try await client.startAuthorization()
            try Task.checkCancellation()
            guard result.verificationURL != nil else { throw APIError(status: 0, message: "GitHub returned an invalid authorization link. Please try again.") }
            authorizationDeadline = Date().addingTimeInterval(TimeInterval(result.expiresIn))
            authorization = result
        } catch is CancellationError { }
        catch { self.error = error.localizedDescription }
    }
    func waitForAuthorization() async {
        guard let pending = authorization, let deadline = authorizationDeadline else { return }
        var interval = max(pending.interval, 1)
        do {
            while !Task.isCancelled && authorization?.requestId == pending.requestId {
                guard Date() < deadline else { throw APIError(status: 410, message: "This sign-in code has expired. Start again for a new code.") }
                try await Task.sleep(for: .seconds(interval))
                do {
                    let result = try await client.pollAuthorization(pending.requestId)
                    try Task.checkCancellation()
                    guard authorization?.requestId == pending.requestId else { return }
                    switch result.status {
                    case "authorized":
                        guard let token = result.letagentsToken, !token.isEmpty, let account = result.account else {
                            throw APIError(status: 0, message: "GitHub sign-in did not return a complete session. Please try again.")
                        }
                        try credentials.write(token)
                        self.token = token
                        self.account = account
                        authorization = nil
                        error = nil
                        return
                    case "pending": interval = max(result.interval ?? interval, 1)
                    case "slow_down": interval = max(result.interval ?? interval + 5, interval + 5)
                    case "denied": throw APIError(status: 403, message: "GitHub sign-in was declined. You can try again.")
                    case "expired": throw APIError(status: 410, message: "This sign-in code has expired. Start again for a new code.")
                    default: throw APIError(status: 0, message: "Unexpected sign-in response. Please start again.")
                    }
                } catch let error as APIError where error.status == 429 {
                    interval = max(error.interval ?? interval + 5, interval + 1)
                }
            }
        } catch is CancellationError { }
        catch let error as URLError where error.code == .cancelled { }
        catch { self.error = error.localizedDescription }
    }
    func cancelSignIn() {
        authorization = nil
        authorizationDeadline = nil
        error = nil
    }
    func signOut() async {
        let signingOutToken = token
        error = nil
        do {
            if let token {
                do { try await client.logout(token: token) }
                catch let error as APIError where error.isUnauthorized { /* Already revoked. */ }
            }
            guard token == signingOutToken else { return }
            try credentials.remove()
            drafts.removeAll()
            submissions.removeAll()
            account = nil
            token = nil
        } catch { self.error = error.localizedDescription }
    }
    func handleUnauthorized(_ error: Error, token requestToken: String) {
        guard token == requestToken, (error as? APIError)?.isUnauthorized == true else { return }
        try? credentials.remove()
        drafts.removeAll()
        submissions.removeAll()
        account = nil
        token = nil
        self.error = error.localizedDescription
    }
}
