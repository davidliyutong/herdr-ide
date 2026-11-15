import Foundation

/// Fetches a URL into a file of its own (0600) and refuses a body larger
/// than a limit before it is on disk: by its announced length before the
/// first byte is written, and by the bytes received while it streams. A
/// refused or failed download leaves no file.
public final class BoundedDownload: NSObject, URLSessionDataDelegate {
    public enum Failure: Error, Equatable {
        /// The answer was not 200 (its HTTP status).
        case status(Int)
        /// The body is larger than the limit.
        case tooLarge
        /// The transfer or the file failed.
        case failed
    }

    private let file: URL
    private let limit: Int64
    private var completion: ((Result<URL, Failure>) -> Void)?
    /// The download's state is used on this queue only.
    private let queue = OperationQueue()
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var handle: FileHandle?
    private var received: Int64 = 0

    /// Starts fetching `url` into `file`, which must not exist yet;
    /// `completion` runs once, on a queue of the download's own.
    public init(_ url: URL, to file: URL, limit: Int64, configuration: URLSessionConfiguration = .ephemeral,
                completion: @escaping (Result<URL, Failure>) -> Void) {
        self.file = file
        self.limit = limit
        self.completion = completion
        super.init()
        queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        self.session = session
        let task = session.dataTask(with: url)
        self.task = task
        task.resume()
    }

    /// Stops the download; its completion does not run.
    public func cancel() {
        queue.addOperation { [self] in
            guard completion != nil else { return }
            completion = nil
            finish(.failure(.failed))
        }
    }

    private func finish(_ result: Result<URL, Failure>) {
        try? handle?.close()
        handle = nil
        if case .failure = result { try? FileManager.default.removeItem(at: file) }
        task?.cancel()
        session?.finishTasksAndInvalidate()
        session = nil
        let done = completion
        completion = nil
        done?(result)
    }

    public func urlSession(_: URLSession, dataTask _: URLSessionDataTask, didReceive response: URLResponse,
                           completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 200
        guard status == 200 else {
            completionHandler(.cancel)
            return finish(.failure(.status(status)))
        }
        guard response.expectedContentLength <= limit else {
            completionHandler(.cancel)
            return finish(.failure(.tooLarge))
        }
        guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]),
              let handle = try? FileHandle(forWritingTo: file) else {
            completionHandler(.cancel)
            return finish(.failure(.failed))
        }
        self.handle = handle
        completionHandler(.allow)
    }

    public func urlSession(_: URLSession, dataTask _: URLSessionDataTask, didReceive data: Data) {
        guard let handle else { return }
        received += Int64(data.count)
        guard received <= limit else { return finish(.failure(.tooLarge)) }
        do { try handle.write(contentsOf: data) } catch { finish(.failure(.failed)) }
    }

    public func urlSession(_: URLSession, task _: URLSessionTask, didCompleteWithError error: Error?) {
        guard completion != nil else { return }
        finish(error == nil && handle != nil ? .success(file) : .failure(.failed))
    }
}
