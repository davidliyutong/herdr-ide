import AppKit
import GhosttyTerminal
import TermKit

/// The terminal view of a pane: Ghostty's, with the pane's own paste, drop
/// and menu (TerminalPane sets the hooks).
final class PaneTerminalView: TerminalView {
    /// Paste: true when the pane took the clipboard itself (files, images).
    nonisolated(unsafe) var onPaste: (() -> Bool)?
    /// Files dropped: true when the pane took them.
    nonisolated(unsafe) var onDrop: ((NSPasteboard) -> Bool)?
    /// The menu of a right click without a selection.
    nonisolated(unsafe) var menuBuilder: ((NSEvent) -> NSMenu?)?
    /// The pointer moved, with ⌘ held or not.
    nonisolated(unsafe) var onHover: ((NSEvent) -> Void)?

    override func paste(_ sender: Any?) {
        if onPaste?() != true { super.paste(sender) }
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        onDrop?(sender.draggingPasteboard) == true || super.performDragOperation(sender)
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        let files = sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
        return files ? .copy : super.draggingEntered(sender)
    }

    override func draggingUpdated(_ sender: any NSDraggingInfo) -> NSDragOperation {
        let files = sender.draggingPasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
        return files ? .copy : super.draggingUpdated(sender)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        super.menu(for: event) ?? menuBuilder?(event)
    }

    override func rightMouseUp(with event: NSEvent) {
        super.rightMouseUp(with: event)
        // Ghostty shows its own menu for a selection, and programs that
        // take the mouse get the button.
        guard MainActor.assumeIsolated({ selectionRegion }) == nil, let menu = menuBuilder?(event) else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        onHover?(event)
    }
}

/// A pane's title bar: its status, name and directory, and its commands
/// (VS Code, split, zoom, close). Dragging it moves the pane; a double click
/// on it renames the pane.
final class PaneHeader: NSView {
    static let height: CGFloat = 24
    private let dot = FillView(.clear)
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")
    private let buttons = NSStackView()
    private let zoom: ClosureButton
    /// A command for this pane (pane.splitRight, code.open…).
    var onCommand: ((String) -> Void)?
    var onPress: ((NSEvent) -> Void)?
    var menuBuilder: (() -> NSMenu?)?

    init() {
        var run: ((String) -> Void)?
        func button(_ symbol: String, _ tip: String, _ command: String) -> ClosureButton {
            let b = ClosureButton(symbol: symbol, tip: tip) { run?(command) }
            b.widthAnchor.constraint(equalToConstant: 18).isActive = true
            return b
        }
        zoom = button("arrow.up.left.and.arrow.down.right", tr("menu.zoom"), "pane.zoom")
        super.init(frame: .zero)
        run = { [weak self] in self?.onCommand?($0) }
        let background = FillView(Theme.sidebar)
        let border = FillView(Theme.border)
        dot.layer?.cornerRadius = 3
        dot.layer?.masksToBounds = true
        title.lineBreakMode = .byTruncatingTail
        detail.lineBreakMode = .byTruncatingHead
        detail.font = Theme.fontSmall
        detail.textColor = Theme.muted
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        detail.setContentCompressionResistancePriority(.defaultLow - 1, for: .horizontal)
        for b in [button("chevron.left.forwardslash.chevron.right", tr("menu.openCode"), "code.open"),
                  button("rectangle.split.2x1", tr("menu.splitRight"), "pane.splitRight"),
                  button("rectangle.split.1x2", tr("menu.splitDown"), "pane.splitDown"), zoom,
                  button("xmark", tr("menu.closeTerminal"), "pane.close")] {
            buttons.addArrangedSubview(b)
        }
        buttons.spacing = 2
        for view in [background, dot, title, detail, buttons, border] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Self.height),
            background.topAnchor.constraint(equalTo: topAnchor), background.bottomAnchor.constraint(equalTo: bottomAnchor),
            background.leadingAnchor.constraint(equalTo: leadingAnchor), background.trailingAnchor.constraint(equalTo: trailingAnchor),
            dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10), dot.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 6), dot.heightAnchor.constraint(equalToConstant: 6),
            title.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 6), title.centerYAnchor.constraint(equalTo: centerYAnchor),
            detail.leadingAnchor.constraint(equalTo: title.trailingAnchor, constant: 8), detail.centerYAnchor.constraint(equalTo: centerYAnchor),
            detail.trailingAnchor.constraint(lessThanOrEqualTo: buttons.leadingAnchor, constant: -8),
            buttons.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6), buttons.centerYAnchor.constraint(equalTo: centerYAnchor),
            border.bottomAnchor.constraint(equalTo: bottomAnchor), border.heightAnchor.constraint(equalToConstant: Theme.divider),
            border.leadingAnchor.constraint(equalTo: leadingAnchor), border.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    func update(record: TerminalRecord?, address: String, focused: Bool, zoomed: Bool, readOnly: Bool) {
        title.stringValue = record?.displayName ?? address
        title.font = focused ? Theme.fontStrong : Theme.font
        title.textColor = focused ? Theme.foreground : Theme.muted
        let cwd = (record?.raw["foreground"] as? [String: Any])?["cwd"] as? String ?? record?.cwd ?? ""
        detail.stringValue = (cwd as NSString).abbreviatingWithTildeInPath
        dot.fill = Theme.status(Activity.status(record)) ?? .clear
        zoom.image = NSImage(systemSymbolName: zoomed ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                             accessibilityDescription: nil)
        zoom.toolTip = zoomed ? tr("menu.restore") : tr("menu.zoom")
        buttons.isHidden = readOnly
    }

    override func mouseDown(with event: NSEvent) { onPress?(event) }

    override func menu(for _: NSEvent) -> NSMenu? { menuBuilder?() }
}

