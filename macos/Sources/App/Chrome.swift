import AppKit
import GhosttyTerminal
import TermKit

/// The one Ghostty controller of the application, configured from the
/// theme; its colors follow the system's appearance.
@MainActor
final class TerminalControllerBox {
    let controller: TerminalController

    /// The shortcuts of the menu (main.swift), as Ghostty names keys.
    static let menuKeys = [
        "super+t", "super+d", "super+shift+d", "super+w", "super+f", "super+g", "super+shift+g",
        "super+j", "super+b", "super+comma", "super+,", "super+shift+right_bracket", "super+shift+left_bracket",
        "super+n", "super+q", "super+h", "super+m",
    ]

    init() {
        func colors(dark: Bool) -> TerminalConfiguration {
            let colors = Theme.terminalColors(dark: dark)
            return TerminalConfiguration { builder in
                builder.withBackground(colors.background)
                builder.withForeground(colors.foreground)
                builder.withCursorColor(colors.cursor)
                builder.withSelectionBackground(colors.selection)
                for (index, color) in colors.palette.enumerated() {
                    builder.withPalette(index, color: color)
                }
            }
        }
        controller = TerminalController(theme: TerminalTheme(light: colors(dark: false), dark: colors(dark: true))) { builder in
            // The keys of the application's menu. Ghostty binds most of them
            // by default, and a terminal with the keyboard takes its bound
            // keys before the menu sees them; unbound, they reach the menu.
            for key in Self.menuKeys {
                builder.withCustom("keybind", key + "=unbind")
            }
            builder.withFontSize(Theme.terminalFontSize)
            builder.withWindowPaddingX(8)
            builder.withWindowPaddingY(6)
        }
    }
}

/// A row of the sidebar: a machine, or a terminal on one.
private enum SidebarItem: Equatable {
    case machine(Machine)
    case terminal(machine: String, record: TerminalRecord)
    case program(ProgramWindow)
}

/// Machines and their terminals.
final class SidebarView: NSView, NSTableViewDataSource, NSTableViewDelegate {
    private let model: AppModel
    private let table = NSTableView()
    private var items: [SidebarItem] = []
    /// A program window was chosen.
    var onProgram: ((ProgramWindow) -> Void)?

    init(model: AppModel) {
        self.model = model
        super.init(frame: .zero)
        let background = FillView(Theme.sidebar)
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        let column = NSTableColumn(identifier: .init("item"))
        table.addTableColumn(column)
        table.headerView = nil
        table.backgroundColor = .clear
        table.style = .plain
        table.selectionHighlightStyle = .none
        table.intercellSpacing = .zero
        table.rowHeight = Theme.rowHeight
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(clicked)
        table.refusesFirstResponder = true
        let menu = NSMenu()
        menu.delegate = self
        table.menu = menu
        let border = FillView(Theme.border)
        for view in [background, scroll, border] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            background.topAnchor.constraint(equalTo: topAnchor), background.bottomAnchor.constraint(equalTo: bottomAnchor),
            background.leadingAnchor.constraint(equalTo: leadingAnchor), background.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor, constant: 4), scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor), scroll.trailingAnchor.constraint(equalTo: border.leadingAnchor),
            border.topAnchor.constraint(equalTo: topAnchor), border.bottomAnchor.constraint(equalTo: bottomAnchor),
            border.trailingAnchor.constraint(equalTo: trailingAnchor), border.widthAnchor.constraint(equalToConstant: Theme.divider),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    func update() {
        var next: [SidebarItem] = []
        for machine in model.machines {
            next.append(.machine(machine))
            for record in model.store.terminals(of: machine.id) where record.isLive {
                next.append(.terminal(machine: machine.id, record: record))
            }
            for program in model.programs where program.machine == machine.id {
                next.append(.program(program))
            }
        }
        items = next
        table.reloadData()
    }

    func numberOfRows(in _: NSTableView) -> Int { items.count }

    private func focused(_ machine: String) -> String? {
        guard machine == model.selectedMachine else { return nil }
        let layout = model.layout
        return layout.tabs.indices.contains(layout.selected) ? layout.tabs[layout.selected].focused : nil
    }

    func tableView(_: NSTableView, viewFor _: NSTableColumn?, row: Int) -> NSView? {
        let cell = SidebarRow()
        switch items[row] {
        case let .machine(machine):
            var detail = ""
            if machine.status != "ready", machine.status != "degraded" {
                detail = tr("machine." + machine.status)
            } else if let state = model.backend(of: machine.id), state.phase == .error {
                detail = tr("backend." + state.code)
            }
            cell.configure(title: machine.label, detail: detail, dot: nil, heading: true, selected: false) { [weak self] in
                self?.model.newTerminal(on: machine.id)
            }
            cell.toolTip = detail.isEmpty ? nil : detail
            cell.setAccessibilityLabel(tr("sidebar.newTerminal", machine.label))
        case let .terminal(machine, record):
            cell.configure(title: record.displayName, detail: (record.cwd as NSString).abbreviatingWithTildeInPath,
                           dot: Theme.status(record.status), heading: false, selected: focused(machine) == record.address, action: nil)
            cell.toolTip = record.status.map { tr("status." + $0) }
        case let .program(program):
            cell.configure(title: program.title.isEmpty ? tr("sidebar.window") : program.title, detail: tr("sidebar.window"),
                           dot: nil, heading: false, selected: false, action: nil)
        }
        return cell
    }

    @objc private func clicked() {
        guard items.indices.contains(table.clickedRow) else { return }
        switch items[table.clickedRow] {
        case let .machine(machine): model.select(machine: machine.id)
        case let .terminal(machine, record): model.open(record.address, on: machine)
        case let .program(program): onProgram?(program)
        }
    }
}

