import Foundation

/// A file or directory of a machine as `GET /api/m/{id}/list` reports it.
public struct RemoteEntry: Equatable {
    public var name: String
    public var path: String
    public var size: Int64
    /// Modified, in unix milliseconds.
    public var modified: Int64
    public var isDirectory: Bool

    public init(name: String, path: String = "", size: Int64 = 0, modified: Int64 = 0, isDirectory: Bool = false) {
        self.name = name
        self.path = path
        self.size = size
        self.modified = modified
        self.isDirectory = isDirectory
    }

    public init?(_ json: JSONValue?) {
        guard let json, let name = json["name"]?.string else { return nil }
        self.init(name: name, path: json["path"]?.string ?? "", size: Int64(json["size"]?.number ?? 0),
                  modified: Int64(json["mtime"]?.number ?? 0), isDirectory: json["is_dir"]?.bool ?? false)
    }

    /// A list reply: the directory (its path as the machine resolved it)
    /// and its entries, directories first, then by name.
    public static func listing(_ reply: JSONValue?) -> (directory: RemoteEntry, entries: [RemoteEntry])? {
        guard let dir = RemoteEntry(reply?["dir"]) else { return nil }
        let entries = (reply?["entries"]?.array ?? []).compactMap { RemoteEntry($0) }.sorted {
            $0.isDirectory != $1.isDirectory ? $0.isDirectory : $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        return (dir, entries)
    }

    /// The path of an entry of the directory `directory`.
    public static func join(_ directory: String, _ name: String) -> String {
        (directory == "/" ? "" : directory.hasSuffix("/") ? String(directory.dropLast()) : directory) + "/" + name
    }

    /// The directory above `path` ("/" for the root and its children).
    public static func parent(_ path: String) -> String {
        let trimmed = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
        guard let slash = trimmed.lastIndex(of: "/"), slash != trimmed.startIndex else { return "/" }
        return String(trimmed[..<slash])
    }

    /// The name a download is saved under by default: a file's own name, a
    /// directory's or several entries' (their common directory's) with
    /// ".zip", as the core names its archives.
    public static func downloadName(_ paths: [String], single isFile: Bool) -> String {
        guard let first = paths.first else { return "download.zip" }
        if paths.count == 1, isFile { return TerminalPath.fileName(first) }
        var dir = paths.count == 1 ? first : parent(first)
        for p in paths.dropFirst() { while dir != "/", !p.hasPrefix(dir + "/") { dir = parent(dir) } }
        let base = (dir as NSString).lastPathComponent
        return base.isEmpty || base == "/" ? "download.zip" : base + ".zip"
    }
}

/// Text for a terminal: a path quoted for a shell when it needs quoting.
public func shellQuote(_ path: String) -> String {
    let plain = path.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || "_@%+=:,./~-".unicodeScalars.contains($0) }
    return plain && !path.isEmpty ? path : "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

/// A transfer's speed over the last seconds, from the bytes done so far.
public struct Speed {
    public static let window: TimeInterval = 3
    private var samples: [(TimeInterval, Int64)]

    public init(now: TimeInterval = Date().timeIntervalSince1970, sent: Int64 = 0) {
        samples = [(now, sent)]
    }

    /// Records the bytes done; returns bytes per second.
    public mutating func add(_ sent: Int64, now: TimeInterval = Date().timeIntervalSince1970) -> Double {
        samples.append((now, sent))
        while samples.count > 2, now - samples[1].0 >= Self.window { samples.removeFirst() }
        let (t0, s0) = samples[0]
        return now > t0 ? Double(sent - s0) / (now - t0) : 0
    }
}

/// An upload to a machine or a download from one, as the transfers panel
/// lists it.
public struct Transfer: Equatable, Codable {
    public enum Kind: String, Codable { case upload, download }
    public enum Status: String, Codable { case queued, running, finishing, done, failed, cancelled }

