import AppKit
import TermKit
import UserNotifications
import WebKit

/// What agents waiting for the user do, as in the web UI: a sound (on the
/// client the core chose, per the notifications settings), a notification
/// when the window is not in front (clicking it shows the terminal), a note
/// in the window when one is blocked while it is, and the number of blocked
/// terminals on the Dock icon.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private let model: AppModel
    /// Shows a short message in the main window.
    var toast: ((String) -> Void)?
    /// Whether the main window is in front.
    var inFront: () -> Bool = { NSApp.isActive }
    /// The terminal of a notification that was clicked.
    var onOpen: ((String, String) -> Void)?
    private var asked = false

    init(model: AppModel) {
        self.model = model
        super.init()
        // Notifications need an application bundle (not a development
        // build run from SwiftPM).
        if Self.available { UNUserNotificationCenter.current().delegate = self }
    }

    private static var available: Bool { Bundle.main.bundleIdentifier != nil && Bundle.main.bundleURL.pathExtension == "app" }

    func react(_ event: Activity.AgentEvent) {
        let s = model.settings
        let reaction = Activity.reaction(event, soundsOn: s.bool("notifications.sound", true),
                                         muted: Activity.muted(s.string("notifications.mutedAgents", "droid")),
                                         onScreen: model.onScreen(event.terminal, on: event.machine), inFront: inFront())
        switch reaction.sound {
        case .request?: NSSound(named: "Ping")?.play()
        case .done?: NSSound(named: "Glass")?.play()
        case nil: break
        }
        let label = model.machines.first { $0.id == event.machine }?.label ?? event.machine
        let title = event.status == "blocked" ? tr("notify.blocked", event.who) : tr("notify.done", event.who)
        if reaction.note { toast?(title + " · " + label) }
        if reaction.notification { post(title, body: [label, event.title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                                        machine: event.machine, terminal: event.terminal) }
    }

    private func post(_ title: String, body: String, machine: String, terminal: String) {
        guard Self.available else { return }
        let center = UNUserNotificationCenter.current()
        let send = {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.userInfo = ["machine": machine, "terminal": terminal]
            // One notification per terminal: a newer one replaces it.
            center.add(UNNotificationRequest(identifier: machine + "|" + terminal, content: content, trigger: nil))
        }
        if asked { return send() }
        asked = true
        center.requestAuthorization(options: [.alert]) { granted, _ in
            if granted { DispatchQueue.main.async(execute: send) }
        }
    }

    /// The Dock icon's badge: the blocked terminals.
    func updateBadge() {
        let count = Activity.badge(model.attention)
        NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
    }

    func userNotificationCenter(_: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let machine = info["machine"] as? String, let terminal = info["terminal"] as? String {
            DispatchQueue.main.async { self.onOpen?(machine, terminal) }
        }
        done()
    }
}

/// The formula under the pointer in a terminal, rendered by the web UI's
/// KaTeX in a small web view (the core's /math.html) shown in a popover
/// under it, when terminal.mathHover is on. The pointer resting on text for
/// a moment looks it up (`MathText.at` over the screen's rows); moving off
/// the formula hides it.
final class MathHover: NSObject, WKScriptMessageHandler, WKNavigationDelegate, NSPopoverDelegate {
    private let core: URL
    private var web: WKWebView?
    private let popover = NSPopover()
    private var timer: Timer?
    private var shown: (pane: TerminalPane, math: MathText.OnScreen)?
    private var ready = false
    private var queued: (() -> Void)?
    /// Whether the setting is on.
    var enabled = true

    init(core: URL) {
        var parts = URLComponents(url: core, resolvingAgainstBaseURL: false)!
        parts.host = "localhost"
        self.core = parts.url!
        super.init()
        popover.behavior = .semitransient
        popover.animates = false
        popover.delegate = self
    }

    private func page() -> WKWebView {
        if let web { return web }
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "size")
        // Wide enough that a formula is measured on one line; the page's
        // size message then sizes the popover.
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 240), configuration: config)
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        web.load(URLRequest(url: core.appendingPathComponent("math.html")))
        let controller = NSViewController()
        controller.view = web
        popover.contentViewController = controller
        self.web = web
        return web
    }

    /// The pointer moved over a pane.
    func moved(_ event: NSEvent, in pane: TerminalPane) {
        timer?.invalidate()
        guard enabled else { return hide() }
        let point = pane.terminalView.convert(event.locationInWindow, from: nil)
        // Still on the formula shown: nothing to do.
        if let shown, shown.pane === pane, let cell = MainActor.assumeIsolated({ pane.terminalView.viewportCell(at: point) }),
           shown.math.cells.contains(where: { $0.row == cell.row && cell.column >= $0.from && cell.column < $0.to }) { return }
        hide()
        let timer = Timer(timeInterval: 0.35, repeats: false) { [weak self, weak pane] _ in
            guard let self, let pane else { return }
            self.look(at: point, in: pane)
        }
        // Also while a menu or a drag tracks the pointer.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func look(at point: NSPoint, in pane: TerminalPane) {
        guard let cell = MainActor.assumeIsolated({ pane.terminalView.viewportCell(at: point) }),
              let text = pane.session.readViewportText() else { return }
        let width = max(1, Int(pane.terminalView.bounds.width / max(pane.cell.width, 1)))
        let rows = text.components(separatedBy: "\n").map { MathText.Row($0, width: width) }
        guard let math = MathText.at(column: cell.column, row: cell.row, rows: rows) else { return }
        show(math, in: pane)
    }

    private func show(_ math: MathText.OnScreen, in pane: TerminalPane) {
        let web = page()
        let dark = pane.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        // Measured in the full width, so it is not wrapped to the last size.
        popover.contentSize = NSSize(width: 640, height: 240)
        let render = { [weak self, weak pane] in
            guard let self, let pane else { return }
            web.callAsyncJavaScript("return await window.render(tex, display, dark)", arguments: ["tex": math.tex, "display": math.display, "dark": dark],
                                    in: nil, in: .page) { result in
                guard case let .success(value) = result, value as? Bool == true else { return }
                // Under the formula's rows, from its first column.
                let top = CGFloat(math.cells.map(\.row).min() ?? 0), bottom = CGFloat((math.cells.map(\.row).max() ?? 0) + 1)
                let left = CGFloat(math.cells.map(\.from).min() ?? 0)
                let view = pane.terminalView
                let rect = NSRect(x: left * pane.cell.width + 8, y: view.bounds.height - bottom * pane.cell.height - 6,
                                  width: pane.cell.width, height: (bottom - top) * pane.cell.height)
                self.shown = (pane, math)
                self.popover.show(relativeTo: rect, of: view, preferredEdge: .minY)
            }
        }
        if ready { render() } else { queued = render }
    }

    func hide() {
        shown = nil
        if popover.isShown { popover.close() }
    }

    func webView(_: WKWebView, didFinish _: WKNavigation!) {
        ready = true
        queued?()
        queued = nil
    }

    /// Only the core's page loads in it.
    func webView(_: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        decisionHandler(url?.host == core.host && url?.port == core.port ? .allow : .cancel)
    }

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let size = message.body as? [String: Any], let w = size["w"] as? Double, let h = size["h"] as? Double, w > 0, h > 0 else { return }
        // A very long formula scrolls in the popover.
        popover.contentSize = NSSize(width: min(w, 900), height: min(h, 600))
    }
}
