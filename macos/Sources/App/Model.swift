import AppKit
import TermKit

/// A machine as the core lists it.
struct Machine: Equatable {
    var id: String
    var label: String
    var status: String
}

/// The state behind the window: machines, their terminals and layouts, and
/// what the user does with them.
final class AppModel {
    let core: URL
    let connection: TermConnection
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
    private var poll: Timer?
    /// Machines a terminal was asked for before their terminals were ready.
    private var pendingTerminals: Set<String> = []
    /// The program windows on the machines' virtual displays.
    private(set) var programs: [ProgramWindow] = []

    /// Something the window shows changed.
    var onChange: (() -> Void)?
    /// The connection to the core came or went.
    var onConnection: ((Bool) -> Void)?

    init(core: URL) {
        self.core = core
        connection = TermConnection(core: core)
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
    }

    func start() {
        connection.start()
        fetchMachines()
        fetchPrograms()
        poll = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            self?.fetchMachines()
            self?.fetchPrograms()
        }
    }

    func stop() {
        poll?.invalidate()
        connection.close()
    }

    var layout: Layout { selectedMachine.flatMap { layouts[$0] } ?? Layout() }

    func backend(of machine: String) -> BackendState? { store.backends[machine] }

    // MARK: - Machines

    private func fetchMachines() {
        var request = URLRequest(url: core.appendingPathComponent("api/machines"))
        request.timeoutInterval = 10
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let data, let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return }
            let machines = list.compactMap { raw -> Machine? in
                guard let id = raw["id"] as? String else { return nil }
                return Machine(id: id, label: raw["label"] as? String ?? id, status: raw["status"] as? String ?? "")
            }
            DispatchQueue.main.async { self?.setMachines(machines) }
        }.resume()
    }

    private func fetchPrograms() {
        var request = URLRequest(url: core.appendingPathComponent("api/gui"))
        request.timeoutInterval = 10
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let data, let states = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return }
            var programs: [ProgramWindow] = []
            for state in states {
                guard let machine = state["m"] as? String else { continue }
                // A dialog belongs to its window: the page of the window shows it.
                for window in state["windows"] as? [[String: Any]] ?? [] where (window["transient"] as? Int ?? 0) == 0 {
                    guard let id = window["id"] as? Int else { continue }
                    programs.append(ProgramWindow(machine: machine, id: id, title: window["title"] as? String ?? "",
                                                  width: window["w"] as? Int ?? 0, height: window["h"] as? Int ?? 0))
                }
            }
            DispatchQueue.main.async {
                guard let self, programs != self.programs else { return }
                self.programs = programs
                self.onChange?()
            }
        }.resume()
    }

    private func setMachines(_ list: [Machine]) {
        guard list != machines else { return }
        let known = Set(machines.map(\.id))
        machines = list
        for id in known.subtracting(list.map(\.id)) {
            connection.unsubscribe(id)
            pendingTerminals.remove(id)
        }
        if selectedMachine == nil || !list.contains(where: { $0.id == selectedMachine }) {
            selectedMachine = (list.first { $0.id == "local" } ?? list.first)?.id
        }
        // Only a machine the user turned to: subscribing makes the core
        // install and start the machine's terminal core.
        if let selectedMachine { connection.subscribe(selectedMachine) }
        onChange?()
    }

    func select(machine: String) {
        guard selectedMachine != machine else { return }
        selectedMachine = machine
        connection.subscribe(machine) // kept for the window's life
        onChange?()
    }

    // MARK: - Messages

    private func message(_ msg: [String: Any]) {
        guard let machine = msg["m"] as? String else { return }
        let changed = store.apply(msg)
        switch msg["t"] as? String {
        case "snapshot":
            loadLayout(machine)
            if pendingTerminals.remove(machine) != nil { run(on: machine) { $0.open($1) } }
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

    private func loadLayout(_ machine: String) {
        connection.call(machine, "doc.get", ["name": Layout.documentName]) { [weak self] result in
            guard let self, case let .success(doc) = result else { return }
            self.versions[machine] = doc["version"] as? Int ?? 0
            var layout = Layout()
            if let value = doc["value"], !(value is NSNull), let data = try? JSONSerialization.data(withJSONObject: value),
               let decoded = try? JSONDecoder().decode(Layout.self, from: data) {
                layout = decoded
            }
            let live = Set(self.store.terminals(of: machine).filter(\.isLive).map(\.address))
            let pruned = layout.prune(keeping: live)
            self.layouts[machine] = layout
            self.loaded.insert(machine)
            if pruned { self.saveLayout(machine) }
            self.onChange?()
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
        guard let layout = layouts[machine], let data = try? JSONEncoder().encode(layout),
              let value = try? JSONSerialization.jsonObject(with: data) else { return }
        saving.insert(machine)
        let version = versions[machine] ?? 0
        connection.call(machine, "doc.set", ["name": Layout.documentName, "value": value, "version": version]) { [weak self] result in
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

    /// Changes a machine's layout and saves it when that changed it.
    func mutate(_ machine: String, _ change: (inout Layout) -> Void) {
        var layout = layouts[machine] ?? Layout()
        let before = layout
        change(&layout)
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

    /// The terminal the selected tab focuses.
    var focusedTerminal: String? {
        layout.tabs.indices.contains(layout.selected) ? layout.tabs[layout.selected].focused : nil
    }

    // MARK: - Actions

    /// Starts the machine's shell in a new terminal, in the directory of
    /// the focused one, and places it with `place`.
    private func run(on machine: String, place: @escaping (inout Layout, String) -> Void) {
        guard store.backends[machine]?.phase == .ready else {
            // Asked for on a machine whose terminals are still starting:
            // one terminal opens once they are ready.
            pendingTerminals.insert(machine)
            return
        }
        var params: [String: Any] = ["keep": false]
        let current = layouts[machine]
        if let current, current.tabs.indices.contains(current.selected),
           let cwd = directory(of: current.tabs[current.selected].focused, on: machine) {
            params["cwd"] = cwd
        }
        connection.call(machine, "terminal.run", params) { [weak self] result in
            guard let self, case let .success(record) = result, let address = record["address"] as? String else { return }
            self.mutate(machine) { place(&$0, address) }
        }
    }

    func newTerminal(on machine: String? = nil) {
        guard let machine = machine ?? selectedMachine else { return }
        select(machine: machine)
        run(on: machine) { $0.open($1) }
    }

    func split(_ axis: Layout.Axis) {
        guard let machine = selectedMachine else { return }
        if layout.tabs.isEmpty { return newTerminal() }
        run(on: machine) { layout, address in
            if !layout.split(axis, new: address) { layout.open(address) }
        }
    }

    /// Ends a terminal's program; its pane goes with the event that follows.
    func kill(_ address: String, on machine: String) {
        connection.call(machine, "terminal.kill", ["terminal": address]) { _ in }
    }

    func closeFocused() {
        guard let machine = selectedMachine, layout.tabs.indices.contains(layout.selected) else { return }
        kill(layout.tabs[layout.selected].focused, on: machine)
    }

    func open(_ address: String, on machine: String) {
        select(machine: machine)
        mutate(machine) { $0.open(address) }
    }

    func selectTab(_ index: Int) {
        guard let machine = selectedMachine else { return }
        mutate(machine) { if $0.tabs.indices.contains(index) { $0.selected = index } }
    }

    func cycleTab(_ step: Int) {
        let count = layout.tabs.count
        guard count > 1 else { return }
        selectTab((layout.selected + step + count) % count)
    }

    func focus(_ address: String) {
        guard let machine = selectedMachine else { return }
        mutate(machine) { layout in
            if let index = layout.tabs.firstIndex(where: { $0.root.terminals.contains(address) }) {
                layout.selected = index
                layout.tabs[index].focused = address
            }
        }
    }

    func setRatio(_ ratio: Double, at path: [Bool]) {
        guard let machine = selectedMachine else { return }
        mutate(machine) { layout in
            guard layout.tabs.indices.contains(layout.selected) else { return }
            layout.tabs[layout.selected].root = layout.tabs[layout.selected].root.settingRatio(ratio, at: path[...])
        }
    }
}
