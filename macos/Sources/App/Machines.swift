import AppKit
import GhosttyTerminal
import TermKit

/// Machine management, as the web UI's: adding an ssh machine (and its
/// interactive login when it needs one), renaming, enabling and disabling,
/// removing, retrying the connection, and its terminal core: start, restart
/// (the programs keep running) and stop (asked first: every terminal there
/// ends). Refusals show the core's code as a sentence.
final class MachineDialogs {
    private let model: AppModel
    private weak var window: NSWindow?
    /// Shows a short message in the main window.
    var toast: ((String) -> Void)?
    /// The controller for the login terminal's surface.
    var controller: TerminalController?
    private var logins: [String: LoginWindow] = [:]
    /// Machines added here whose login is awaited, until when.
    private var awaiting: [String: Date] = [:]

    init(model: AppModel, window: NSWindow) {
        self.model = model
        self.window = window
    }

    private func label(_ machine: String) -> String {
        model.machines.first { $0.id == machine }?.label ?? machine
    }

    // MARK: - Menus

    /// What the sidebar's free space offers.
    func addItems(to menu: ClosureMenu) {
        menu.item(tr("menu.addMachine"), symbol: "plus") { [weak self] in self?.add() }
    }

    /// A machine's menu: new terminal or workspace; its terminal core (when
    /// connected); sign in or retry (when not); enable or disable; rename
    /// and remove an ssh machine; add one.
    func items(for machine: Machine, in menu: ClosureMenu, dialogs: Dialogs?) {
        let id = machine.id
        if machine.status == "ready" {
            menu.item(tr("menu.newTerminal"), symbol: "plus") { [weak self] in self?.model.newTerminal(on: id) }
            if model.layout(of: id) != nil {
                menu.item(tr("menu.newWorkspace"), symbol: "rectangle.stack.badge.plus") { dialogs?.createWorkspace(on: id) }
            }
            menu.separator()
            let code = (model.backend(of: id) ?? machine.hc)?.code
            if code == "stopped" || code == "not_running" {
                menu.item(tr("menu.startCore"), symbol: "play") { [weak self] in self?.core("start", on: id) }
            } else {
                menu.item(tr("menu.restartCore"), symbol: "arrow.clockwise") { [weak self] in self?.restartCore(on: id) }
                menu.item(tr("menu.stopCore"), symbol: "stop") { [weak self] in self?.stopCore(on: id) }
            }
        }
        menu.separator()
        if machine.status == "auth_required", machine.kind == "ssh" {
            menu.item(tr("menu.signIn"), symbol: "key") { [weak self] in self?.signIn(id) }
        }
        // A machine whose target the core refuses is never connected: it
        // can be renamed or removed only.
        if machine.usable {
            if machine.status == "error" || machine.status == "auth_required" {
                menu.item(tr("menu.retry"), symbol: "arrow.clockwise") { [weak self] in self?.retry(id) }
            }
            if machine.status == "disabled" {
                menu.item(tr("menu.enableMachine"), symbol: "power") { [weak self] in self?.setEnabled(id, true) }
            } else {
                menu.item(tr("menu.disableMachine"), symbol: "poweroff") { [weak self] in self?.setEnabled(id, false) }
            }
        }
        // The local machine keeps its host's name and stays.
        if machine.kind == "ssh" {
            menu.separator()
            menu.item(tr("menu.renameMachine"), symbol: "pencil") { [weak self] in self?.rename(id) }
            menu.item(tr("menu.removeMachine"), symbol: "trash") { [weak self] in self?.remove(id) }
        }
        menu.separator()
        addItems(to: menu)
    }

    /// The one action a machine's row offers, by its state: sign in, retry,
    /// enable; nil when it is connected or never is.
    func rowAction(_ machine: Machine) -> (symbol: String, tip: String, run: () -> Void)? {
        let id = machine.id
        guard machine.usable else { return nil }
        switch machine.status {
        case "auth_required" where machine.kind == "ssh": return ("key", tr("menu.signIn"), { [weak self] in self?.signIn(id) })
        case "error": return ("arrow.clockwise", tr("menu.retry"), { [weak self] in self?.retry(id) })
        case "disabled": return ("power", tr("menu.enableMachine"), { [weak self] in self?.setEnabled(id, true) })
        default: return nil
        }
    }

