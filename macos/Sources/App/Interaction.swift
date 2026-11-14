import AppKit
import TermKit

/// Follows a drag inside the main window, as the web UI's drags do: after
/// the pointer moved a few points, `target` names what lies under it (a
/// rectangle of the content view to mark and what a drop there does); on
/// release the last target's action runs. False when the button came up
/// without a drag: the press was a click.
enum DragTracker {
    @discardableResult
    static func track(_ event: NSEvent, target: (NSPoint) -> (NSRect, () -> Void)?) -> Bool {
        guard let window = event.window, let content = window.contentView else { return false }
        let start = event.locationInWindow
        let marker = FillView(Theme.focusRing.withAlphaComponent(0.25))
        marker.layer?.cornerRadius = Theme.radius
        marker.layer?.borderWidth = 1
        var dragging = false
        var drop: (() -> Void)?
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            let p = next.locationInWindow
            if next.type == .leftMouseUp { break }
            if !dragging, hypot(p.x - start.x, p.y - start.y) < 4 { continue }
            if !dragging {
                dragging = true
                NSCursor.closedHand.push()
            }
            let point = content.convert(p, from: nil)
            if let (rect, action) = target(point) {
                if marker.superview == nil { content.addSubview(marker, positioned: .above, relativeTo: nil) }
                marker.frame = rect
                marker.layer?.borderColor = Theme.focusRing.cgColor
                drop = action
            } else {
                marker.removeFromSuperview()
                drop = nil
            }
        }
        marker.removeFromSuperview()
        if dragging { NSCursor.pop() }
        drop?()
        return dragging
    }
}

/// Short messages at the bottom of the main window, some with a button,
/// as the web UI's toasts.
final class Toasts: NSView {
    private let stack = NSStackView()

    init() {
        super.init(frame: .zero)
        stack.orientation = .vertical
        stack.spacing = 6
        stack.alignment = .centerX
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor), stack.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit === self || hit === stack ? nil : hit
    }

    /// Shows a message for `ttl` seconds (5, 15 with a button); returns a
    /// function that removes it.
    @discardableResult
    func show(_ message: String, button: String? = nil, ttl: TimeInterval? = nil, action: (() -> Void)? = nil) -> () -> Void {
        let toast = FillView(Theme.tabActive)
        toast.layer?.cornerRadius = Theme.radius
        toast.layer?.borderWidth = 1
        toast.layer?.borderColor = Theme.border.cgColor
        toast.layer?.shadowOpacity = 0.15
        toast.layer?.shadowRadius = 6
        let label = NSTextField(wrappingLabelWithString: message)
        label.font = Theme.font
        label.textColor = Theme.foreground
        label.preferredMaxLayoutWidth = 460
        let row = NSStackView(views: [label])
        row.spacing = 10
        row.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        let remove = { [weak toast] () -> Void in toast?.removeFromSuperview() }
        if let button, let action {
            let b = ClosureButton(title: button) {
                remove()
                action()
            }
            b.bezelStyle = .rounded
            b.controlSize = .small
            row.addArrangedSubview(b)
        }
        row.translatesAutoresizingMaskIntoConstraints = false
        toast.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: toast.topAnchor), row.bottomAnchor.constraint(equalTo: toast.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: toast.leadingAnchor), row.trailingAnchor.constraint(equalTo: toast.trailingAnchor),
        ])
        stack.addArrangedSubview(toast)
        while stack.arrangedSubviews.count > 4 { stack.arrangedSubviews.first?.removeFromSuperview() }
        DispatchQueue.main.asyncAfter(deadline: .now() + (ttl ?? (button == nil ? 5 : 15)), execute: remove)
        return remove
    }
}

/// A button that runs a closure.
final class ClosureButton: NSButton {
    private var run: () -> Void

    init(title: String = "", symbol: String? = nil, tip: String? = nil, run: @escaping () -> Void) {
        self.run = run
        super.init(frame: .zero)
        self.title = title
        if let symbol {
            image = NSImage(systemSymbolName: symbol, accessibilityDescription: tip)
            isBordered = false
            imagePosition = .imageOnly
            contentTintColor = Theme.muted
        }
        toolTip = tip
        target = self
        action = #selector(pressed)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    @objc private func pressed() { run() }
}

/// A menu whose items run closures.
final class ClosureMenu: NSMenu {
    private var actions: [() -> Void] = []

    @discardableResult
    func item(_ title: String, symbol: String? = nil, enabled: Bool = true, _ run: @escaping () -> Void) -> NSMenuItem {
        let item = addItem(withTitle: title, action: enabled ? #selector(pick(_:)) : nil, keyEquivalent: "")
        item.target = self
        item.tag = actions.count
        if let symbol { item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) }
        actions.append(run)
        return item
    }

    func separator() {
        if let last = items.last, !last.isSeparatorItem { addItem(.separator()) }
    }

    @objc private func pick(_ sender: NSMenuItem) { actions[sender.tag]() }
}

/// The sheets of the main window that ask for names and confirmations:
/// workspaces, tabs and panes. Closing a pane or tab asks when a program
/// runs in it (Activity.runningPrograms), closing a workspace always, as in
/// the web UI.
final class Dialogs {
    private let model: AppModel
    weak var window: NSWindow?

    init(model: AppModel, window: NSWindow) {
        self.model = model
        self.window = window
    }

    /// What to call a workspace: its name, else the word for one.
    static func name(of workspace: Layout.Workspace) -> String {
        workspace.name.isEmpty ? tr("workspace.default") : workspace.name
    }

