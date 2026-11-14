import AppKit
import GhosttyTerminal
import TermKit

/// The one Ghostty controller of the application: its colors follow the
/// terminal.colors.* settings in the light and the dark appearance, the
/// other terminal settings become Ghostty configuration (`apply`).
@MainActor
final class TerminalControllerBox {
    let controller: TerminalController

    /// Keys of the menu that are not commands, as Ghostty names them.
    static let systemKeys = ["super+q", "super+h", "super+m"]

    init() {
        controller = TerminalController(theme: Self.theme(nil)) { builder in
            builder.withFontSize(Theme.terminalFontSize)
            builder.withWindowPaddingX(8)
            builder.withWindowPaddingY(6)
        }
        controller.setTerminalConfiguration(Self.configuration(nil, menuKeys: []))
    }

    static func theme(_ settings: SettingsModel?) -> TerminalTheme {
        func colors(dark: Bool) -> TerminalConfiguration {
            let colors = Theme.terminalColors(dark: dark, settings: settings)
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
        return TerminalTheme(light: colors(dark: false), dark: colors(dark: true))
    }

    /// Ghostty's configuration from the terminal settings, and the menu's
    /// single-stroke keys unbound: a terminal with the keyboard takes the
    /// keys Ghostty binds (most Cmd keys) before the menu sees them.
    static func configuration(_ settings: SettingsModel?, menuKeys: [String]) -> TerminalConfiguration {
        TerminalConfiguration { builder in
            for key in systemKeys + menuKeys.flatMap(Keys.ghosttyTriggers) {
                builder.withCustom("keybind", key + "=unbind")
            }
            guard let s = settings, s.loaded else { return }
            let family = s.string("terminal.fontFamily", "").trimmingCharacters(in: .whitespaces)
            if !family.isEmpty { builder.withFontFamily(family) }
            builder.withFontSize(Float(s.number("terminal.fontSize", Double(Theme.terminalFontSize))))
            builder.withFontThicken(s.string("terminal.fontWeight", "regular") == "medium")
            let extra = Int(((s.number("terminal.lineHeight", 1.05) - 1) * 100).rounded())
            builder.withCustom("adjust-cell-height", "\(extra)%")
            builder.withCursorStyle(TerminalCursorStyle(rawValue: s.string("terminal.cursorStyle", "block")) ?? .block)
            builder.withCursorStyleBlink(s.bool("terminal.cursorBlink", true))
            // Ghostty bounds its scrollback in bytes: about 2 KB a line.
            let lines = max(0, s.number("terminal.scrollback", 10000))
            builder.withCustom("scrollback-limit", String(Int(lines) * 2048))
            builder.withCustom("copy-on-select", s.bool("terminal.copyOnSelect", false) ? "clipboard" : "false")
            builder.withCustom("bold-is-bright", s.bool("terminal.boldIsBright", false) ? "true" : "false")
            builder.withCustom("macos-option-as-alt", s.bool("terminal.optionIsMeta", false) ? "true" : "false")
            let clipboard = ["auto": "allow", "ask": "ask", "off": "deny"][s.string("terminal.programClipboard", "auto")] ?? "allow"
            builder.withCustom("clipboard-write", clipboard)
        }
    }

    /// Applies the settings and the menu's keys to every terminal.
    func apply(_ settings: SettingsModel, menuKeys: [String]) {
        controller.setTheme(Self.theme(settings))
        controller.setTerminalConfiguration(Self.configuration(settings, menuKeys: menuKeys))
    }
}

/// A row of the sidebar: a machine, one of its workspaces, a terminal or a
/// program window.
private enum SidebarItem: Equatable {
    case machine(Machine)
    case workspace(machine: String, workspace: Layout.Workspace, selected: Bool)
    /// A terminal, inside a workspace or not.
    case terminal(machine: String, record: TerminalRecord, inWorkspace: Bool)
    case program(ProgramWindow)
}

/// Machines, their workspaces and their terminals.
final class SidebarView: NSView, NSTableViewDataSource, NSTableViewDelegate {
    private let model: AppModel
    private let table = NSTableView()
    private var items: [SidebarItem] = []
    /// A program window was chosen.
    var onProgram: ((ProgramWindow) -> Void)?
    var dialogs: WorkspaceDialogs?
    var machineDialogs: MachineDialogs?

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
            let live = model.store.terminals(of: machine.id).filter(\.isLive)
            var placed: Set<String> = []
            if let layout = model.layout(of: machine.id) {
                for (index, workspace) in layout.workspaces.enumerated() {
                    next.append(.workspace(machine: machine.id, workspace: workspace,
                                           selected: machine.id == model.selectedMachine && index == layout.selected))
                    for address in workspace.terminals {
                        guard let record = live.first(where: { $0.address == address }) else { continue }
                        placed.insert(address)
                        next.append(.terminal(machine: machine.id, record: record, inWorkspace: true))
                    }
                }
            }
            // Terminals no workspace shows, such as those another client started.
            for record in live where !placed.contains(record.address) {
                next.append(.terminal(machine: machine.id, record: record, inWorkspace: false))
            }
            for program in model.programs where program.machine == machine.id {
                next.append(.program(program))
            }
        }
        items = next
        table.rowHeight = Theme.rowHeight
        table.reloadData()
    }

    func numberOfRows(in _: NSTableView) -> Int { items.count }

    func tableView(_: NSTableView, viewFor _: NSTableColumn?, row: Int) -> NSView? {
        let cell = SidebarRow()
        switch items[row] {
        case let .machine(machine):
            var detail = ""
            if machine.status != "ready" {
                detail = tr("machine." + machine.status)
            } else if let state = model.backend(of: machine.id) ?? machine.hc, state.phase == .error {
                detail = tr("backend." + state.code)
            }
            cell.configure(title: machine.label, detail: detail, dot: nil, level: 0, strong: true, selected: false) { [weak self] in
                self?.model.newTerminal(on: machine.id)
            }
            cell.toolTip = detail.isEmpty ? nil : detail
            cell.setAccessibilityLabel(tr("sidebar.newTerminal", machine.label))
        case let .workspace(machine, workspace, selected):
            let name = WorkspaceDialogs.name(of: workspace)
            cell.configure(title: name, detail: (workspace.cwd as NSString).abbreviatingWithTildeInPath, dot: nil, level: 1,
                           strong: selected, selected: false) { [weak self] in
                self?.model.newTerminal(on: machine, in: workspace.id)
            }
            cell.toolTip = workspace.cwd.isEmpty ? nil : workspace.cwd
            cell.setAccessibilityLabel(tr("sidebar.newTerminalIn", name))
        case let .terminal(machine, record, inWorkspace):
            let focused = machine == model.selectedMachine && model.focusedTerminal == record.address
            cell.configure(title: record.displayName, detail: (record.cwd as NSString).abbreviatingWithTildeInPath,
                           dot: Theme.status(record.status), level: inWorkspace ? 2 : 1, strong: false, selected: focused, action: nil)
            cell.toolTip = record.status.map { tr("status." + $0) }
        case let .program(program):
            cell.configure(title: program.title.isEmpty ? tr("sidebar.window") : program.title, detail: tr("sidebar.window"),
                           dot: nil, level: 1, strong: false, selected: false, action: nil)
        }
        return cell
    }

    @objc private func clicked() {
        guard items.indices.contains(table.clickedRow) else { return }
        switch items[table.clickedRow] {
        case let .machine(machine): model.select(machine: machine.id)
        case let .workspace(machine, workspace, _): model.selectWorkspace(workspace.id, on: machine)
        case let .terminal(machine, record, _): model.open(record.address, on: machine)
        case let .program(program): onProgram?(program)
        }
    }
}

