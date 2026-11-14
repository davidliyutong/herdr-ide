import AppKit
import TermKit

/// The state behind the window: machines, their terminals, layouts and
/// program windows, and what the user does with them.
final class AppModel {
    let core: URL
    let connection: TermConnection
    let events: EventConnection
    let store = TerminalStore()
    private(set) var machines: [Machine] = []
    private(set) var selectedMachine: String?
    private var layouts: [String: Layout] = [:]
    private var versions: [String: Int] = [:]
    private var loaded: Set<String> = []
    private var saving: Set<String> = []
    private var dirty: Set<String> = []
    /// The newest version of each machine's layout document an event named.
    private var announced: [String: Int] = [:]
    /// Machines a terminal was asked for before their terminals and layout
    /// were ready.
    private var pendingTerminals: Set<String> = []
    /// Each machine's program windows, as the core last sent them.
    private var windows: [String: [ProgramWindow]] = [:]
    /// The program windows on the machines' virtual displays.
    private(set) var programs: [ProgramWindow] = []
    /// The core's settings and keybindings, kept current by the event channel.
    let settings = SettingsModel()
    let keybindings = KeybindingsModel()
    let api: CoreAPI
    /// The settings or the keybindings changed.
    var onSettings: (() -> Void)?
    var onKeybindings: (() -> Void)?

    /// An agent's status changed; text was sent from VS Code to an agent;
    /// VS Code's explorer asked for a download; a program opened a window.
    var onAgent: ((Activity.AgentEvent) -> Void)?
    var onSend: ((String, String, [String]?) -> Void)?
    var onDownload: ((String, [String]) -> Void)?
    var onNewProgram: ((ProgramWindow) -> Void)?
    /// The event channel (re)connected.
    var onEventsConnected: (() -> Void)?

    /// Something the window shows changed.
    var onChange: (() -> Void)?
    /// The connection to the core's terminals came or went.
    var onConnection: ((Bool) -> Void)?

    init(core: URL) {
        self.core = core
        api = CoreAPI(core: core)
        connection = TermConnection(core: core)
        events = EventConnection(core: core)
        connection.onMessage = { [weak self] in self?.message($0) }
        connection.onConnection = { [weak self] up in
            if !up {
                self?.loaded = []
                self?.saving = []
                self?.dirty = []
            }
            self?.onConnection?(up)
            self?.onChange?()
        }
        events.onEvent = { [weak self] in self?.event($0) }
        // The core sends every machine's windows again on a new connection;
        // settings changed while it was away are read again.
        events.onConnection = { [weak self] up in
            guard up else { return }
            self?.windows = [:]
            self?.loadSettings()
            self?.onEventsConnected?()
        }
    }

    func start() {
        connection.start()
        events.start()
        loadSettings()
    }

    /// Reads the settings and keybindings (the event channel brings their
    /// changes afterwards).
    func loadSettings() {
        api.request("GET", "api/settings") { [weak self] status, reply in
            guard let self, status == 200, let reply else { return }
            self.settings.load(reply)
            self.onSettings?()
        }
        api.request("GET", "api/keybindings") { [weak self] status, reply in
            guard let self, status == 200, let reply else { return }
            self.keybindings.load(reply)
            self.onKeybindings?()
        }
    }

    func stop() {
        events.close()
        connection.close()
    }

    /// The selected machine's layout.
    var layout: Layout { selectedMachine.flatMap { layouts[$0] } ?? Layout() }

    /// A machine's layout, once it was read from the machine.
    func layout(of machine: String) -> Layout? { loaded.contains(machine) ? layouts[machine] : nil }

    func backend(of machine: String) -> BackendState? { store.backends[machine] }

    /// The terminal the selected tab focuses.
    var focusedTerminal: String? { layout.focusedTerminal }

    // MARK: - Machines and program windows