    // MARK: - Requests

    /// Why a machine request failed: the core's code as a sentence, else
    /// its detail or status.
    private func failure(_ status: Int, _ reply: JSONValue?) -> String {
        let code = reply?["error"]?.string ?? ""
        if let text = SettingsWindow.text("machine.error." + code) { return text }
        return reply?["detail"]?.string ?? (code.isEmpty ? String(status) : code)
    }

    private func sheet(_ title: String, _ info: String) {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = info
        alert.beginSheetModal(for: window)
    }

    private func encoded(_ id: String) -> String { id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id }

    private var dialogs: Dialogs? { window.map { Dialogs(model: model, window: $0) } }

    /// Asks for an ssh destination and a name, and adds the machine: it
    /// connects at once, and its login opens when it needs one.
    func add(target: String = "", label: String = "", problem: String? = nil) {
        let targetField = Dialogs.field(tr("addMachine.targetPlaceholder"), target)
        let labelField = Dialogs.field(tr("addMachine.labelPlaceholder"), label)
        dialogs?.ask(tr("addMachine.title"), info: problem ?? tr("addMachine.explain"),
                     rows: [(tr("addMachine.target"), targetField), (tr("addMachine.label"), labelField)],
                     confirm: tr("addMachine.add")) { [weak self] in
            let target = targetField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = labelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard Machine.validTarget(target) else {
                // Asked again with what was typed and why it was refused.
                DispatchQueue.main.async { self?.add(target: target, label: label, problem: tr("addMachine.badTarget")) }
                return
            }
            self?.send(target: target, label: label)
        }
    }

    private func send(target: String, label: String) {
        let name = label.isEmpty ? target : label
        model.api.request("POST", "api/machines", body: ["target": target, "label": label]) { [weak self] status, reply in
            guard let self else { return }
            guard status == 201 || status == 200, let id = reply?["id"]?.string else {
                return self.sheet(tr("machine.addFailed", name), self.failure(status, reply))
            }
            self.toast?(tr("machine.added", name))
            self.awaiting[id] = Date().addingTimeInterval(120)
            self.machinesChanged()
        }
    }

    /// Called when machines change: a machine just added that needs a login
    /// gets its login window (watched for two minutes), and login windows
    /// of machines that connected close.
    func machinesChanged() {
        for (id, until) in awaiting {
            let status = model.machines.first { $0.id == id }?.status
            if status == "auth_required" {
                awaiting[id] = nil
                signIn(id)
            } else if ["ready", "error", "disabled"].contains(status ?? "") || Date() > until {
                awaiting[id] = nil
            }
        }
        // A login ends with its machine's connection, or its removal.
        for (id, login) in logins where [nil, "ready"].contains(model.machines.first(where: { $0.id == id })?.status) {
            login.close()
        }
    }

    /// The interactive ssh login of a machine, in a terminal of its own fed
    /// by a PTY on the core host (GET /api/m/{id}/auth).
    func signIn(_ id: String) {
        if let login = logins[id], !login.ended { return login.show() }
        guard let controller else { return }
        let login = LoginWindow(core: model.core, machine: id, label: label(id), controller: controller)
        login.onClose = { [weak self] in self?.logins[id] = nil }
        logins[id] = login
        login.show()
    }

    /// Ends the wait before the machine's next connection attempt.
    func retry(_ id: String) {
        model.events.send(["t": "retry", "m": id])
    }

    /// Enables or disables a machine; disabling a connected one asks first.
    func setEnabled(_ id: String, _ enabled: Bool) {
        let apply = { [weak self] in
            guard let self else { return }
            self.model.api.request("PUT", "api/m/\(self.encoded(id))/enabled", body: ["enabled": enabled]) { [weak self] status, reply in
                if status != 200 { self?.sheet(tr("machine.enableFailed"), self?.failure(status, reply) ?? "") }
            }
        }
        guard !enabled else { return apply() }
        dialogs?.confirm(tr("machine.disableTitle", label(id)), info: tr("machine.disableInfo"), button: tr("menu.disableMachine"), then: apply)
    }

