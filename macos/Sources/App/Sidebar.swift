import AppKit
import TermKit

/// A row of the sidebar: a machine, one of its workspaces, a terminal or a
/// program window.
private enum SidebarItem: Equatable {
    /// The agents' inbox: how many work and wait, then those that wait.
    case agents(working: Int, waiting: Int)
    case agent(Activity.Item)
    case machine(Machine)
    case workspace(machine: String, workspace: Layout.Workspace, index: Int, selected: Bool)
    /// A terminal, inside a workspace or not.
    case terminal(machine: String, record: TerminalRecord, inWorkspace: Bool)
    /// A program window, under the terminal its program runs in (level 2
    /// or 3) or under its machine (level 1).
    case program(ProgramWindow, level: Int)
}

/// A table whose context menu is built for the row clicked.
private final class MenuTable: NSTableView {
    var menuForRow: ((Int) -> NSMenu?)?

    override func menu(for event: NSEvent) -> NSMenu? {
        let row = self.row(at: convert(event.locationInWindow, from: nil))
        return menuForRow?(row)
    }
}

/// Machines, their workspaces and their terminals. Folders dropped on it
/// become workspaces on the local machine.
final class SidebarView: NSView, NSTableViewDataSource, NSTableViewDelegate {
    private let model: AppModel
    private let table = MenuTable()
    private var items: [SidebarItem] = []
    /// A program window was chosen.
    var onProgram: ((ProgramWindow) -> Void)?
    /// Folders were dropped (paths on this Mac).
    var onFolders: (([String]) -> Void)?
    var dialogs: Dialogs?
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
        table.doubleAction = #selector(doubleClicked)
        table.refusesFirstResponder = true
        table.menuForRow = { [weak self] row in self?.menu(row) }
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
        registerForDraggedTypes([.fileURL])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    func update() {
        var next: [SidebarItem] = []
        let attention = model.attention
        if !attention.isEmpty {
            let waiting = attention.filter { $0.status == "blocked" || $0.status == "done" }
            next.append(.agents(working: attention.filter { $0.status == "working" }.count, waiting: waiting.count))
            next += waiting.map { .agent($0) }
        }
        for machine in model.machines {
            next.append(.machine(machine))
            let live = model.store.terminals(of: machine.id).filter(\.isLive)
            let programs = model.programs.filter { $0.machine == machine.id }
            var placed: Set<String> = []
            // A terminal, then the windows of the programs it runs.
            func add(_ record: TerminalRecord, inWorkspace: Bool) {
                placed.insert(record.address)
                next.append(.terminal(machine: machine.id, record: record, inWorkspace: inWorkspace))
                for program in programs where program.terminal == record.address {
                    next.append(.program(program, level: inWorkspace ? 3 : 2))
                }
            }
            if let layout = model.layout(of: machine.id) {
                for (index, workspace) in layout.workspaces.enumerated() {
                    next.append(.workspace(machine: machine.id, workspace: workspace, index: index,
                                           selected: machine.id == model.selectedMachine && index == layout.selected))
                    for address in workspace.terminals {
                        guard let record = live.first(where: { $0.address == address }) else { continue }
                        add(record, inWorkspace: true)
                    }
                }
            }
            // Terminals no workspace shows, such as those another client started.
            for record in live where !placed.contains(record.address) {
                add(record, inWorkspace: false)
            }
            for program in programs where !placed.contains(program.terminal) {
                next.append(.program(program, level: 1))
            }
        }
        items = next
        table.rowHeight = Theme.rowHeight
        table.reloadData()
    }

    func numberOfRows(in _: NSTableView) -> Int { items.count }

