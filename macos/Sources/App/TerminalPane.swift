import AppKit
import GhosttyTerminal
import TermKit

/// One terminal on screen: Ghostty's surface fed by a stream of the core.
/// The surface emulates the terminal; the pane only moves bytes and sizes.
final class TerminalPane: NSView, TermStreamDelegate, TerminalSurfaceTitleDelegate, TerminalSurfaceSearchDelegate,
    TerminalSurfaceOpenURLHandlingDelegate, TerminalSurfaceBellDelegate, TerminalSurfaceClipboardConfirmationDelegate
{
    /// Lines above the screen a pane asks for when it attaches, so they can
    /// be scrolled to and searched (terminal.scrollback).
    static var history = 10000
    /// What the bell does: none, sound or visual (terminal.bell).
    static var bell = "visual"

    let machine: String
    let address: String
    private let connection: TermConnection
    private let terminalView = TerminalView(frame: .zero)
    private var session: InMemoryTerminalSession!
    private var stream: UInt32?
    private var attaching = false
    private var grid: (cols: Int, rows: Int)?
    private let ring = FillView(.clear)
    private lazy var findBar = FindBar(
        search: { [weak self] in self?.search($0) },
        step: { [weak self] forward in self?.findStep(forward) },
        close: { [weak self] in self?.hideFind() }
    )
    var isFocusedPane = false { didSet { updateRing() } }
    /// Whether the pane is alone in its tab: a single pane needs no ring.
    var isAlone = true { didSet { updateRing() } }

    init(machine: String, address: String, connection: TermConnection, controller: TerminalController) {
        self.machine = machine
        self.address = address
        self.connection = connection
        super.init(frame: .zero)
        session = InMemoryTerminalSession(
            write: { [weak self] data in DispatchQueue.main.async { self?.input(data) } },
            resize: { [weak self] viewport in
                DispatchQueue.main.async { self?.resized(cols: Int(viewport.columns), rows: Int(viewport.rows)) }
            },
            suppressesPixelOnlyResizes: true
        )
        terminalView.delegate = self
        terminalView.configuration = TerminalSurfaceOptions(backend: .inMemory(session))
        terminalView.controller = controller
        for view in [terminalView, ring] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            ring.topAnchor.constraint(equalTo: topAnchor),
            ring.leadingAnchor.constraint(equalTo: leadingAnchor),
            ring.trailingAnchor.constraint(equalTo: trailingAnchor),
            ring.heightAnchor.constraint(equalToConstant: 2),
            terminalView.topAnchor.constraint(equalTo: topAnchor),
            terminalView.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalView.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    private func updateRing() {
        ring.fill = isFocusedPane && !isAlone ? Theme.focusRing : .clear
    }

    override func layout() {
        super.layout()
        terminalView.fitToSize()
    }

    #if DEBUG
        /// Development: types text into the terminal and presses Enter.
        func debugType(_ text: String) {
            MainActor.assumeIsolated {
                terminalView.paste(text: text)
                terminalView.sendKey(.enter)
            }
        }

        /// Development: searches as if the text was typed into the find field.
        func debugFind(_ text: String) {
            findBar.text = text
            search(text)
        }
    #endif

    func takeFocus() {
        if window?.firstResponder !== terminalView { window?.makeFirstResponder(terminalView) }
    }

    /// Whether `view` is this pane's terminal or inside it.
    func contains(_ view: NSView?) -> Bool {
        view?.isDescendant(of: self) ?? false
    }

    // MARK: - Stream

    private func resized(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        grid = (cols, rows)
        if let stream {
            connection.resize(stream, cols: cols, rows: rows)
        } else {
            attach()
        }
    }

    /// Attaches once the surface knows its grid and the connection is up;
    /// called again when the connection returns.
    func attach() {
        guard stream == nil, !attaching, let grid, connection.isConnected else { return }
        attaching = true
        connection.attach(machine, terminal: address, cols: grid.cols, rows: grid.rows, history: Self.history, delegate: self) { [weak self] result in
            guard let self else { return }
            self.attaching = false
            guard case let .success(id) = result else { return }
            self.stream = id
            // The grid may have changed while the attach was on its way.
            if let now = self.grid, now != grid { self.connection.resize(id, cols: now.cols, rows: now.rows) }
            self.connection.focus(id, self.isFocusedPane)
        }
    }

    func detach() {
        if let stream { connection.detach(stream) }
        stream = nil
    }

    private func input(_ data: Data) {
        if let stream { connection.write(stream, data) }
    }

    func stream(_ stream: UInt32, output: Data) {
        // The first paint starts with a reset, so a pane attached again
        // draws over what it showed before.
        session.receive(output)
        connection.ack(stream, output.count)
    }

    func stream(_: UInt32, resizedTo _: Int, rows _: Int) {}

    func stream(_: UInt32, closed _: String, exitCode _: Int?) {
        stream = nil
    }

    func terminalDidChangeTitle(_: String) {}

    // MARK: - Bell and clipboard

    func terminalDidRingBell() {
        switch Self.bell {
        case "sound":
            NSSound.beep()
        case "visual":
            let flash = FillView(Theme.focusRing.withAlphaComponent(0.25))
            flash.frame = bounds
            flash.autoresizingMask = [.width, .height]
            addSubview(flash)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { flash.removeFromSuperview() }
        default:
            break
        }
    }

    /// A program asks to write the clipboard (OSC 52) while
    /// terminal.programClipboard is "ask": the user decides. Other requests
    /// are refused, as without this delegate.
    func terminalDidRequestClipboardConfirmation(_ request: TerminalClipboardConfirmationRequest) {
        guard request.kind == .osc52Write, let window else { return request.respond(allow: false) }
        let alert = NSAlert()
        alert.messageText = tr("clipboard.ask")
        alert.informativeText = String(request.contents.prefix(300))
        alert.addButton(withTitle: tr("clipboard.allow"))
        alert.addButton(withTitle: tr("clipboard.deny"))
        alert.beginSheetModal(for: window) { response in
            request.respond(allow: response == .alertFirstButtonReturn)
        }
    }

    // MARK: - Links

    /// Web and mail links open in their applications; anything else found
    /// in the output is offered as a file's path.
    func terminalShouldHandleOpenURL(_ url: String, kind _: TerminalOpenURLKind) -> Bool {
        if let parsed = URL(string: url), ["http", "https", "mailto"].contains(parsed.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(parsed)
        } else {
            onOpenPath?(url)
        }
        return true
    }

    /// The user activated something in the output that is not a web link:
    /// a path, as far as the pane knows.
    var onOpenPath: ((String) -> Void)?

    // MARK: - Find

    /// Ghostty searches the surface's screen and scrollback and marks the
    /// matches itself; the bar drives it with binding actions.
    private func action(_ name: String) {
        _ = MainActor.assumeIsolated { terminalView.performBindingAction(name) }
    }

    func showFind() {
        if findBar.superview == nil {
            findBar.translatesAutoresizingMaskIntoConstraints = false
            addSubview(findBar)
            NSLayoutConstraint.activate([
                findBar.topAnchor.constraint(equalTo: topAnchor, constant: 8),
                findBar.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                findBar.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 12),
            ])
        }
        let wasFinding = isFinding
        findBar.isHidden = false
        if !wasFinding { action("start_search") }
        findBar.focus()
        if !findBar.text.isEmpty { search(findBar.text) }
    }

    func hideFind() {
        guard findBar.superview != nil, !findBar.isHidden else { return }
        findBar.isHidden = true
        action("end_search")
        takeFocus()
    }

    var isFinding: Bool { findBar.superview != nil && !findBar.isHidden }

    private func search(_ needle: String) {
        // The action's argument runs to the end of the string.
        action("search:" + needle)
        if needle.isEmpty { findBar.show(total: nil, selected: nil) }
    }

    func findStep(_ forward: Bool) {
        guard isFinding else { return showFind() }
        action(forward ? "navigate_search:next" : "navigate_search:previous")
    }

    private var total: Int?
    private var selected: Int?

    /// Ghostty started a search, from the bar or by itself: the bar shows.
    func terminalDidStartSearch(needle: String?) {
        if let needle, !needle.isEmpty, findBar.text.isEmpty { findBar.text = needle }
        if !isFinding { showFind() }
    }

    func terminalDidEndSearch() {
        total = nil
        selected = nil
        findBar.show(total: nil, selected: nil)
    }

    func terminalDidUpdateSearchTotal(_ total: Int?) {
        self.total = total
        findBar.show(total: total, selected: selected)
    }

    func terminalDidUpdateSearchSelected(_ selected: Int?) {
        self.selected = selected
        findBar.show(total: total, selected: selected)
    }
}

