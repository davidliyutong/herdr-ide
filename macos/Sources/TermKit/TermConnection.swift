import Foundation

/// What a stream delivers to the pane that attached it. Called on the main
/// queue, in the order the core sent it.
public protocol TermStreamDelegate: AnyObject {
    func stream(_ stream: UInt32, output: Data)
    func stream(_ stream: UInt32, resizedTo cols: Int, rows: Int)
    /// The stream is over: the program's end ("exited", "killed", ...) or
    /// "disconnected".
    func stream(_ stream: UInt32, closed reason: String, exitCode: Int?)
}

/// A connection to the core's terminal protocol (/api/v1/term). It
/// reconnects by itself (`CoreSocket`) and subscribes again; streams end
/// with the connection they were opened on and are attached again by their
/// owners. Use it from the main queue.
public final class TermConnection {
    /// A text message the store may hold (backend, snapshot, event).
    public var onMessage: (([String: Any]) -> Void)?
    /// The connection came (true) or went (false).
    public var onConnection: ((Bool) -> Void)?
    public var isConnected: Bool { socket.isConnected }

    private let socket: CoreSocket
    private var nextRID = 1
    private var replies: [Int: (Result<[String: Any], TermError>) -> Void] = [:]
    private var attaching: [Int: TermStreamDelegate] = [:]
    private var streams: [UInt32: TermStreamDelegate] = [:]
    private var machines: Set<String> = []

    /// `core` is the core's HTTP origin, such as http://127.0.0.1:7781.
    public init(core: URL) {
        socket = CoreSocket(core: core, path: "/api/v1/term")
        socket.onOpen = { [weak self] in self?.opened() }
        socket.onClose = { [weak self] wasConnected in self?.dropped(wasConnected) }
        socket.onText = { [weak self] in self?.text($0) }
        socket.onData = { [weak self] in self?.binary($0) }
    }

    public func start() { socket.start() }

    public func close() { socket.close() }

    private func opened() {
        for machine in machines { send(["t": "sub", "m": machine]) }
        onConnection?(true)
    }

    private func dropped(_ wasConnected: Bool) {
        let waiting = replies
        let open = streams
        replies = [:]
        attaching = [:]
        streams = [:]
        for (_, reply) in waiting { reply(.failure(TermError(kind: "unavailable"))) }
        for (id, delegate) in open { delegate.stream(id, closed: "disconnected", exitCode: nil) }
        if wasConnected { onConnection?(false) }
    }

    private func binary(_ data: Data) {
        guard let frame = Frame(data), let delegate = streams[frame.stream] else { return }
        if frame.kind == FrameKind.data.rawValue {
            delegate.stream(frame.stream, output: frame.payload)
        } else if let grid = frame.grid {
            delegate.stream(frame.stream, resizedTo: grid.cols, rows: grid.rows)
        }
    }

    private func text(_ text: String) {
        guard let msg = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
              let type = msg["t"] as? String else { return }
        switch type {
        case "res":
            guard let rid = msg["rid"] as? Int else { return }
            attaching[rid] = nil
            guard let reply = replies.removeValue(forKey: rid) else { return }
            if let error = msg["error"] as? [String: Any] {
                reply(.failure(TermError(kind: error["kind"] as? String ?? "", message: error["message"] as? String ?? "")))
            } else {
                reply(.success(msg["result"] as? [String: Any] ?? [:]))
            }
        case "attached":
            // Registered here, before the stream's first frame is read.
            guard let rid = msg["rid"] as? Int, let id = (msg["s"] as? NSNumber)?.uint32Value else { return }
            if let delegate = attaching.removeValue(forKey: rid) { streams[id] = delegate }
            replies.removeValue(forKey: rid)?(.success(msg))
        case "closed":
            guard let id = (msg["s"] as? NSNumber)?.uint32Value, let delegate = streams.removeValue(forKey: id) else { return }
            delegate.stream(id, closed: msg["reason"] as? String ?? "", exitCode: msg["exit_code"] as? Int)
        default:
            onMessage?(msg)
        }
    }

    private func send(_ msg: [String: Any]) {
        socket.send(json: msg)
    }

    // MARK: - Machines

    public func subscribe(_ machine: String) {
        guard machines.insert(machine).inserted else { return }
        if isConnected { send(["t": "sub", "m": machine]) }
    }

    public func unsubscribe(_ machine: String) {
        guard machines.remove(machine) != nil else { return }
        if isConnected { send(["t": "unsub", "m": machine]) }
    }

    /// Calls a method of the machine's terminal core.
    public func call(_ machine: String, _ method: String, _ params: [String: Any] = [:],
                     reply: @escaping (Result<[String: Any], TermError>) -> Void) {
        guard isConnected else { return reply(.failure(TermError(kind: "unavailable"))) }
        let rid = nextRID
        nextRID += 1
        replies[rid] = reply
        send(["t": "call", "rid": rid, "m": machine, "method": method, "params": params])
    }

    // MARK: - Streams

    /// Attaches to a terminal; `reply` has the stream's number. `history`
    /// is the number of lines above the screen the first paint brings.
    public func attach(_ machine: String, terminal: String, cols: Int, rows: Int, history: Int = 0, observe: Bool = false,
                       delegate: TermStreamDelegate, reply: @escaping (Result<UInt32, TermError>) -> Void) {
        guard isConnected else { return reply(.failure(TermError(kind: "unavailable"))) }
        let rid = nextRID
        nextRID += 1
        attaching[rid] = delegate
        replies[rid] = { result in
            reply(result.flatMap { msg in
                guard let id = (msg["s"] as? NSNumber)?.uint32Value else { return .failure(TermError(kind: "unavailable")) }
                return .success(id)
            })
        }
        send(["t": "attach", "rid": rid, "m": machine, "terminal": terminal, "cols": cols, "rows": rows, "history": history, "observe": observe])
    }

    public func write(_ stream: UInt32, _ data: Data, automatic: Bool = false) {
        guard streams[stream] != nil else { return }
        socket.send(Frame(stream: stream, kind: automatic ? .automatic : .data, payload: data).encoded())
    }

    /// Returns the credit of output bytes the terminal has taken.
    public func ack(_ stream: UInt32, _ count: Int) {
        guard streams[stream] != nil, count > 0 else { return }
        send(["t": "ack", "s": stream, "n": count])
    }

    public func resize(_ stream: UInt32, cols: Int, rows: Int) {
        guard streams[stream] != nil else { return }
        send(["t": "resize", "s": stream, "cols": cols, "rows": rows])
    }

    public func focus(_ stream: UInt32, _ focused: Bool) {
        guard streams[stream] != nil else { return }
        send(["t": "focus", "s": stream, "focused": focused])
    }

    public func detach(_ stream: UInt32) {
        guard streams.removeValue(forKey: stream) != nil else { return }
        send(["t": "detach", "s": stream])
    }
}