    private func event(_ event: EventConnection.Event) {
        switch event {
        case let .machines(list):
            setMachines(list)
        case let .machine(machine):
            var list = machines
            if let index = list.firstIndex(where: { $0.id == machine.id }) { list[index] = machine } else { list.append(machine) }
            setMachines(list)
        case let .gui(machine, list):
            // A dialog belongs to its window: the page of the window shows it.
            let shown = list.filter { $0.transient == 0 }
            // Windows there when the machine's list first came are not new.
            if let before = windows[machine] {
                for window in shown where !before.contains(where: { $0.id == window.id }) { onNewProgram?(window) }
            }
            windows[machine] = shown
        case let .settings(message):
            if settings.apply(message) { onSettings?() }
            return
        case let .keybindings(message):
            if keybindings.apply(message) { onKeybindings?() }
            return
        case let .agent(change):
            onAgent?(change)
            return
        case let .send(machine, text, folders):
            onSend?(machine, text, folders)
            return
        case let .download(machine, paths):
            onDownload?(machine, paths)
            return
        }
        let next = machines.flatMap { windows[$0.id] ?? [] }
        if next != programs {
            programs = next
            onChange?()
        }
    }

    private func setMachines(_ list: [Machine]) {
        guard list != machines else { return }
        let known = Set(machines.map(\.id))
        machines = list
        for id in known.subtracting(list.map(\.id)) {
            connection.unsubscribe(id)
            pendingTerminals.remove(id)
            windows[id] = nil
        }
        if selectedMachine == nil || !list.contains(where: { $0.id == selectedMachine }) {
            selectedMachine = (list.first { $0.id == "local" } ?? list.first)?.id
        }
        // Only a machine the user turned to: subscribing makes the core
        // install and start the machine's terminal core.
        if let selectedMachine { connection.subscribe(selectedMachine) }
        onChange?()
    }

    /// Starts, restarts or stops a machine's terminal core
    /// (POST /api/m/{id}/hc/{action}); `done` gets nil, or the core's error
    /// code when it failed.
    func terminalCore(_ action: String, on machine: String, done: @escaping (String?) -> Void) {
        api.request("POST", "api/m/\(machine)/hc/\(action)") { status, reply in
            done(status == 200 ? nil : reply?["error"]?.string ?? String(status))
        }
    }

    func select(machine: String) {
        guard selectedMachine != machine else { return }
        selectedMachine = machine
        connection.subscribe(machine) // kept for the window's life
        onChange?()
    }

    // MARK: - Terminal messages

    private func message(_ msg: [String: Any]) {
        guard let machine = msg["m"] as? String else { return }
        let changed = store.apply(msg)
        switch msg["t"] as? String {
        case "snapshot":
            loadLayout(machine) { [weak self] in
                if self?.pendingTerminals.remove(machine) != nil { self?.newTerminal(on: machine) }
            }
        case "event":
            if msg["type"] as? String == "doc", let data = msg["data"] as? [String: Any],
               data["name"] as? String == Layout.documentName, let version = data["version"] as? Int {
                announced[machine] = version
                // While a write of ours is on its way its reply decides.
                if !saving.contains(machine), version != versions[machine] { loadLayout(machine) }
            }
            if ["removed", "finished"].contains(msg["type"] as? String ?? ""), let address = msg["terminal"] as? String {
                mutate(machine) { $0.close(address) }
                if msg["type"] as? String == "finished" {
                    connection.call(machine, "terminal.rm", ["terminal": address]) { _ in }
                }
            }
        default:
            break
        }
        if changed { onChange?() }
    }

    // MARK: - Layout documents

    /// A layout always has a workspace to open terminals in: a new one is
    /// named in the user's language. True when it added one.
    @discardableResult
    private func ensureWorkspace(_ layout: inout Layout) -> Bool {
        guard layout.workspaces.isEmpty else { return false }
        layout.createWorkspace(id: Layout.newWorkspaceID(), name: tr("workspace.default"))
        return true
    }

