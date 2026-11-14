import Foundation

/// The core the application owns: started from the application's bundle with
/// its stdin held open, so the core stops when the application does, also
/// when it crashes.
public final class CoreProcess {
    public enum Failure: Error, Equatable {
        case missing(String)
        case exited(Int32)
        case timeout
    }

    private var process: Process?
    private var stdin: Pipe?
    private var log: [String] = []
    private let logLock = NSLock()
    /// Lines of the core's log kept for a failure's report.
    public static let logLines = 40

    public init() {}

    /// The last lines the core logged, for an error that names why it
    /// failed.
    public var logTail: String {
        logLock.lock()
        defer { logLock.unlock() }
        return log.joined(separator: "\n")
    }

    private func keep(_ text: String) {
        logLock.lock()
        log += text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        if log.count > Self.logLines { log.removeFirst(log.count - Self.logLines) }
        logLock.unlock()
    }

    /// The arguments of the owned core: a port of the system's choice on
    /// loopback, and the instance whose data the application uses.
    public static func arguments(dev: Bool) -> [String] {
        var args = ["serve", "--parent-stdio", "--listen", "127.0.0.1:0", "--instance", dev ? "dev" : "desktop"]
        if dev {
            args.append("--local-only")
        }
        return args
    }

    /// PATH with the usual install locations: applications started from
    /// Finder do not get the shell's.
    public static func environment(_ env: [String: String], home: String) -> [String: String] {
        var env = env
        let paths = [env["PATH"] ?? "", home + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        env["PATH"] = paths.filter { !$0.isEmpty }.joined(separator: ":")
        return env
    }

    /// Parses the line the core prints once it listens:
    /// {"event":"ready","url":"http://127.0.0.1:PORT"}.
    public static func readyURL(_ line: String) -> URL? {
        guard let obj = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
              obj["event"] as? String == "ready", let text = obj["url"] as? String,
              let url = URL(string: text), url.host == "127.0.0.1" || url.host == "localhost" else { return nil }
        return url
    }

    /// Starts the core and calls `ready` on the main queue with its URL, or
    /// with why it did not come up; `exited` when it ends later.
    public func start(binary: URL, dev: Bool, ready: @escaping (Result<URL, Failure>) -> Void, exited: @escaping () -> Void) {
        guard FileManager.default.isExecutableFile(atPath: binary.path) else {
            return ready(.failure(.missing(binary.path)))
        }
        let process = Process()
        let input = Pipe(), output = Pipe(), errors = Pipe()
        process.executableURL = binary
        process.arguments = Self.arguments(dev: dev)
        process.environment = Self.environment(ProcessInfo.processInfo.environment, home: NSHomeDirectory())
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        process.standardInput = input
        process.standardOutput = output
        // The log goes on to the application's own, and its end is kept.
        process.standardError = errors
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            FileHandle.standardError.write(chunk)
            self?.keep(String(decoding: chunk, as: UTF8.self))
        }
        var answered = false
        let answer: (Result<URL, Failure>) -> Void = { result in
            DispatchQueue.main.async {
                guard !answered else { return }
                answered = true
                ready(result)
            }
        }
        var buffer = Data()
        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            buffer.append(chunk)
            while let newline = buffer.firstIndex(of: 10) {
                let line = String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self)
                buffer.removeSubrange(buffer.startIndex...newline)
                if let url = Self.readyURL(line) { answer(.success(url)) }
            }
        }
        process.terminationHandler = { process in
            // A moment for the log's last lines to arrive.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                answer(.failure(.exited(process.terminationStatus)))
                DispatchQueue.main.async {
                    if answered { exited() }
                }
            }
        }
        do { try process.run() } catch { return ready(.failure(.missing(binary.path))) }
        self.process = process
        stdin = input
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { answer(.failure(.timeout)) }
    }

    /// Asks the core to stop and waits up to 20 s before killing it.
    public func stop() {
        guard let process, process.isRunning else { return }
        process.terminationHandler = nil
        process.terminate()
        let deadline = Date().addingTimeInterval(20)
        while process.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        try? stdin?.fileHandleForWriting.close()
    }
}