    func rename(_ id: String) {
        let field = Dialogs.field(label(id), label(id))
        dialogs?.ask(tr("machine.renameTitle"), rows: [(tr("workspace.name"), field)], confirm: tr("workspace.rename")) { [weak self] in
            guard let self else { return }
            let name = field.stringValue.trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty, name != self.label(id) else { return }
            self.model.api.request("PUT", "api/m/\(self.encoded(id))/label", body: ["label": name]) { [weak self] status, reply in
                if status != 200 { self?.sheet(tr("machine.renameFailed"), self?.failure(status, reply) ?? "") }
            }
        }
    }

    /// Removes an ssh machine after asking: its connection ends; its
    /// terminal core and programs keep running there.
    func remove(_ id: String) {
        let target = model.machines.first { $0.id == id }?.target ?? id
        dialogs?.confirm(tr("machine.removeTitle", label(id)), info: tr("machine.removeInfo", target), button: tr("machine.remove")) { [weak self] in
            guard let self else { return }
            let name = self.label(id)
            self.model.api.request("DELETE", "api/m/\(self.encoded(id))") { [weak self] status, reply in
                if status == 200 {
                    self?.toast?(tr("machine.removed", name))
                } else {
                    self?.sheet(tr("machine.removeFailed"), self?.failure(status, reply) ?? "")
                }
            }
        }
    }

    #if DEBUG
        /// Development: machine operations without their dialogs, by target:
        /// add, signin, remove, menu (logs the machine's menu).
        func debug(_ op: String, _ target: String) {
            let machine = model.machines.first { $0.target == target }
            switch op {
            case "add": send(target: target, label: "")
            case "signin": if let machine { signIn(machine.id) }
            case "remove": if let machine { model.api.request("DELETE", "api/m/\(encoded(machine.id))") { status, _ in
                FileHandle.standardError.write(Data("remove \(target): \(status)\n".utf8))
            } }
            case "menu":
                guard let machine else { return }
                let menu = ClosureMenu()
                items(for: machine, in: menu, dialogs: dialogs)
                FileHandle.standardError.write(Data("menu \(target) [\(machine.status)]: \(menu.items.map(\.title))\n".utf8))
            default: break
            }
        }
    #endif

    // MARK: - Terminal core

    /// Stops the machine's terminal core after asking.
    func stopCore(on machine: String) {
        dialogs?.confirm(tr("core.stopTitle", label(machine)), info: tr("core.stopInfo"), button: tr("core.stop")) { [weak self] in
            self?.core("stop", on: machine)
        }
    }

    /// Restarts the machine's terminal core after asking.
    func restartCore(on machine: String) {
        dialogs?.confirm(tr("core.restartTitle", label(machine)), info: tr("core.restartInfo"), button: tr("core.restart")) { [weak self] in
            self?.core("restart", on: machine)
        }
    }

    /// Runs start, restart or stop on the machine's terminal core.
    func core(_ action: String, on machine: String) {
        model.terminalCore(action, on: machine) { [weak self] code in
            guard let self, let code else { return }
            self.sheet(tr("core.failed", self.label(machine)), tr("backend." + code))
        }
    }

    /// Gives a terminal's shell the machine's virtual display, so programs
    /// started there open their windows (POST /api/m/{id}/gui/enable): a
    /// shell at its prompt gets the variables typed in; one running a
    /// program is left alone, and the sheet offers the command to copy. Without
    /// a terminal, every terminal of the machine.
    func enableWindows(_ terminal: String?, on machine: String) {
        let body = ["terminals": terminal.map { [$0] } ?? []]
        model.api.request("POST", "api/m/\(encoded(machine))/gui/enable", body: body) { [weak self] status, reply in
            guard let self, let window = self.window else { return }
            let alert = NSAlert()
            var command = ""
            if status != 200 {
                alert.messageText = tr("gui.enableFailed")
                alert.informativeText = tr("gui.error." + (reply?["error"]?.string ?? "transport"))
            } else if (reply?["enabled"]?.number ?? 0) > 0 {
                alert.messageText = tr("gui.enabled")
            } else if (reply?["already"]?.number ?? 0) > 0 {
                alert.messageText = tr("gui.already")
            } else if !(reply?["busy"]?.array ?? []).isEmpty {
                alert.messageText = tr("gui.busy")
                command = reply?["command"]?.string ?? ""
                alert.informativeText = command.trimmingCharacters(in: .whitespaces)
                alert.addButton(withTitle: tr("gui.copyCommand"))
                alert.addButton(withTitle: tr("workspace.cancel"))
            } else {
                alert.messageText = tr("gui.enableFailed")
                alert.informativeText = tr("gui.error.transport")
            }
            alert.beginSheetModal(for: window) { response in
                if !command.isEmpty, response == .alertFirstButtonReturn {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(command.trimmingCharacters(in: .whitespaces), forType: .string)
                }
            }
        }
    }
}

