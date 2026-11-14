import AppKit
import TermKit

/// The command palette, as the web UI's: a field and the entries that match
/// what is typed (fuzzyMatch over the label and hint); ↑ ↓ choose, Return
/// runs, Escape closes. It shows in a sheet of the main window.
final class Palette: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate {
    struct Item {
        var label: String
        var hint: String = ""
        var dot: NSColor?
        var run: () -> Void
    }

    private weak var parent: NSWindow?
    private var panel: NSWindow?
    private let field = NSTextField()
    private let table = NSTableView()
    private var items: [Item] = []
    private var shown: [Item] = []

    init(parent: NSWindow) {
        self.parent = parent
    }

    var isOpen: Bool { panel != nil }

    func show(placeholder: String, items: [Item]) {
        close()
        guard let parent else { return }
        self.items = items
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 360), styleMask: [.titled], backing: .buffered, defer: false)
        field.placeholderString = placeholder
        field.stringValue = ""
        field.font = .systemFont(ofSize: 15)
        field.delegate = self
        field.focusRingType = .none
        field.bezelStyle = .roundedBezel
        let column = NSTableColumn(identifier: .init("item"))
        if table.tableColumns.isEmpty { table.addTableColumn(column) }
        table.headerView = nil
        table.rowHeight = 26
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(runSelected)
        table.style = .plain
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let root = NSView()
        for view in [field, scroll] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(view)
        }
        NSLayoutConstraint.activate([
            field.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
            field.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            field.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            scroll.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 8),
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -6),
        ])
        panel.contentView = root
        panel.initialFirstResponder = field
        self.panel = panel
        filter()
        parent.beginSheet(panel)
        panel.makeFirstResponder(field)
    }

    #if DEBUG
        /// Development: types into the palette's field.
        func debugType(_ text: String) {
            field.stringValue = text
            filter()
        }
    #endif

    func close() {
        guard let panel else { return }
        self.panel = nil
        parent?.endSheet(panel)
    }

    private func filter() {
        let query = field.stringValue.trimmingCharacters(in: .whitespaces)
        shown = query.isEmpty ? items : items.filter { fuzzyMatch(query, $0.label + " " + $0.hint) }
        table.reloadData()
        if !shown.isEmpty { table.selectRowIndexes([0], byExtendingSelection: false) }
    }

    @objc private func runSelected() {
        let row = table.selectedRow
        guard shown.indices.contains(row) else { return }
        let item = shown[row]
        close()
        DispatchQueue.main.async { item.run() }
    }

    func controlTextDidChange(_: Notification) { filter() }

    func control(_: NSControl, textView _: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.moveDown(_:)), #selector(NSResponder.moveUp(_:)):
            guard !shown.isEmpty else { return true }
            let step = selector == #selector(NSResponder.moveDown(_:)) ? 1 : -1
            let row = min(max(table.selectedRow + step, 0), shown.count - 1)
            table.selectRowIndexes([row], byExtendingSelection: false)
            table.scrollRowToVisible(row)
        case #selector(NSResponder.insertNewline(_:)): runSelected()
        case #selector(NSResponder.cancelOperation(_:)): close()
        default: return false
        }
        return true
    }

    func numberOfRows(in _: NSTableView) -> Int { shown.count }

    func tableView(_: NSTableView, viewFor _: NSTableColumn?, row: Int) -> NSView? {
        let item = shown[row]
        let dot = FillView(item.dot ?? .clear)
        dot.layer?.cornerRadius = 3
        let label = NSTextField(labelWithString: item.label)
        label.lineBreakMode = .byTruncatingTail
        label.font = Theme.font
        let hint = NSTextField(labelWithString: item.hint)
        hint.font = Theme.fontSmall
        hint.textColor = Theme.muted
        hint.setContentCompressionResistancePriority(.required, for: .horizontal)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let cell = NSView()
        for view in [dot, label, hint] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(view)
        }
        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 12), dot.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 6), dot.heightAnchor.constraint(equalToConstant: 6),
            label.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 8), label.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            hint.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 12),
            hint.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -12), hint.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }
}