    func tableView(_: NSTableView, viewFor _: NSTableColumn?, row: Int) -> NSView? {
        let cell = SidebarRow()
        let readOnly = model.readOnly
        switch items[row] {
        case let .agents(working, waiting):
            let counts = [working > 0 ? tr("sidebar.working", String(working)) : nil, waiting > 0 ? tr("sidebar.waiting", String(waiting)) : nil]
            cell.configure(title: tr("sidebar.agents"), detail: counts.compactMap { $0 }.joined(separator: " · "), dot: nil, level: 0,
                           strong: true, selected: false, action: nil)
        case let .agent(item):
            let machine = model.machines.first { $0.id == item.machine }?.label ?? item.machine
            cell.configure(title: (item.record.agent ?? item.record.displayName) + " · " + tr("status." + item.status),
                           detail: machine, dot: Theme.status(item.status), level: 1, strong: false, selected: false, action: nil)
            cell.toolTip = [machine, item.record.displayName, (item.record.cwd as NSString).abbreviatingWithTildeInPath].joined(separator: " · ")
        case let .machine(machine):
            var detail = ""
            if machine.status != "ready" {
                detail = tr("machine." + machine.status)
            } else if let state = model.backend(of: machine.id) ?? machine.hc, state.phase == .error {
                detail = tr("backend." + state.code)
            } else if case let waiting = model.store.attention(of: machine.id), waiting > 0 {
                // Agents that are blocked or finished a turn nobody saw.
                detail = tr("sidebar.waiting", String(waiting))
            }
            // A connected machine's button opens a terminal; the others' sign
            // in, retry or enable it.
            if readOnly {
                cell.configure(title: machine.label, detail: detail, dot: nil, level: 0, strong: true, selected: false, action: nil)
            } else if machine.status == "ready" {
                cell.configure(title: machine.label, detail: detail, dot: nil, level: 0, strong: true, selected: false) { [weak self] in
                    self?.model.newTerminal(on: machine.id)
                }
                cell.setAccessibilityLabel(tr("sidebar.newTerminal", machine.label))
            } else if let (symbol, tip, run) = machineDialogs?.rowAction(machine) {
                cell.configure(title: machine.label, detail: detail, dot: nil, level: 0, strong: true, selected: false, symbol: symbol, action: run)
                cell.setAccessibilityLabel(tip)
            } else {
                cell.configure(title: machine.label, detail: detail, dot: nil, level: 0, strong: true, selected: false, action: nil)
            }
            cell.toolTip = [detail, machine.error].filter { !$0.isEmpty }.joined(separator: "\n")
        case let .workspace(machine, workspace, _, selected):
            let name = Dialogs.name(of: workspace)
            cell.configure(title: name, detail: (workspace.cwd as NSString).abbreviatingWithTildeInPath, dot: nil, level: 1,
                           strong: selected, selected: false,
                           action: readOnly ? nil : { [weak self] in self?.model.newTerminal(on: machine, in: workspace.id) })
            cell.toolTip = workspace.cwd.isEmpty ? nil : workspace.cwd
            cell.setAccessibilityLabel(tr("sidebar.newTerminalIn", name))
        case let .terminal(machine, record, inWorkspace):
            let focused = machine == model.selectedMachine && model.focusedTerminal == record.address
            cell.configure(title: record.displayName, detail: (record.cwd as NSString).abbreviatingWithTildeInPath,
                           dot: Theme.status(Activity.status(record)), level: inWorkspace ? 2 : 1, strong: false, selected: focused, action: nil)
            cell.toolTip = [record.agent, Activity.status(record).map { tr("status." + $0) }].compactMap { $0 }.joined(separator: " · ")
        case let .program(program, level):
            cell.configure(title: program.title.isEmpty ? tr("sidebar.window") : program.title, detail: tr("sidebar.window"),
                           dot: nil, level: level, strong: false, selected: false, action: nil)
        }
        return cell
    }

    @objc private func clicked() {
        guard items.indices.contains(table.clickedRow) else { return }
        switch items[table.clickedRow] {
        case .agents: break
        case let .agent(item): model.open(item.terminal, on: item.machine)
        case let .machine(machine): model.select(machine: machine.id)
        case let .workspace(machine, workspace, _, _): model.selectWorkspace(workspace.id, on: machine)
        case let .terminal(machine, record, _): model.open(record.address, on: machine)
        case let .program(program, _): onProgram?(program)
        }
    }

    @objc private func doubleClicked() {
        guard items.indices.contains(table.clickedRow), !model.readOnly,
              case let .workspace(machine, workspace, _, _) = items[table.clickedRow] else { return }
        dialogs?.renameWorkspace(workspace.id, on: machine)
    }

    // MARK: - Menus

    private func menu(_ row: Int) -> NSMenu? {
        let menu = ClosureMenu()
        guard !model.readOnly else { return nil }
        guard items.indices.contains(row) else {
            machineDialogs?.addItems(to: menu)
            return menu.items.isEmpty ? nil : menu
        }
        switch items[row] {
        case let .machine(machine):
            machineDialogs?.items(for: machine, in: menu, dialogs: dialogs)
        case let .workspace(machine, workspace, index, _):
            let count = model.layout(of: machine)?.workspaces.count ?? 0
            menu.item(tr("menu.newTerminal"), symbol: "plus") { [weak self] in self?.model.newTerminal(on: machine, in: workspace.id) }
            menu.separator()
            menu.item(tr("menu.renameWorkspace"), symbol: "pencil") { [weak self] in self?.dialogs?.renameWorkspace(workspace.id, on: machine) }
            menu.item(tr("menu.moveUp"), symbol: "arrow.up", enabled: index > 0) { [weak self] in
                self?.model.moveWorkspace(workspace.id, by: -1, on: machine)
            }
            menu.item(tr("menu.moveDown"), symbol: "arrow.down", enabled: index < count - 1) { [weak self] in
                self?.model.moveWorkspace(workspace.id, by: 1, on: machine)
            }
            menu.separator()
            menu.item(tr("menu.closeWorkspace"), symbol: "xmark") { [weak self] in self?.dialogs?.closeWorkspace(workspace.id, on: machine) }
        case let .terminal(machine, record, _):
            // Shells started before the machine's display existed get it
            // typed in (remote machines only: the local one has its own).
            if model.machines.first(where: { $0.id == machine })?.kind == "ssh" {
                menu.item(tr("menu.enableWindows")) { [weak self] in self?.machineDialogs?.enableWindows(record.address, on: machine) }
                menu.separator()
            }
            menu.item(tr("sidebar.kill"), symbol: "xmark") { [weak self] in self?.model.kill(record.address, on: machine) }
        case .program, .agents, .agent:
            return nil
        }
        return menu.items.isEmpty ? nil : menu
    }

    // MARK: - Folders dropped

    private func folders(_ info: NSDraggingInfo) -> [URL] {
        (info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        model.readOnly || folders(sender).isEmpty ? [] : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = folders(sender)
        guard !urls.isEmpty, !model.readOnly else { return false }
        onFolders?(urls.map(\.path))
        return true
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
    /// a workspace or a window of a terminal, 3 a window of a terminal of a
    /// workspace.
    func configure(title text: String, detail detailText: String, dot color: NSColor?, level: Int, strong: Bool, selected: Bool,
                   symbol: String = "plus", action: (() -> Void)?) {
        add.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
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
