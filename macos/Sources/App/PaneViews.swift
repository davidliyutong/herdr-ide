import AppKit
import TermKit

/// Two views side by side or stacked, with a divider that can be dragged.
final class SplitView: NSView {
    let axis: Layout.Axis
    private(set) var ratio: CGFloat
    let first: NSView
    let second: NSView
    /// The user moved the divider to this ratio.
    var onRatio: ((Double) -> Void)?
    private let divider = FillView(Theme.border)
    private static let grab: CGFloat = 4

    init(axis: Layout.Axis, ratio: Double, first: NSView, second: NSView) {
        self.axis = axis
        self.ratio = CGFloat(ratio)
        self.first = first
        self.second = second
        super.init(frame: .zero)
        addSubview(first)
        addSubview(second)
        addSubview(divider)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        let d = Theme.divider
        if axis == .horizontal {
            let w = ((bounds.width - d) * ratio).rounded()
            first.frame = NSRect(x: 0, y: 0, width: w, height: bounds.height)
            divider.frame = NSRect(x: w, y: 0, width: d, height: bounds.height)
            second.frame = NSRect(x: w + d, y: 0, width: max(bounds.width - w - d, 0), height: bounds.height)
        } else {
            let h = ((bounds.height - d) * ratio).rounded()
            first.frame = NSRect(x: 0, y: 0, width: bounds.width, height: h)
            divider.frame = NSRect(x: 0, y: h, width: bounds.width, height: d)
            second.frame = NSRect(x: 0, y: h + d, width: bounds.width, height: max(bounds.height - h - d, 0))
        }
    }

    private var grabRect: NSRect { divider.frame.insetBy(dx: axis == .horizontal ? -Self.grab : 0, dy: axis == .vertical ? -Self.grab : 0) }

    override func resetCursorRects() {
        addCursorRect(grabRect, cursor: axis == .horizontal ? .resizeLeftRight : .resizeUpDown)
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let superview else { return super.hitTest(point) }
        return grabRect.contains(convert(point, from: superview)) ? self : super.hitTest(point)
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        var last = ratio
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]), next.type != .leftMouseUp {
            let p = convert(next.locationInWindow, from: nil)
            let total = axis == .horizontal ? bounds.width : bounds.height
            guard total > 0 else { continue }
            last = min(max((axis == .horizontal ? p.x : p.y) / total, 0.1), 0.9)
            ratio = last
            needsLayout = true
            layoutSubtreeIfNeeded()
        }
        window.invalidateCursorRects(for: self)
        onRatio?(Double(last))
    }
}

/// Shows the selected tab's panes. Panes are kept by terminal, so a
/// terminal keeps its surface when the arrangement around it changes.
final class PaneArea: NSView {
    private let model: AppModel
    private let controller: TerminalControllerBox
    private var panes: [String: TerminalPane] = [:] // machine + "/" + address
    private var shown: Layout.Node?
    private var shownMachine: String?
    private var content: NSView?
    private let empty = EmptyView()
    /// A path was activated in a terminal: machine, terminal, text.
    var onOpenPath: ((String, String, String) -> Void)?

    init(model: AppModel, controller: TerminalControllerBox) {
        self.model = model
        self.controller = controller
        super.init(frame: .zero)
        let background = FillView(Theme.background)
        background.translatesAutoresizingMaskIntoConstraints = false
        addSubview(background)
        empty.translatesAutoresizingMaskIntoConstraints = false
        addSubview(empty)
        NSLayoutConstraint.activate([
            background.topAnchor.constraint(equalTo: topAnchor), background.bottomAnchor.constraint(equalTo: bottomAnchor),
            background.leadingAnchor.constraint(equalTo: leadingAnchor), background.trailingAnchor.constraint(equalTo: trailingAnchor),
            empty.centerXAnchor.constraint(equalTo: centerXAnchor),
            empty.centerYAnchor.constraint(equalTo: centerYAnchor),
            empty.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -32),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        content?.frame = bounds
    }

    func pane(_ machine: String, _ address: String) -> TerminalPane {
        let key = machine + "/" + address
        if let pane = panes[key] { return pane }
        let pane = TerminalPane(machine: machine, address: address, connection: model.connection, controller: controller.controller)
        pane.onOpenPath = { [weak self] text in self?.onOpenPath?(machine, address, text) }
        panes[key] = pane
        return pane
    }

    private func build(_ node: Layout.Node, machine: String, path: [Bool]) -> NSView {
        switch node {
        case let .terminal(address):
            return pane(machine, address)
        case let .split(axis, ratio, first, second):
            let view = SplitView(axis: axis, ratio: ratio, first: build(first, machine: machine, path: path + [false]),
                                 second: build(second, machine: machine, path: path + [true]))
            view.onRatio = { [weak self] in self?.model.setRatio($0, at: path) }
            return view
        }
    }

    /// The pane holding the keyboard focus, if any.
    func pane(containing view: NSView?) -> TerminalPane? {
        panes.values.first { $0.contains(view) }
    }

    func reattach() {
        panes.values.forEach { $0.attach() }
    }

    func update() {
        let machine = model.selectedMachine
        let layout = model.layout
        let tab = layout.tabs.indices.contains(layout.selected) ? layout.tabs[layout.selected] : nil

        // Panes of terminals that are gone give up their streams.
        var open: Set<String> = []
        for m in model.machines {
            for record in model.store.terminals(of: m.id) where record.isLive { open.insert(m.id + "/" + record.address) }
        }
        for (key, pane) in panes where !open.contains(key) && model.store.backends[pane.machine]?.phase == .ready {
            pane.detach()
            pane.removeFromSuperview()
            panes[key] = nil
        }

        if tab?.root != shown || machine != shownMachine {
            content?.removeFromSuperview()
            content = nil
            if let tab, let machine {
                let view = build(tab.root, machine: machine, path: [])
                addSubview(view)
                view.frame = bounds
                content = view
            }
            shown = tab?.root
            shownMachine = machine
        }
        empty.isHidden = tab != nil
        empty.update(model: model)
        guard let tab, let machine else { return }
        let alone = tab.root.terminals.count == 1
        for address in tab.root.terminals {
            let pane = pane(machine, address)
            pane.isAlone = alone
            pane.isFocusedPane = address == tab.focused
        }
        // The focus follows the layout unless the user is in another field.
        if window?.firstResponder is NSText { return }
        if self.pane(containing: window?.firstResponder as? NSView)?.address != tab.focused {
            pane(machine, tab.focused).takeFocus()
        }
    }
}

/// What the pane area shows without a terminal: why, and what to do.
final class EmptyView: NSView {
    private let title = NSTextField(labelWithString: "")
    private let hint = NSTextField(wrappingLabelWithString: "")

    init() {
        super.init(frame: .zero)
        title.font = .systemFont(ofSize: 15, weight: .medium)
        title.textColor = Theme.foreground
        hint.font = Theme.font
        hint.textColor = Theme.muted
        hint.alignment = .center
        let stack = NSStackView(views: [title, hint])
        stack.orientation = .vertical
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    func update(model: AppModel) {
        title.stringValue = tr("empty.title")
        guard let machine = model.selectedMachine else {
            hint.stringValue = ""
            return
        }
        switch model.backend(of: machine) {
        case let state? where state.phase == .ready:
            hint.stringValue = tr("empty.hint")
        case let state? where state.phase == .error:
            hint.stringValue = tr("backend." + state.code)
        default:
            hint.stringValue = tr("backend.starting")
        }
    }
}