/// A machine's interactive ssh login: a terminal of this Mac fed by the
/// core's PTY over a WebSocket, as the web UI's authentication dialog. The
/// PTY starts with the terminal's size once the surface knows it; closing
/// the window ends the login, and the core connects the machine again.
final class LoginWindow: NSObject, NSWindowDelegate {
    private let window: NSWindow
    private let core: URL
    private let machine: String
    private let terminal: TerminalView
    private var session: InMemoryTerminalSession!
    private var task: URLSessionWebSocketTask?
    private let hint = NSTextField(wrappingLabelWithString: "")
    private(set) var ended = false
    var onClose: (() -> Void)?

    init(core: URL, machine: String, label: String, controller: TerminalController) {
        self.core = core
        self.machine = machine
        terminal = MainActor.assumeIsolated { TerminalView(frame: .zero) }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 440), styleMask: [.titled, .closable, .resizable],
                          backing: .buffered, defer: false)
        super.init()
        window.title = tr("auth.title", label)
        window.isReleasedWhenClosed = false
        window.delegate = self
        hint.stringValue = tr("auth.hint")
        hint.font = Theme.fontSmall
        hint.textColor = Theme.muted
        session = InMemoryTerminalSession(
            write: { [weak self] data in DispatchQueue.main.async { self?.task?.send(.data(data)) { _ in } } },
            resize: { [weak self] viewport in
                DispatchQueue.main.async { self?.open(cols: Int(viewport.columns), rows: Int(viewport.rows)) }
            },
            suppressesPixelOnlyResizes: true
        )
        MainActor.assumeIsolated {
            terminal.configuration = TerminalSurfaceOptions(backend: .inMemory(session))
            terminal.controller = controller
        }
        let root = FillView(Theme.background)
        for view in [hint, terminal] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(view)
        }
        NSLayoutConstraint.activate([
            hint.topAnchor.constraint(equalTo: root.topAnchor, constant: 8), hint.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            hint.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            terminal.topAnchor.constraint(equalTo: hint.bottomAnchor, constant: 8), terminal.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            terminal.leadingAnchor.constraint(equalTo: root.leadingAnchor), terminal.trailingAnchor.constraint(equalTo: root.trailingAnchor),
        ])
        window.contentView = root
        window.center()
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(terminal)
    }

    func close() { window.close() }

    /// Opens the PTY once, with the first size the surface reports.
    private func open(cols: Int, rows: Int) {
        guard task == nil, !ended, cols > 0, rows > 0 else { return }
        var parts = URLComponents(url: core, resolvingAgainstBaseURL: false)!
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        parts.percentEncodedPath = "/api/m/" + (machine.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? machine) + "/auth"
        parts.queryItems = [URLQueryItem(name: "cols", value: String(cols)), URLQueryItem(name: "rows", value: String(rows))]
        guard let url = parts.url else { return }
        let task = URLSession.shared.webSocketTask(with: url)
        self.task = task
        task.resume()
        receive(task)
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, task === self.task else { return }
                switch result {
                case let .success(.data(data)): self.session.receive(data)
                case let .success(.string(text)): self.session.receive(Data(text.utf8))
                case .success: break
                case .failure:
                    // The command ended: the core connects the machine again.
                    self.ended = true
                    self.hint.stringValue = tr("auth.ended")
                    return
                }
                self.receive(task)
            }
        }
    }

    func windowWillClose(_: Notification) {
        ended = true
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        onClose?()
    }
}
