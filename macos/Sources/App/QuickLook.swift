import AppKit
import Quartz
import TermKit

/// Shows a file of a machine in the system's Quick Look panel: the core
/// streams it into a private temporary directory (0700), which is emptied
/// before the next preview and when the application quits.
final class QuickLook: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    /// Larger files are not fetched for a preview: a download stops as soon
    /// as its length or the bytes received exceed this.
    static let limit: Int64 = 512 << 20

    private let core: URL
    private var item: URL?
    private var download: BoundedDownload?
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
        download?.cancel()
        var parts = URLComponents(url: core.appendingPathComponent("api/m/\(machine)/file"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "path", value: path)]
        let directory = Self.directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // The file arrives under a name of its own; the preview shown keeps
        // its file until the new one is complete.
        let part = directory.appendingPathComponent(".download-" + UUID().uuidString)
        download = BoundedDownload(parts.url!, to: part, limit: Self.limit) { [weak self] result in
            var local: URL?
            var failure = "quicklook.failed"
            switch result {
            case let .success(file):
                for old in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
                    where old.lastPathComponent != file.lastPathComponent {
                    try? FileManager.default.removeItem(at: old)
                }
                let target = directory.appendingPathComponent(TerminalPath.fileName(path))
                if (try? FileManager.default.moveItem(at: file, to: target)) != nil { local = target }
            case .failure(.tooLarge): failure = "quicklook.tooLarge"
            case .failure(.status(400)): failure = "quicklook.directory"
            case .failure(.status(404)): failure = "quicklook.missing"
            case .failure: break
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
    }

    func numberOfPreviewItems(in _: QLPreviewPanel!) -> Int { item == nil ? 0 : 1 }

    func previewPanel(_: QLPreviewPanel!, previewItemAt _: Int) -> QLPreviewItem! {
        item as NSURL?
    }
}
