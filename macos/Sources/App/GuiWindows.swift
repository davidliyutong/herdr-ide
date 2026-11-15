import AppKit
import TermKit
import WebKit

/// Shows program windows in windows of their own. The core's page for a
/// window (`/m/<machine>/gui/<window>`) draws its frames and sends input;
/// here it fills a web view that loads nothing but the core.
final class ProgramWindows: NSObject, NSWindowDelegate, WKNavigationDelegate {
    private let core: URL
    private var open: [String: NSWindow] = [:]

    init(core: URL) {
        var parts = URLComponents(url: core, resolvingAgainstBaseURL: false)!
        parts.host = "localhost" // a secure context, for the page's video decoder
        self.core = parts.url!
    }

    private func key(_ window: ProgramWindow) -> String { "\(window.machine)/\(window.id)" }

    func show(_ program: ProgramWindow) {
        if let window = open[key(program)] { return window.makeKeyAndOrderFront(nil) }
        let size = NSSize(width: min(max(CGFloat(program.width), 320), 1600), height: min(max(CGFloat(program.height), 200), 1000))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = program.title
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.identifier = NSUserInterfaceItemIdentifier(key(program))
        let view = WKWebView(frame: NSRect(origin: .zero, size: size))
        view.navigationDelegate = self
        view.autoresizingMask = [.width, .height]
        window.contentView = view
        let machine = program.machine.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? program.machine
        view.load(URLRequest(url: core.appendingPathComponent("m/\(machine)/gui/\(program.id)")))
        window.center()
        window.makeKeyAndOrderFront(nil)
        open[key(program)] = window
    }

    /// Closes the windows whose programs' windows are gone, and keeps the
    /// titles of the others current.
    func reconcile(_ programs: [ProgramWindow]) {
        let current = Dictionary(uniqueKeysWithValues: programs.map { (key($0), $0) })
        for (key, window) in open {
            if let program = current[key] {
                window.title = program.title
            } else {
                open[key] = nil
                window.close()
            }
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard let window = notification.object as? NSWindow, let key = window.identifier?.rawValue else { return }
        open[key] = nil
    }

    func webView(_: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        decisionHandler(WebNavigation.allows(action.request.url, core: core, mainFrame: mainFrame) ? .allow : .cancel)
    }
}