    private func loadLayout(_ machine: String, then done: (() -> Void)? = nil) {
        connection.call(machine, "doc.get", ["name": Layout.documentName]) { [weak self] result in
            guard let self, case let .success(doc) = result else { return }
            self.versions[machine] = doc["version"] as? Int ?? 0
            var layout = Layout(document: JSONValue(any: doc["value"]))
            let live = Set(self.store.terminals(of: machine).filter(\.isLive).map(\.address))
            let pruned = layout.prune(keeping: live)
            let added = self.ensureWorkspace(&layout)
            self.layouts[machine] = layout
            self.loaded.insert(machine)
            if pruned || added { self.saveLayout(machine) }
            self.onChange?()
            done?()
        }
    }

    /// Saves a machine's layout, one write at a time: a change made while
    /// one is on its way is written when it returns.
    private func saveLayout(_ machine: String) {
        guard loaded.contains(machine) else { return }
        guard !saving.contains(machine) else {
            dirty.insert(machine)
            return
        }
        guard let layout = layouts[machine] else { return }
        saving.insert(machine)
        let version = versions[machine] ?? 0
        connection.call(machine, "doc.set", ["name": Layout.documentName, "value": layout.document.any, "version": version]) { [weak self] result in
            guard let self else { return }
            self.saving.remove(machine)
            let again = self.dirty.remove(machine) != nil
            switch result {
            case let .success(doc):
                self.versions[machine] = doc["version"] as? Int ?? version + 1
                if again {
                    self.saveLayout(machine)
                } else if (self.announced[machine] ?? 0) > (self.versions[machine] ?? 0) {
                    self.loadLayout(machine) // another client wrote after this
                }
            case let .failure(error) where error.kind == "conflict":
                self.loadLayout(machine) // another client arranged it: theirs wins
            case .failure:
                break
            }
        }
    }

    /// Changes a machine's layout once it was read, and saves it when that
    /// changed it.
    func mutate(_ machine: String, _ change: (inout Layout) -> Void) {
        guard loaded.contains(machine), var layout = layouts[machine] else { return }
        let before = layout
        change(&layout)
        ensureWorkspace(&layout) // closing the last workspace leaves a new one
        guard layout != before else { return }
        layouts[machine] = layout
        saveLayout(machine)
        onChange?()
    }

    /// The directory of a terminal: its foreground program's, else the one
    /// it was started in.
    func directory(of address: String, on machine: String) -> String? {
        guard let record = store.terminal(address, on: machine) else { return nil }
        let cwd = (record.raw["foreground"] as? [String: Any])?["cwd"] as? String ?? record.cwd
        return cwd.isEmpty ? nil : cwd
    }

    // MARK: - Terminals

    /// Starts the machine's shell in a new terminal and places it with
    /// `place`. A new tab starts in its workspace's directory, else in the
    /// focused terminal's; a split the other way round.
    private func run(on machine: String, workspace: String? = nil, split: Bool = false, argv: [String] = [],
                     place: @escaping (inout Layout, String) -> Void) {
        guard store.backends[machine]?.phase == .ready, let layout = layout(of: machine) else {
            // Asked for on a machine whose terminals are still starting:
            // one terminal opens once they and the layout are ready.
            pendingTerminals.insert(machine)
            return
        }
        let target = workspace.flatMap { id in layout.workspaces.first { $0.id == id } } ?? layout.selectedWorkspace
        let base = target.flatMap { $0.cwd.isEmpty ? nil : $0.cwd }
        let focused = target?.selectedTab.flatMap { directory(of: $0.focused, on: machine) }
        var params: [String: Any] = ["keep": false]
        if let cwd = split ? focused ?? base : base ?? focused { params["cwd"] = cwd }
        if !argv.isEmpty { params["argv"] = argv }
        connection.call(machine, "terminal.run", params) { [weak self] result in
            guard let self, case let .success(record) = result, let address = record["address"] as? String else { return }
            self.mutate(machine) { place(&$0, address) }
        }
    }