    static func field(_ placeholder: String, _ value: String = "") -> NSTextField {
        let field = NSTextField(string: value)
        field.placeholderString = placeholder
        field.widthAnchor.constraint(equalToConstant: 280).isActive = true
        return field
    }

    /// A sheet with a labelled field per row; `done` runs when confirmed.
    func ask(_ title: String, info: String? = nil, rows: [(String, NSTextField)], confirm: String, done: @escaping () -> Void) {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = title
        if let info { alert.informativeText = info }
        alert.addButton(withTitle: confirm)
        alert.addButton(withTitle: tr("workspace.cancel"))
        let grid = NSGridView(views: rows.map { [NSTextField(labelWithString: $0.0), $0.1] })
        grid.rowSpacing = 8
        grid.column(at: 0).xPlacement = .trailing
        grid.frame.size = grid.fittingSize
        alert.accessoryView = grid
        alert.window.initialFirstResponder = rows.first?.1
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn { done() }
        }
    }

    /// Asks before something that cannot be undone; Return cancels.
    func confirm(_ title: String, info: String?, button: String, then: @escaping () -> Void) {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = title
        if let info { alert.informativeText = info }
        alert.addButton(withTitle: button).hasDestructiveAction = true
        alert.addButton(withTitle: tr("workspace.cancel")).keyEquivalent = "\r"
        alert.buttons.first?.keyEquivalent = ""
        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn { then() }
        }
    }

    private func machineLabel(_ machine: String) -> String { model.machines.first { $0.id == machine }?.label ?? machine }

    // MARK: - Workspaces

    func createWorkspace(on machine: String) {
        let name = Self.field(tr("workspace.namePlaceholder"))
        let cwd = Self.field(tr("workspace.cwdPlaceholder"))
        ask(tr("workspace.newTitle", machineLabel(machine)), rows: [(tr("workspace.name"), name), (tr("workspace.cwd"), cwd)],
            confirm: tr("workspace.create")) { [weak self] in
            let trim = { (field: NSTextField) in field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) }
            self?.model.newWorkspace(name: trim(name), cwd: trim(cwd), on: machine)
        }
    }

    private func workspace(_ id: String, on machine: String) -> Layout.Workspace? {
        model.layout(of: machine)?.workspaces.first { $0.id == id }
    }

    func renameWorkspace(_ id: String, on machine: String) {
        guard let workspace = workspace(id, on: machine) else { return }
        let name = Self.field(tr("workspace.default"), workspace.name)
        ask(tr("workspace.renameTitle"), rows: [(tr("workspace.name"), name)], confirm: tr("workspace.rename")) { [weak self] in
            let text = name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { self?.model.renameWorkspace(id, to: text, on: machine) }
        }
    }

    func closeWorkspace(_ id: String, on machine: String) {
        guard let workspace = workspace(id, on: machine) else { return }
        let live = Set(model.store.terminals(of: machine).filter(\.isLive).map(\.address))
        let count = workspace.terminals.filter(live.contains).count
        confirm(tr("workspace.closeTitle", Self.name(of: workspace)), info: count > 0 ? tr("workspace.closeInfo", String(count)) : nil,
                button: tr("workspace.close")) { [weak self] in self?.model.closeWorkspace(id, on: machine) }
    }

    // MARK: - Tabs and panes

    /// Renames a tab of the selected workspace; an empty name gives it its
    /// terminal's again.
    func renameTab(_ index: Int) {
        guard let machine = model.selectedMachine, let workspace = model.layout.selectedWorkspace,
              workspace.tabs.indices.contains(index) else { return }
        let tab = workspace.tabs[index]
        let name = Self.field(model.store.terminal(tab.focused, on: machine)?.displayName ?? "", tab.name ?? "")
        ask(tr("tab.renameTitle"), info: tr("tab.renameInfo"), rows: [(tr("workspace.name"), name)], confirm: tr("workspace.rename")) { [weak self] in
            self?.model.renameTab(index, in: workspace.id, to: name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    /// Names a terminal's pane (its "name" label); empty shows its title again.
    func renamePane(_ address: String) {
        guard let machine = model.selectedMachine else { return }
        let record = model.store.terminal(address, on: machine)
        let name = Self.field(record?.title ?? "", record?.paneName ?? "")
        ask(tr("pane.renameTitle"), info: tr("tab.renameInfo"), rows: [(tr("workspace.name"), name)], confirm: tr("workspace.rename")) { [weak self] in
            self?.model.renamePane(address, to: name.stringValue.trimmingCharacters(in: .whitespacesAndNewlines), on: machine)
        }
    }

    /// Closes the terminals after asking when programs run in them.
    private func closing(_ addresses: [String], title: String, then: @escaping () -> Void) {
        guard let machine = model.selectedMachine else { return }
        let running = Activity.runningPrograms(addresses.map { model.store.terminal($0, on: machine) })
        if running.isEmpty { return then() }
        confirm(title, info: tr("confirm.programs", running.joined(separator: ", ")), button: tr("workspace.close"), then: then)
    }

    func closePane(_ address: String) {
        closing([address], title: tr("confirm.closePane")) { [weak self] in self?.model.closePane(address) }
    }

    func closeTab(_ index: Int) {
        guard let workspace = model.layout.selectedWorkspace, workspace.tabs.indices.contains(index) else { return }
        closing(workspace.tabs[index].root.terminals, title: tr("confirm.closeTab")) { [weak self] in
            self?.model.closeTab(index, in: workspace.id)
        }
    }
}