/// One terminal on screen: Ghostty's surface fed by a stream of the core,
/// under its header. The surface emulates the terminal; the pane only moves
/// bytes and sizes.
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
    let terminalView = PaneTerminalView(frame: .zero)
    let header = PaneHeader()
    private(set) var session: InMemoryTerminalSession!
    private var stream: UInt32?
    private var attaching = false
    private var grid: (cols: Int, rows: Int)?
    /// The size of a cell in points, from the surface's last report.
    private(set) var cell = CGSize(width: 8, height: 16)
    private lazy var findBar = FindBar(
        search: { [weak self] in self?.search($0) },
        step: { [weak self] forward in self?.findStep(forward) },
        close: { [weak self] in self?.hideFind() }
    )
    var isFocusedPane = false
    /// Input is not sent (a read-only core).
    var readOnly = false

    init(machine: String, address: String, connection: TermConnection, controller: TerminalController) {
        self.machine = machine
        self.address = address
        self.connection = connection
        super.init(frame: .zero)
        session = InMemoryTerminalSession(
            write: { [weak self] data in DispatchQueue.main.async { self?.input(data) } },
            resize: { [weak self] viewport in
                DispatchQueue.main.async {
                    guard let self else { return }
                    let scale = self.window?.backingScaleFactor ?? 2
                    if viewport.cellWidthPixels > 0, viewport.cellHeightPixels > 0 {
                        self.cell = CGSize(width: CGFloat(viewport.cellWidthPixels) / scale, height: CGFloat(viewport.cellHeightPixels) / scale)
                    }
                    self.resized(cols: Int(viewport.columns), rows: Int(viewport.rows))
                }
            },
            suppressesPixelOnlyResizes: true
        )
        terminalView.delegate = self
        terminalView.configuration = TerminalSurfaceOptions(backend: .inMemory(session))
        terminalView.controller = controller
        for view in [header, terminalView] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: topAnchor),
            header.leadingAnchor.constraint(equalTo: leadingAnchor),
            header.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalView.topAnchor.constraint(equalTo: header.bottomAnchor),
            terminalView.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalView.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

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
            let waiting = self.onAttach
            self.onAttach = []
            DispatchQueue.main.async { waiting.forEach { $0() } }
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
        if let stream, !readOnly { connection.write(stream, data) }
    }

    private var onAttach: [() -> Void] = []

    /// Runs `fn` once the pane's stream is attached (now when it is).
    func afterAttach(_ fn: @escaping () -> Void) {
        if stream != nil { fn() } else { onAttach.append(fn) }
    }

    /// When the user last typed, clicked or pasted in a terminal: a
    /// program's clipboard write right after that is the user's (OSC 52).
    static var lastInput = Date.distantPast
    /// The terminal.programClipboard setting.
    static var programClipboard = "auto"
    /// Asks the user about a program's clipboard write (a note with a Copy
    /// button); the closure gets the answer.
    static var askClipboard: ((String, @escaping (Bool) -> Void) -> Void)?

    /// Pastes text as the terminal does (bracketed when the program asks).
    func paste(_ text: String) {
        _ = MainActor.assumeIsolated { terminalView.paste(text: text) }
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

    /// A program asks to write the clipboard (OSC 52; Ghostty asks for
    /// every write unless the setting is "off"): copied at once right after
    /// the user's own input when the setting is "auto", else offered in a
    /// note (`Activity.clipboardWrite`). Other requests are refused.
    func terminalDidRequestClipboardConfirmation(_ request: TerminalClipboardConfirmationRequest) {
        guard request.kind == .osc52Write else { return request.respond(allow: false) }
        switch Activity.clipboardWrite(mode: Self.programClipboard, sinceInput: Date().timeIntervalSince(Self.lastInput)) {
        case .allow: request.respond(allow: true)
        case .deny: request.respond(allow: false)
        case .ask:
            guard let ask = Self.askClipboard else { return request.respond(allow: false) }
            ask(request.contents) { request.respond(allow: $0) }
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