/// The find field of a pane: what to look for, how many matches there are
/// and which one is shown.
final class FindBar: NSView, NSTextFieldDelegate {
    // A plain field: a search field keeps Escape for clearing its text.
    private let field = NSTextField()
    private let count = NSTextField(labelWithString: "")
    private let search: (String) -> Void
    private let step: (Bool) -> Void
    private let close: () -> Void

    init(search: @escaping (String) -> Void, step: @escaping (Bool) -> Void, close: @escaping () -> Void) {
        self.search = search
        self.step = step
        self.close = close
        super.init(frame: .zero)
        let background = FillView(Theme.tabActive)
        background.layer?.cornerRadius = Theme.radius
        background.layer?.borderWidth = 1
        background.layer?.masksToBounds = true
        field.placeholderString = tr("find.placeholder")
        field.font = Theme.font
        field.delegate = self
        field.isBordered = false
        field.drawsBackground = false
        field.lineBreakMode = .byTruncatingHead
        field.cell?.isScrollable = true
        field.focusRingType = .none
        count.font = Theme.fontSmall
        count.textColor = Theme.muted
        func button(_ symbol: String, _ label: String, _ action: Selector) -> NSButton {
            let button = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: label)!, target: self, action: action)
            button.isBordered = false
            button.contentTintColor = Theme.muted
            button.toolTip = label
            return button
        }
        let stack = NSStackView(views: [
            field, count,
            button("chevron.up", tr("menu.findPrevious"), #selector(previous)),
            button("chevron.down", tr("menu.findNext"), #selector(next)),
            button("xmark", tr("find.close"), #selector(dismiss)),
        ])
        stack.spacing = 6
        stack.edgeInsets = NSEdgeInsets(top: 5, left: 8, bottom: 5, right: 8)
        for view in [background, stack] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
            NSLayoutConstraint.activate([
                view.topAnchor.constraint(equalTo: topAnchor), view.bottomAnchor.constraint(equalTo: bottomAnchor),
                view.leadingAnchor.constraint(equalTo: leadingAnchor), view.trailingAnchor.constraint(equalTo: trailingAnchor),
            ])
        }
        // As wide as its pane allows, up to 200 points.
        let width = field.widthAnchor.constraint(equalToConstant: 200)
        width.priority = .defaultHigh
        width.isActive = true
        field.widthAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        self.background = background
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    private var background: FillView?

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        effectiveAppearance.performAsCurrentDrawingAppearance {
            background?.layer?.borderColor = Theme.border.cgColor
        }
    }

    var text: String {
        get { field.stringValue }
        set { field.stringValue = newValue }
    }

    func focus() {
        window?.makeFirstResponder(field)
        field.currentEditor()?.selectAll(nil)
    }

    func show(total: Int?, selected: Int?) {
        switch (total, selected) {
        case (0?, _): count.stringValue = tr("find.none")
        case let (total?, selected?): count.stringValue = tr("find.count", String(selected + 1), String(total))
        case let (total?, nil): count.stringValue = String(total)
        default: count.stringValue = ""
        }
    }

    func controlTextDidChange(_: Notification) { search(field.stringValue) }

    func control(_: NSControl, textView _: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.insertNewline(_:)):
            step(NSApp.currentEvent?.modifierFlags.contains(.shift) != true)
        case #selector(NSResponder.cancelOperation(_:)):
            close()
        default:
            return false
        }
        return true
    }

    @objc private func previous() { step(false) }
    @objc private func next() { step(true) }
    @objc private func dismiss() { close() }
}