extension SidebarView: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard items.indices.contains(table.clickedRow) else { return }
        func add(_ title: String, _ action: Selector, _ object: Any) {
            let item = menu.addItem(withTitle: title, action: action, keyEquivalent: "")
            item.target = self
            item.representedObject = object
        }
        switch items[table.clickedRow] {
        case let .machine(machine):
            add(tr("menu.newTerminal"), #selector(menuNew(_:)), [machine.id])
            if model.layout(of: machine.id) != nil { add(tr("menu.newWorkspace"), #selector(menuNewWorkspace(_:)), machine.id) }
            // The machine's terminal core: started when it was stopped (or
            // none runs), else restarted (programs keep running) or stopped.
            if machine.status == "ready", !model.settings.readOnly {
                menu.addItem(.separator())
                let code = (model.backend(of: machine.id) ?? machine.hc)?.code
                if code == "stopped" || code == "not_running" {
                    add(tr("menu.startCore"), #selector(menuStartCore(_:)), machine.id)
                } else {
                    add(tr("menu.restartCore"), #selector(menuRestartCore(_:)), machine.id)
                    add(tr("menu.stopCore"), #selector(menuStopCore(_:)), machine.id)
                }
            }
        case let .workspace(machine, workspace, _):
            add(tr("menu.newTerminal"), #selector(menuNew(_:)), [machine, workspace.id])
            menu.addItem(.separator())
            add(tr("menu.renameWorkspace"), #selector(menuRenameWorkspace(_:)), [machine, workspace.id])
            add(tr("menu.closeWorkspace"), #selector(menuCloseWorkspace(_:)), [machine, workspace.id])
        case let .terminal(machine, record, _):
            add(tr("sidebar.kill"), #selector(menuKill(_:)), [machine, record.address])
        case .program:
            break
        }
    }

    /// [machine] or [machine, workspace].
    @objc private func menuNew(_ sender: NSMenuItem) {
        guard let pair = sender.representedObject as? [String], let machine = pair.first else { return }
        model.newTerminal(on: machine, in: pair.count > 1 ? pair[1] : nil)
    }

    @objc private func menuStartCore(_ sender: NSMenuItem) {
        if let machine = sender.representedObject as? String { machineDialogs?.core("start", on: machine) }
    }

    @objc private func menuRestartCore(_ sender: NSMenuItem) {
        if let machine = sender.representedObject as? String { machineDialogs?.core("restart", on: machine) }
    }

    @objc private func menuStopCore(_ sender: NSMenuItem) {
        if let machine = sender.representedObject as? String { machineDialogs?.stopCore(on: machine) }
    }

    @objc private func menuNewWorkspace(_ sender: NSMenuItem) {
        if let machine = sender.representedObject as? String { dialogs?.create(on: machine) }
    }

    @objc private func menuRenameWorkspace(_ sender: NSMenuItem) {
        if let pair = sender.representedObject as? [String], pair.count == 2 { dialogs?.rename(pair[1], on: pair[0]) }
    }

    @objc private func menuCloseWorkspace(_ sender: NSMenuItem) {
        if let pair = sender.representedObject as? [String], pair.count == 2 { dialogs?.close(pair[1], on: pair[0]) }
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
            dot.trailingAnchor.constraint(equalTo: title.leadingAnchor, constant: -8), dot.centerYAnchor.constraint(equalTo: centerYAnchor),
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

    /// `level` 0 is a machine, 1 what is directly under it, 2 a terminal of
    /// a workspace.
    func configure(title text: String, detail detailText: String, dot color: NSColor?, level: Int, strong: Bool, selected: Bool,
                   action: (() -> Void)?) {
        title.stringValue = text
        title.font = strong ? Theme.fontStrong : Theme.font
        title.textColor = level == 0 ? Theme.muted : Theme.foreground
        detail.stringValue = detailText
        dot.fill = color ?? .clear
        add.isHidden = action == nil
        self.action = action
        highlight.fill = selected ? Theme.accent : .clear
        leading?.isActive = false
        leading = title.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14 + 16 * CGFloat(level))
        leading?.isActive = true
    }

    @objc private func pressed() { action?() }
}

/// The tabs of the selected machine's selected workspace.
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
        let workspace = model.layout.selectedWorkspace
        for (index, tab) in (workspace?.tabs ?? []).enumerated() {
            let record = model.store.terminal(tab.focused, on: machine)
            let button = TabButton(title: tab.name ?? record?.displayName ?? tab.focused, dot: Theme.status(record?.status),
                                   selected: index == workspace?.selected) { [weak self] in self?.model.selectTab(index) }
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
