import Foundation

/// A WebSocket to the core that reconnects by itself: 0.5 s after a
/// connection went or an attempt failed, doubling to 8 s, back to 0.5 s once
/// one opens. The clients of the core's endpoints (`TermConnection`,
/// `EventConnection`) are built on it. Use it from the main queue.
final class CoreSocket: NSObject, URLSessionWebSocketDelegate {
    /// A connection opened.
    var onOpen: (() -> Void)?
    /// A connection, or an attempt at one, ended; true when it had opened.
    var onClose: ((Bool) -> Void)?
    var onText: ((String) -> Void)?
    var onData: ((Data) -> Void)?
    private(set) var isConnected = false

    private let url: URL
    private lazy var session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: .main)
    private var task: URLSessionWebSocketTask?
    private var retry: TimeInterval = 0.5
    private var closed = false

    /// `core` is the core's HTTP origin, such as http://127.0.0.1:7781.
    init(core: URL, path: String, query: String? = nil) {
        var parts = URLComponents(url: core, resolvingAgainstBaseURL: false)!
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        parts.path = path
        parts.query = query
        url = parts.url!
        super.init()
    }

    func start() {
        guard task == nil, !closed else { return }
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 32 << 20
        self.task = task
        task.resume()
        receive(on: task)
    }

    /// Ends the connection for good.
    func close() {
        closed = true
        task?.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }

    func send(_ text: String) {
        task?.send(.string(text)) { _ in }
    }

    func send(_ data: Data) {
        task?.send(.data(data)) { _ in }
    }

    /// Sends a JSON text message.
    func send(json: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return }
        send(String(decoding: data, as: UTF8.self))
    }

    func urlSession(_: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol _: String?) {
        guard webSocketTask === task else { return }
        isConnected = true
        retry = 0.5
        onOpen?()
    }

    func urlSession(_: URLSession, task finished: URLSessionTask, didCompleteWithError _: Error?) {
        guard finished === task else { return }
        dropped()
    }

    private func dropped() {
        task = nil
        let wasConnected = isConnected
        isConnected = false
        onClose?(wasConnected)
        guard !closed else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + retry) { [weak self] in self?.start() }
        retry = min(retry * 2, 8)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, task === self.task else { return }
                switch result {
                case .failure:
                    task.cancel()
                    self.dropped()
                case let .success(message):
                    switch message {
                    case let .data(data): self.onData?(data)
                    case let .string(text): self.onText?(text)
                    @unknown default: break
                    }
                    self.receive(on: task)
                }
            }
        }
    }
}
