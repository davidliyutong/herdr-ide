import AppKit
import Quartz
import TermKit

/// Shows a file of a machine in the system's Quick Look panel: the core
/// streams it into a temporary directory, which is emptied before the next
/// preview and when the application quits.
final class QuickLook: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    /// Larger files are not fetched for a preview.
    static let limit: Int64 = 512 << 20

    private let core: URL
    private var item: URL?
    private var task: URLSessionDownloadTask?
    /// A preview could not be shown: a key of the strings and the path.
    var onFailure: ((String, String) -> Void)?

    init(core: URL) {
        self.core = core
        super.init()
        Self.clear()
    }

    private static var directory: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(Brand.appSlug + "-quicklook", isDirectory: true)
    }

    static func clear() {
        try? FileManager.default.removeItem(at: directory)
    }

    func preview(_ path: String, on machine: String) {
        task?.cancel()
        var parts = URLComponents(url: core.appendingPathComponent("api/m/\(machine)/file"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "path", value: path)]
        let task = URLSession.shared.downloadTask(with: parts.url!) { [weak self] file, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            var local: URL?
            var failure = "quicklook.failed"
            if status == 200, let file {
                let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize).flatMap { $0 } ?? 0
                if Int64(size) > Self.limit {
                    failure = "quicklook.tooLarge"
                } else {
                    Self.clear()
                    let target = Self.directory.appendingPathComponent(TerminalPath.fileName(path))
                    try? FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                    if (try? FileManager.default.moveItem(at: file, to: target)) != nil { local = target }
                }
            } else if status == 400 {
                failure = "quicklook.directory"
            } else if status == 404 {
                failure = "quicklook.missing"
            }
            DispatchQueue.main.async {
                guard let self else { return }
                guard let local else { return self.onFailure?(failure, path) ?? () }
                self.item = local
                guard let panel = QLPreviewPanel.shared() else { return }
                panel.makeKeyAndOrderFront(nil)
                panel.reloadData()
            }
        }
        self.task = task
        task.resume()
    }

    func numberOfPreviewItems(in _: QLPreviewPanel!) -> Int { item == nil ? 0 : 1 }

    func previewPanel(_: QLPreviewPanel!, previewItemAt _: Int) -> QLPreviewItem! {
        item as NSURL?
    }
}