extension SidebarView: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard items.indices.contains(table.clickedRow) else { return }
        switch items[table.clickedRow] {
        case let .machine(machine):
            let item = menu.addItem(withTitle: tr("menu.newTerminal"), action: #selector(menuNew(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = machine.id
        case let .terminal(machine, record):
            let item = menu.addItem(withTitle: tr("sidebar.kill"), action: #selector(menuKill(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = [machine, record.address]
        case .program:
            break
        }
    }

    @objc private func menuNew(_ sender: NSMenuItem) {
        if let machine = sender.representedObject as? String { model.newTerminal(on: machine) }
    }

    @objc private func menuKill(_ sender: NSMenuItem) {
        if let pair = sender.representedObject as? [String], pair.count == 2 { model.kill(pair[1], on: pair[0]) }
    }
}

private final class SidebarRow: NSView {
    private let title = NSTextField(labelWithString: "")
    private let detail = NSTextField(labelWithString: "")
    private let dot = FillView(.clear)
    private let add = NSButton(title: "", target: nil, action: nil)
    private let highlight = FillView(.clear)
    private var action: (() -> Void)?

    init() {
        super.init(frame: .zero)
        highlight.wantsLayer = true
        highlight.layer?.cornerRadius = Theme.radius
        highlight.layer?.masksToBounds = true
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        dot.layer?.masksToBounds = true
        title.lineBreakMode = .byTruncatingTail
        detail.lineBreakMode = .byTruncatingHead
        detail.font = Theme.fontSmall
        detail.textColor = Theme.muted
        detail.setContentCompressionResistancePriority(.defaultLow - 1, for: .horizontal)
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        add.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)
        add.isBordered = false
        add.contentTintColor = Theme.muted
        add.target = self
        add.action = #selector(pressed)
        for view in [highlight, dot, title, detail, add] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            highlight.topAnchor.constraint(equalTo: topAnchor, constant: 1), highlight.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -1),
            highlight.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6), highlight.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16), dot.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 6), dot.heightAnchor.constraint(equalToConstant: 6),
            title.centerYAnchor.constraint(equalTo: centerYAnchor),
            detail.leadingAnchor.constraint(greaterThanOrEqualTo: title.trailingAnchor, constant: 8),
            detail.centerYAnchor.constraint(equalTo: centerYAnchor),
            detail.trailingAnchor.constraint(equalTo: add.leadingAnchor, constant: -4),
            add.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10), add.centerYAnchor.constraint(equalTo: centerYAnchor),
            add.widthAnchor.constraint(equalToConstant: 18),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    private var leading: NSLayoutConstraint?

    func configure(title text: String, detail detailText: String, dot color: NSColor?, heading: Bool, selected: Bool, action: (() -> Void)?) {
        title.stringValue = text
        title.font = heading ? Theme.fontStrong : Theme.font
        title.textColor = heading ? Theme.muted : Theme.foreground
        detail.stringValue = detailText
        dot.fill = color ?? .clear
        add.isHidden = action == nil
        self.action = action
        highlight.fill = selected ? Theme.accent : .clear
        leading?.isActive = false
        leading = title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: heading ? 14 : 30)
        leading?.isActive = true
    }

    @objc private func pressed() { action?() }
}

