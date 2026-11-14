import AppKit
import TermKit
import WebKit

/// A panel beside the terminals showing pages of the core in web views: VS
/// Code (code-server behind the core's proxy) for a folder of a machine.
/// Only the core's own origin loads in it; other links open in the
/// browser.
final class WebPanel: NSView, WKNavigationDelegate, WKUIDelegate {
    /// Folders kept loaded; the least recently shown goes first.
    static let kept = 3

    private let core: URL
    private var views: [(key: String, view: WKWebView)] = []
    private let placeholder = NSTextField(wrappingLabelWithString: "")
    private let pool = WKProcessPool()

    /// `core` is the core's origin. Its host is replaced by localhost,
    /// which web views treat as a secure context; VS Code's own web views
    /// need one.
    init(core: URL) {
        var parts = URLComponents(url: core, resolvingAgainstBaseURL: false)!
        parts.host = "localhost"
        self.core = parts.url!
        super.init(frame: .zero)
        let background = FillView(Theme.background)
        let border = FillView(Theme.border)
        placeholder.font = Theme.font
        placeholder.textColor = Theme.muted
        placeholder.alignment = .center
        for view in [background, placeholder, border] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            background.topAnchor.constraint(equalTo: topAnchor), background.bottomAnchor.constraint(equalTo: bottomAnchor),
            background.leadingAnchor.constraint(equalTo: leadingAnchor), background.trailingAnchor.constraint(equalTo: trailingAnchor),
            placeholder.centerXAnchor.constraint(equalTo: centerXAnchor), placeholder.centerYAnchor.constraint(equalTo: centerYAnchor),
            placeholder.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -32),
            border.topAnchor.constraint(equalTo: topAnchor), border.bottomAnchor.constraint(equalTo: bottomAnchor),
            border.leadingAnchor.constraint(equalTo: leadingAnchor), border.widthAnchor.constraint(equalToConstant: Theme.divider),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    /// The page of VS Code for a folder of a machine.
    static func codeURL(core: URL, machine: String, folder: String) -> URL {
        var parts = URLComponents(url: core, resolvingAgainstBaseURL: false)!
        parts.percentEncodedPath = "/m/" + (machine.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? machine) + "/code/"
        parts.queryItems = [URLQueryItem(name: "folder", value: folder)]
        return parts.url!
    }

    /// Shows VS Code for `folder` on `machine`, or says that there is
    /// nothing to show it for.
    func showCode(machine: String?, folder: String?) {
        guard let machine, let folder, folder.hasPrefix("/") else {
            views.forEach { $0.view.isHidden = true }
            placeholder.stringValue = tr("code.noFolder")
            placeholder.isHidden = false
            return
        }
        placeholder.isHidden = true
        let key = machine + "\n" + folder
        if let index = views.firstIndex(where: { $0.key == key }) {
            views.append(views.remove(at: index))
        } else {
            let configuration = WKWebViewConfiguration()
            configuration.processPool = pool
            let view = WKWebView(frame: bounds, configuration: configuration)
            view.navigationDelegate = self
            view.uiDelegate = self
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
            NSLayoutConstraint.activate([
                view.topAnchor.constraint(equalTo: topAnchor), view.bottomAnchor.constraint(equalTo: bottomAnchor),
                view.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Theme.divider),
                view.trailingAnchor.constraint(equalTo: trailingAnchor),
            ])
            view.load(URLRequest(url: Self.codeURL(core: core, machine: machine, folder: folder)))
            views.append((key, view))
            while views.count > Self.kept {
                views.removeFirst().view.removeFromSuperview()
            }
        }
        for entry in views { entry.view.isHidden = entry.key != key }
    }

    #if DEBUG
        /// Development: the title and address of the page shown.
        func debugDescribe(_ done: @escaping (String) -> Void) {
            guard let view = views.last?.view else { return done("no page") }
            view.evaluateJavaScript("document.title + ' | ' + location.href + ' | ' + document.body.innerText.slice(0, 120)") { value, error in
                done((value as? String) ?? "error: \(String(describing: error))")
            }
        }
    #endif

    /// Whether `view` is in one of the panel's pages.
    func contains(_ view: NSView?) -> Bool { view?.isDescendant(of: self) ?? false }

    private func isCore(_ url: URL?) -> Bool {
        guard let url else { return false }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return true }
        return url.scheme == core.scheme && url.host == core.host && url.port == core.port
    }

    private func openOutside(_ url: URL?) {
        if let url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
    }

    func webView(_: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if isCore(action.request.url) { return decisionHandler(.allow) }
        if action.targetFrame?.isMainFrame != false { openOutside(action.request.url) }
        decisionHandler(.cancel)
    }

    /// window.open: nothing opens inside the application.
    func webView(_: WKWebView, createWebViewWith _: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures _: WKWindowFeatures) -> WKWebView? {
        if !isCore(action.request.url) || action.request.url?.scheme?.hasPrefix("http") == true { openOutside(action.request.url) }
        return nil
    }
}