    /// A new terminal in a new tab of a workspace, the selected one by default.
    func newTerminal(on machine: String? = nil, in workspace: String? = nil) {
        guard let machine = machine ?? selectedMachine else { return }
        select(machine: machine)
        run(on: machine, workspace: workspace) { layout, address in
            layout.open(address, in: workspace.flatMap { layout.workspaceIndex($0) == nil ? nil : $0 })
        }
    }

    func split(_ axis: Layout.Axis, argv: [String] = []) {
        guard let machine = selectedMachine else { return }
        if layout.selectedTab == nil {
            return run(on: machine, argv: argv) { layout, address in layout.open(address) }
        }
        run(on: machine, split: true, argv: argv) { layout, address in
            if !layout.split(axis, new: address) { layout.open(address) }
        }
    }

    /// Starts a coding agent in a pane split off the focused one.
    func startAgent(_ kind: String) {
        split(.horizontal, argv: [kind])
    }

    /// Ends a terminal's program; its pane goes with the event that follows.
    func kill(_ address: String, on machine: String) {
        connection.call(machine, "terminal.kill", ["terminal": address]) { _ in }
    }

    /// Closes a terminal of the selected machine and ends its program.
    func closePane(_ address: String) {
        guard let machine = selectedMachine else { return }
        mutate(machine) { $0.close(address) }
        kill(address, on: machine)
    }

    /// Closes a tab and ends the programs of its terminals.
    func closeTab(_ index: Int, in workspace: String) {
        guard let machine = selectedMachine,
              let tab = layout(of: machine)?.workspaces.first(where: { $0.id == workspace })?.tabs[safe: index] else { return }
        mutate(machine) { $0.closeTab(index, in: workspace) }
        tab.root.terminals.forEach { kill($0, on: machine) }
    }

    /// Focuses the next (1) or previous (-1) terminal of the selected tab.
    func cycleFocus(_ step: Int) {
        guard let tab = layout.selectedTab else { return }
        let all = tab.root.terminals
        guard all.count > 1, let index = all.firstIndex(of: tab.focused) else { return }
        focus(all[(index + step + all.count) % all.count])
    }

    /// Focuses the pane on a side of the focused one.
    func focus(_ direction: Layout.Direction) {
        guard let machine = selectedMachine else { return }
        mutate(machine) { $0.focus(direction) }
    }

    /// The terminal shown alone in its tab, in this window.
    private(set) var zoomed: (machine: String, terminal: String)?

    /// The zoomed terminal when it is in the selected tab.
    var zoomedTerminal: String? {
        guard let zoomed, zoomed.machine == selectedMachine, layout.selectedTab?.root.terminals.contains(zoomed.terminal) == true else { return nil }
        return zoomed.terminal
    }

    /// Shows a terminal alone in its tab, or all of the tab again.
    func toggleZoom(_ address: String? = nil) {
        guard let machine = selectedMachine, let address = address ?? focusedTerminal else { return }
        zoomed = zoomedTerminal == address ? nil : (machine, address)
        focus(address)
        onChange?()
    }

    func renameTab(_ index: Int, in workspace: String, to name: String) {
        guard let machine = selectedMachine else { return }
        mutate(machine) { $0.renameTab(index, in: workspace, to: name) }
    }

    /// Moves a tab of the selected workspace to a slot (0 before the first).
    func moveTab(_ from: Int, toSlot slot: Int) {
        guard let machine = selectedMachine, let workspace = layout.selectedWorkspace else { return }
        mutate(machine) { $0.moveTab(from, to: slotIndex(from: from, slot: slot), in: workspace.id) }
    }

    /// Names a terminal's pane; empty shows its title again.
    func renamePane(_ address: String, to name: String, on machine: String) {
        connection.call(machine, "terminal.label", ["terminal": address, "labels": ["name": name]]) { _ in }
    }

    /// Drops a pane on another's zone (swap or place beside).
    func drop(_ address: String, on target: String, zone: Layout.DropZone) {
        guard let machine = selectedMachine else { return }
        mutate(machine) { $0.drop(address, on: target, zone: zone) }
    }

