import Foundation

struct APIError: LocalizedError, Sendable {
    let status: Int
    let message: String
    var interval: Int? = nil
    var errorDescription: String? { message }
    var isUnauthorized: Bool { status == 401 }
}

private struct APIErrorBody: Decodable { let error: String?; let status: String?; let interval: Int? }

struct APIClient: Sendable {
    static let productionURL = URL(string: "https://letagents.chat")!
    let baseURL: URL
    let session: URLSession
    init(baseURL: URL = Self.productionURL, session: URLSession? = nil) {
        self.baseURL = baseURL
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 40
        configuration.timeoutIntervalForResource = 45
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        self.session = session ?? URLSession(configuration: configuration)
    }

    func request<T: Decodable>(path: [String], token: String? = nil, method: String = "GET",
                               query: [URLQueryItem] = [], body: Data? = nil) async throws -> T {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        components.percentEncodedPath = "/" + path.map { $0.addingPercentEncoding(withAllowedCharacters: safe)! }.joined(separator: "/")
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Existing companion/human contract. This prevents owner tokens being treated as workers.
        request.setValue("1", forHTTPHeaderField: "X-LetAgents-Desktop-Client")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw APIError(status: 0, message: "The server returned an invalid response.") }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard (200..<300).contains(response.statusCode) else {
            let detail = try? decoder.decode(APIErrorBody.self, from: data)
            let message: String
            switch response.statusCode {
            case 401: message = "Your session has expired. Sign in again to continue."
            case 403: message = detail?.status == "denied" ? "GitHub sign-in was declined. You can try again." : "You no longer have access to this room."
            case 404: message = "This room or sign-in request is no longer available."
            case 410: message = "This sign-in code has expired. Start again for a new code."
            case 429: message = "Too many requests. Please try again in a moment."
            default: message = "LetAgents couldn’t complete the request. Please try again."
            }
            throw APIError(status: response.statusCode, message: message, interval: detail?.interval)
        }
        return try decoder.decode(T.self, from: data)
    }

    func startAuthorization() async throws -> DeviceAuthorization {
        try await request(path: ["auth", "device", "start"], method: "POST", body: Data("{}".utf8))
    }
    func pollAuthorization(_ id: String) async throws -> DevicePoll {
        try await request(path: ["auth", "device", "poll", id])
    }
    func account(token: String) async throws -> SessionResponse {
        try await request(path: ["auth", "session"], token: token)
    }
    func rooms(token: String) async throws -> [Room] {
        let result: RoomsResponse = try await request(path: ["account", "rooms"], token: token, query: [.init(name: "limit", value: "100")])
        return result.rooms
    }
    func messages(roomID: String, token: String, before: String = "latest") async throws -> MessagesResponse {
        try await request(path: ["rooms", roomID, "messages"], token: token,
                          query: [.init(name: "before", value: before), .init(name: "limit", value: "100")])
    }
    func poll(roomID: String, token: String, after: String?) async throws -> MessagesResponse {
        var query = [URLQueryItem(name: "timeout", value: "25000"), .init(name: "limit", value: "100")]
        if let after { query.append(.init(name: "after", value: after)) }
        return try await request(path: ["rooms", roomID, "messages", "poll"], token: token, query: query)
    }
    func thread(roomID: String, rootID: String, token: String, before: String? = nil) async throws -> ThreadResponse {
        var query = [URLQueryItem(name: "limit", value: "100")]
        if let before { query.append(.init(name: "before", value: before)) }
        return try await request(path: ["rooms", roomID, "messages", rootID, "thread"], token: token, query: query)
    }
    func participants(roomID: String, token: String) async throws -> [Participant] {
        let response: ParticipantsResponse = try await request(path: ["rooms", roomID, "participants"], token: token)
        return response.participants
    }
    func message(roomID: String, messageID: String, token: String) async throws -> Message {
        struct Response: Decodable { let message: Message }
        let response: Response = try await request(path: ["rooms", roomID, "messages", messageID], token: token)
        return response.message
    }
    func threads(roomID: String, token: String, unreadOnly: Bool = false, before: String? = nil) async throws -> ThreadsResponse {
        var query = [URLQueryItem(name: "limit", value: "50"), .init(name: "filter", value: unreadOnly ? "unread" : "all")]
        if let before { query.append(.init(name: "before", value: before)) }
        return try await request(path: ["rooms", roomID, "messages", "threads"], token: token, query: query)
    }
    func markThreadRead(roomID: String, rootID: String, messageID: String, token: String) async throws -> ThreadSummary {
        struct Response: Decodable { let thread: ThreadSummary }
        let body = try JSONSerialization.data(withJSONObject: ["message_id": messageID])
        let result: Response = try await request(path: ["rooms", roomID, "messages", rootID, "thread", "read"], token: token, method: "PUT", body: body)
        return result.thread
    }
    func send(roomID: String, token: String, message: SendMessageBody) async throws -> Message {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return try await request(path: ["rooms", roomID, "messages"], token: token, method: "POST", body: encoder.encode(message))
    }
    func logout(token: String) async throws {
        struct Result: Decodable { let success: Bool }
        let _: Result = try await request(path: ["auth", "logout"], token: token, method: "POST", body: Data("{}".utf8))
    }
}