    public var id: String
    public var kind: Kind
    /// The machine's id, and its name when the transfer started.
    public var machine: String
    public var machineLabel: String
    public var name: String
    /// Downloads: the paths on the machine; uploads: the directory asked
    /// for ("" for the machine's upload directory).
    public var paths: [String]
    public var status: Status
    public var sent: Int64
    /// Total bytes; nil while unknown (an archive being made).
    public var size: Int64?
    public var speed: Double
    public var started: Date
    public var ended: Date?
    /// Where it ended up: the path on the machine (uploads), the file on
    /// this Mac (downloads).
    public var result: String?
    public var error: String?

    public init(id: String = UUID().uuidString, kind: Kind, machine: String, machineLabel: String, name: String, paths: [String],
                size: Int64? = nil, started: Date = Date()) {
        self.id = id
        self.kind = kind
        self.machine = machine
        self.machineLabel = machineLabel
        self.name = name
        self.paths = paths
        status = .queued
        sent = 0
        self.size = size
        speed = 0
        self.started = started
    }

    public var isFinished: Bool { [.done, .failed, .cancelled].contains(status) }
    /// Whether it can still be cancelled: not once the machine is finishing
    /// an upload.
    public var cancellable: Bool { status == .queued || status == .running }
}

/// The transfers in progress and the history of finished ones (the last
/// `historyMax`, kept by `save`; names and paths, no contents).
public final class TransferList {
    public static let historyMax = 50
    public private(set) var active: [Transfer] = []
    public private(set) var history: [Transfer]
    /// Something changed.
    public var onChange: (() -> Void)?
    private let save: ([Transfer]) -> Void

    public init(history: [Transfer] = [], save: @escaping ([Transfer]) -> Void = { _ in }) {
        self.history = Array(history.filter(\.isFinished).prefix(Self.historyMax))
        self.save = save
    }

    public func find(_ id: String) -> Transfer? { active.first { $0.id == id } }

    public func add(_ transfer: Transfer) {
        active.append(transfer)
        onChange?()
    }

    public func update(_ id: String, _ change: (inout Transfer) -> Void) {
        guard let index = active.firstIndex(where: { $0.id == id }) else { return }
        change(&active[index])
        onChange?()
    }

    /// Moves a transfer to the history with how it ended; a finished one's
    /// speed is its average.
    public func end(_ id: String, _ status: Transfer.Status, result: String? = nil, error: String? = nil, now: Date = Date()) {
        guard let index = active.firstIndex(where: { $0.id == id }) else { return }
        var t = active.remove(at: index)
        t.status = status
        t.ended = now
        t.result = result ?? t.result
        t.error = error
        if status == .done {
            if t.kind == .download || t.size == nil { t.size = t.sent }
            t.sent = t.size ?? t.sent
            let seconds = now.timeIntervalSince(t.started)
            t.speed = seconds > 0 ? Double(t.sent) / seconds : 0
        } else {
            t.speed = 0
        }
        history.insert(t, at: 0)
        history = Array(history.prefix(Self.historyMax))
        save(history)
        onChange?()
    }

    public func forget(_ id: String) {
        history.removeAll { $0.id == id }
        save(history)
        onChange?()
    }

    public func clearHistory() {
        history = []
        save(history)
        onChange?()
    }

    /// Bytes done and in all of the active transfers; the total is nil
    /// while one of them has no size.
    public var progress: (sent: Int64, size: Int64?) {
        var sent: Int64 = 0
        var size: Int64? = 0
        for t in active {
            sent += t.sent
            size = size.flatMap { s in t.size.map { s + $0 } }
        }
        return (sent, size)
    }
}

/// Uploads and downloads over the core's file endpoints
/// (`POST /api/m/{id}/upload?name=&dir=`, `GET /api/m/{id}/download?path=…`)
/// with their progress, on the main queue. Cancelling a task breaks the
/// request off: the core then ends its stream to the machine's agent, which
/// removes a file it was writing.
public final class TransferClient: NSObject, URLSessionDataDelegate, URLSessionDownloadDelegate {
    public enum Event {
        /// Bytes sent (uploads) or received (downloads) and the total when known.
        case progress(Int64, Int64?)
        /// The whole body of an upload is sent: the machine is writing it.
        case sent
        /// The result: the path on the machine, or the file saved here.
        case done(String)
        /// Why it failed: the core's message, or "cancelled".
        case failed(String)
    }