    /// Moves a pane into a tab of the selected workspace, beside its focused
    /// terminal, or into a new tab (nil).
    func movePane(_ address: String, toTab index: Int?) {
        guard let machine = selectedMachine, let workspace = layout.selectedWorkspace else { return }
        mutate(machine) { layout in
            if let index, let target = workspace.tabs[safe: index]?.focused {
                layout.move(address, beside: target, axis: .horizontal)
            } else {
                layout.moveToNewTab(address, in: workspace.id)
            }
        }
    }

    /// Moves a workspace of a machine up (-1) or down (1).
    func moveWorkspace(_ id: String, by step: Int, on machine: String) {
        mutate(machine) { layout in
            if let index = layout.workspaceIndex(id) { layout.moveWorkspace(id, to: index + step) }
        }
    }

    /// The core does not take changes (--read-only).
    var readOnly: Bool { settings.readOnly }

    /// Terminals with agents on every machine followed, by how much they
    /// need the user.
    var attention: [Activity.Item] { Activity.attention(machines.map { ($0.id, store.terminals(of: $0.id)) }) }

    /// Whether a terminal is on screen: in the selected machine's selected tab.
    func onScreen(_ address: String, on machine: String) -> Bool {
        machine == selectedMachine && layout.selectedTab?.root.terminals.contains(address) == true
    }

    /// Shows a terminal: where it is, else in a new tab of the selected workspace.
    func open(_ address: String, on machine: String) {
        select(machine: machine)
        mutate(machine) { $0.open(address) }
    }

    func selectTab(_ index: Int) {
        guard let machine = selectedMachine else { return }
        mutate(machine) { if let workspace = $0.selectedWorkspace { $0.selectTab(index, in: workspace.id) } }
    }

    func cycleTab(_ step: Int) {
        guard let workspace = layout.selectedWorkspace, workspace.tabs.count > 1 else { return }
        let count = workspace.tabs.count
        selectTab((workspace.selected + step + count) % count)
    }

    func focus(_ address: String) {
        guard let machine = selectedMachine else { return }
        mutate(machine) { $0.focus(address) }
    }

    func setRatio(_ ratio: Double, at path: [Bool]) {
        guard let machine = selectedMachine else { return }
        mutate(machine) { $0.setRatio(ratio, at: path) }
    }

    // MARK: - Workspaces

    /// Creates a workspace, selects it and opens a terminal in it. Without a
    /// name it is called after its directory.
    func newWorkspace(name: String, cwd: String, on machine: String) {
        guard loaded.contains(machine) else { return }
        select(machine: machine)
        let id = Layout.newWorkspaceID()
        let title = !name.isEmpty ? name : !cwd.isEmpty ? (cwd as NSString).lastPathComponent : tr("workspace.default")
        mutate(machine) { $0.createWorkspace(id: id, name: title, cwd: cwd) }
        newTerminal(on: machine, in: id)
    }

    func renameWorkspace(_ id: String, to name: String, on machine: String) {
        mutate(machine) { $0.renameWorkspace(id, to: name) }
    }

    /// Closes a workspace and ends the programs of its terminals.
    func closeWorkspace(_ id: String, on machine: String) {
        guard let workspace = layout(of: machine)?.workspaces.first(where: { $0.id == id }) else { return }
        mutate(machine) { $0.closeWorkspace(id) }
        workspace.terminals.forEach { kill($0, on: machine) }
    }

    func selectWorkspace(_ id: String, on machine: String) {
        select(machine: machine)
        mutate(machine) { $0.selectWorkspace(id) }
    }

    func cycleWorkspace(_ step: Int) {
        guard let machine = selectedMachine, layout.workspaces.count > 1 else { return }
        let count = layout.workspaces.count
        selectWorkspace(layout.workspaces[(layout.selected + step + count) % count].id, on: machine)
    }
}

extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
