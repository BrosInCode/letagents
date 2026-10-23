import SwiftUI
import UniformTypeIdentifiers
import PhotosUI
import QuickLook
import ImageIO

struct DraftAttachment: Identifiable, Equatable, Sendable {
    static let maximumCount = 4
    static let maximumBytes = 25 * 1024 * 1024
    let id: UUID
    let filename: String
    let contentType: String
    let data: Data

    init(filename: String, contentType: String, data: Data) throws {
        guard !data.isEmpty else { throw APIError(status: 0, message: "This file is empty.") }
        guard data.count <= Self.maximumBytes else { throw APIError(status: 0, message: "Choose files smaller than 25 MB each.") }
        id = UUID(); self.filename = filename; self.contentType = contentType; self.data = data
    }
    static func read(_ url: URL) throws -> Self {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .contentTypeKey])
        guard values.isRegularFile == true else { throw APIError(status: 0, message: "Choose a file rather than a folder.") }
        guard (values.fileSize ?? Int.max) <= maximumBytes else { throw APIError(status: 0, message: "Choose files smaller than 25 MB each.") }
        return try Self(filename: url.lastPathComponent, contentType: values.contentType?.preferredMIMEType ?? "application/octet-stream", data: Data(contentsOf: url))
    }
}
struct ImportedPhoto: Transferable, Sendable {
    let attachment: DraftAttachment
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            try Self(attachment: DraftAttachment.read(received.file))
        }
    }
}
struct MessageSubmission {
    let text: String
    let id: String
    let replyTo: String?
    var attachmentIDs: [UUID] = []
    var uploads: [UUID: String] = [:]
}
struct AttachmentUpload: Decodable, Sendable {
    let uploadId: String
    let uploadUrl: String
    let method: String
    let headers: [String: String]
}

// Download links redirect to signed object storage. Keep the owner token on LetAgents only.
final class AttachmentRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    static func redirectedRequest(_ request: URLRequest) -> URLRequest? {
        guard request.url?.scheme == "https" else { return nil }
        var clean = URLRequest(url: request.url!)
        clean.httpMethod = "GET"
        return clean
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(Self.redirectedRequest(request))
    }
}
final class NoUploadRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
extension APIClient {
    func uploadAttachment(roomID: String, token: String, attachment: DraftAttachment) async throws -> String {
        let body = try JSONSerialization.data(withJSONObject: ["file_name": attachment.filename, "mime_type": attachment.contentType, "size_bytes": attachment.data.count])
        let target: AttachmentUpload = try await request(path: ["rooms", roomID, "attachments", "uploads"], token: token, method: "POST", body: body)
        do {
            guard let url = URL(string: target.uploadUrl), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, target.method == "PUT" else {
                throw APIError(status: 0, message: "The attachment upload link is invalid. Try again.")
            }
            var upload = URLRequest(url: url)
            upload.httpMethod = "PUT"
            upload.timeoutInterval = 120
            for (key, value) in target.headers where key.lowercased() == "content-type" || key.lowercased().hasPrefix("x-amz-") { upload.setValue(value, forHTTPHeaderField: key) }
            if upload.value(forHTTPHeaderField: "Content-Type") == nil { upload.setValue(attachment.contentType, forHTTPHeaderField: "Content-Type") }
            let (_, response) = try await session.upload(for: upload, from: attachment.data, delegate: NoUploadRedirect())
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw APIError(status: 0, message: "Couldn’t upload \(attachment.filename). Tap Send to retry.")
            }
            return target.uploadId
        } catch {
            try? await discardAttachment(roomID: roomID, uploadID: target.uploadId, token: token)
            throw error
        }
    }
    func discardAttachment(roomID: String, uploadID: String, token: String) async throws {
        struct Result: Decodable { let ok: Bool }
        let _: Result = try await request(path: ["rooms", roomID, "attachments", "uploads", uploadID], token: token, method: "DELETE")
    }
    func downloadAttachment(roomID: String, messageID: String, attachment: Message.Attachment, token: String) async throws -> URL {
        var request = URLRequest(url: endpoint(["rooms", roomID, "messages", messageID, "attachments", attachment.id]))
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("1", forHTTPHeaderField: "X-LetAgents-Desktop-Client")
        let (data, response) = try await session.data(for: request, delegate: AttachmentRedirect())
        guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, message: "Couldn’t open this attachment.") }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: http.statusCode == 401 ? "Sign in again to open this attachment." : "This attachment couldn’t be downloaded. Try again.")
        }
        try Task.checkCancellation()
        guard data.count <= DraftAttachment.maximumBytes else { throw APIError(status: 0, message: "This attachment is too large to preview.") }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("letagents-attachment-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = URL(fileURLWithPath: attachment.filename).lastPathComponent
        let file = folder.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "attachment" : name)
        do { try data.write(to: file, options: [.atomic, .completeFileProtection]); return file }
        catch { try? FileManager.default.removeItem(at: folder); throw error }
    }
}