    private let core: URL
    private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: .main)
    private var handlers: [Int: (Event) -> Void] = [:]
    private var bodies: [Int: Data] = [:]
    private var destinations: [Int: URL] = [:]

    public init(core: URL) {
        self.core = core
    }

    private func url(_ machine: String, _ endpoint: String, _ query: [URLQueryItem]) -> URL {
        var parts = URLComponents(url: core, resolvingAgainstBaseURL: false)!
        parts.percentEncodedPath = "/api/m/" + (machine.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? machine) + "/" + endpoint
        parts.queryItems = query
        return parts.url!
    }

    /// Uploads a file (or data) as `name` into `dir` on the machine ("" for
    /// its upload directory). Returns the task, to cancel it.
    @discardableResult
    public func upload(machine: String, name: String, dir: String, file: URL?, data: Data? = nil,
                       handler: @escaping (Event) -> Void) -> URLSessionTask {
        var query = [URLQueryItem(name: "name", value: name)]
        if !dir.isEmpty { query.append(URLQueryItem(name: "dir", value: dir)) }
        var request = URLRequest(url: url(machine, "upload", query))
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let task = file.map { session.uploadTask(with: request, fromFile: $0) } ?? session.uploadTask(with: request, from: data ?? Data())
        handlers[task.taskIdentifier] = handler
        task.resume()
        return task
    }

    /// Downloads paths of a machine into `destination` (one file as itself,
    /// anything else as a zip the machine makes on the fly).
    @discardableResult
    public func download(machine: String, paths: [String], to destination: URL, handler: @escaping (Event) -> Void) -> URLSessionTask {
        let task = session.downloadTask(with: url(machine, "download", paths.map { URLQueryItem(name: "path", value: $0) }))
        handlers[task.taskIdentifier] = handler
        destinations[task.taskIdentifier] = destination
        task.resume()
        return task
    }

    public func urlSession(_: URLSession, task: URLSessionTask, didSendBodyData _: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        handlers[task.taskIdentifier]?(.progress(totalBytesSent, totalBytesExpectedToSend > 0 ? totalBytesExpectedToSend : nil))
        if totalBytesExpectedToSend > 0, totalBytesSent >= totalBytesExpectedToSend { handlers[task.taskIdentifier]?(.sent) }
    }

    public func urlSession(_: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        bodies[dataTask.taskIdentifier, default: Data()].append(data)
    }

    public func urlSession(_: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64, totalBytesWritten: Int64,
                           totalBytesExpectedToWrite: Int64) {
        handlers[downloadTask.taskIdentifier]?(.progress(totalBytesWritten, totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil))
    }

    public func urlSession(_: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let id = downloadTask.taskIdentifier
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200, let destination = destinations[id] else {
            // An error response is short text: keep it as the reason.
            bodies[id] = (try? Data(contentsOf: location)) ?? Data()
            return
        }
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: location, to: destination)
            destinations[id] = nil
            handlers.removeValue(forKey: id)?(.done(destination.path))
        } catch {
            bodies[id] = Data(error.localizedDescription.utf8)
        }
    }

    public func urlSession(_: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let id = task.taskIdentifier
        destinations[id] = nil
        let body = bodies.removeValue(forKey: id) ?? Data()
        guard let handler = handlers.removeValue(forKey: id) else { return }
        if let error = error as? URLError, error.code == .cancelled { return handler(.failed("cancelled")) }
        if let error { return handler(.failed(error.localizedDescription)) }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: body)).map { JSONValue(any: $0) }
        if (200 ..< 300).contains(status), task is URLSessionUploadTask, let path = json?["path"]?.string {
            return handler(.done(path))
        }
        let text = json?["error"]?.string ?? String(decoding: body, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        handler(.failed(text.isEmpty ? "HTTP \(status)" : text))
    }
}