/// The tabs of the selected machine.
final class TabBar: NSView {
    private let model: AppModel
    private let stack = NSStackView()

    init(model: AppModel) {
        self.model = model
        super.init(frame: .zero)
        let background = FillView(Theme.tabBar)
        let border = FillView(Theme.border)
        stack.orientation = .horizontal
        stack.spacing = 2
        stack.alignment = .centerY
        for view in [background, stack, border] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Theme.tabHeight),
            background.topAnchor.constraint(equalTo: topAnchor), background.bottomAnchor.constraint(equalTo: bottomAnchor),
            background.leadingAnchor.constraint(equalTo: leadingAnchor), background.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6), stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -6),
            border.bottomAnchor.constraint(equalTo: bottomAnchor), border.heightAnchor.constraint(equalToConstant: Theme.divider),
            border.leadingAnchor.constraint(equalTo: leadingAnchor), border.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    func update() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard let machine = model.selectedMachine else { return }
        let layout = model.layout
        for (index, tab) in layout.tabs.enumerated() {
            let record = model.store.terminal(tab.focused, on: machine)
            let button = TabButton(title: record?.displayName ?? tab.focused, dot: Theme.status(record?.status),
                                   selected: index == layout.selected) { [weak self] in self?.model.selectTab(index) }
            stack.addArrangedSubview(button)
        }
        let add = NSButton(image: NSImage(systemSymbolName: "plus", accessibilityDescription: tr("menu.newTerminal"))!,
                           target: self, action: #selector(newTab))
        add.isBordered = false
        add.contentTintColor = Theme.muted
        add.toolTip = tr("menu.newTerminal")
        stack.addArrangedSubview(add)
    }

    @objc private func newTab() { model.newTerminal() }
}

private final class TabButton: NSView {
    private let action: () -> Void

    init(title: String, dot: NSColor?, selected: Bool, action: @escaping () -> Void) {
        self.action = action
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = Theme.radius
        let fill = FillView(selected ? Theme.tabActive : .clear)
        fill.wantsLayer = true
        fill.layer?.cornerRadius = Theme.radius
        fill.layer?.masksToBounds = true
        let label = NSTextField(labelWithString: title)
        label.font = selected ? Theme.fontStrong : Theme.font
        label.textColor = selected ? Theme.foreground : Theme.muted
        label.lineBreakMode = .byTruncatingTail
        let mark = FillView(dot ?? .clear)
        mark.wantsLayer = true
        mark.layer?.cornerRadius = 3
        mark.layer?.masksToBounds = true
        for view in [fill, mark, label] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        let labelLeading = dot == nil ? label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10)
            : label.leadingAnchor.constraint(equalTo: mark.trailingAnchor, constant: 6)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Theme.tabHeight - 8),
            widthAnchor.constraint(lessThanOrEqualToConstant: 200),
            fill.topAnchor.constraint(equalTo: topAnchor), fill.bottomAnchor.constraint(equalTo: bottomAnchor),
            fill.leadingAnchor.constraint(equalTo: leadingAnchor), fill.trailingAnchor.constraint(equalTo: trailingAnchor),
            mark.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10), mark.centerYAnchor.constraint(equalTo: centerYAnchor),
            mark.widthAnchor.constraint(equalToConstant: 6), mark.heightAnchor.constraint(equalToConstant: 6),
            labelLeading, label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func mouseDown(with _: NSEvent) { action() }
}