enum AttachmentThumbnail {
    static func image(_ data: Data, maximum: Int = 100) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maximum, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}
struct AttachmentDraftRow: View {
    let attachment: DraftAttachment
    let remove: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            if attachment.contentType.hasPrefix("image/"), let image = AttachmentThumbnail.image(attachment.data) {
                Image(uiImage: image).resizable().scaledToFill().frame(width: 40, height: 40).clipShape(RoundedRectangle(cornerRadius: 8))
            } else { Image(systemName: "doc.fill").foregroundStyle(Theme.accent).frame(width: 40, height: 40).background(Theme.outgoing, in: RoundedRectangle(cornerRadius: 8)) }
            VStack(alignment: .leading, spacing: 3) {
                Text(attachment.filename).font(.caption.weight(.medium)).lineLimit(1)
                Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.data.count), countStyle: .file)).font(.caption2).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 0)
            Button(action: remove) { Image(systemName: "xmark").font(.caption.weight(.semibold)).frame(width: 44, height: 44) }
                .accessibilityLabel("Remove \(attachment.filename)")
        }.padding(.leading, 8).background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
    }
}
struct MessageAttachmentButton: View {
    let attachment: Message.Attachment
    let open: () -> Void
    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Image(systemName: attachment.contentType?.hasPrefix("image/") == true ? "photo" : "doc.text").font(.title3).foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 4) {
                    Text(attachment.filename).font(.subheadline.weight(.medium)).lineLimit(2)
                    if let size = attachment.byteSize { Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)).font(.caption).foregroundStyle(Theme.muted) }
                }
                Spacer(minLength: 0); Image(systemName: "arrow.down.circle").foregroundStyle(Theme.accent)
            }.padding(12).frame(maxWidth: .infinity, minHeight: 52, alignment: .leading).background(Theme.code, in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).accessibilityLabel("Open attachment \(attachment.filename)").accessibilityIdentifier("attachment-\(attachment.id)")
    }
}
struct AttachmentDestination: Identifiable {
    let messageID: String
    let attachment: Message.Attachment
    var id: String { messageID + "|" + attachment.id }
}
struct AttachmentPreview: View {
    let destination: AttachmentDestination
    let model: ConversationStore
    @Environment(\.dismiss) private var dismiss
    @State private var file: URL?
    @State private var error: String?
    @State private var attempt = 0
    var body: some View {
        NavigationStack {
            Group {
                if let file { AttachmentQuickLook(url: file) }
                else if let error { ContentUnavailableView { Label("Attachment unavailable", systemImage: "doc.badge.ellipsis") } description: { Text(error) } actions: { Button("Try again") { self.error = nil; attempt += 1 } } }
                else { ProgressView("Opening attachment…").frame(maxWidth: .infinity, maxHeight: .infinity) }
            }.background(Theme.background).navigationTitle("Attachment").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        if let file { ShareLink(item: file) { Image(systemName: "square.and.arrow.up").frame(width: 44, height: 44) }.accessibilityLabel("Share attachment") }
                    }.companionToolbarStyle()
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }.companionToolbarStyle()
                }
                .task(id: attempt) {
                    do { file = try await model.downloadAttachment(destination) }
                    catch is CancellationError { }
                    catch let failure as URLError where failure.code == .cancelled { }
                    catch { self.error = error.localizedDescription }
                }
                .onDisappear { if let file { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }; file = nil }
        }
    }
}
private struct AttachmentQuickLook: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController { let view = QLPreviewController(); view.dataSource = context.coordinator; return view }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) { }
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem { url as NSURL }
    }
}
