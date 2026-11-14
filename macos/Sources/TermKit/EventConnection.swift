import Foundation

/// A machine as the core lists it.
public struct Machine: Equatable {
    public var id: String
    public var label: String
    /// The core's connection state: connecting, ready, auth_required,
    /// error or disabled.
    public var status: String
    /// local (the core's own host) or ssh.
    public var kind: String
    /// The core's connection to the machine's terminal core, while it has
    /// one: the same as the terminal protocol's backend state.
    public var hc: BackendState?
    /// The ssh destination of an ssh machine.
    public var target: String
    /// Why the connection failed, as ssh or the agent said it.
    public var error: String
    /// The user's home directory there, once connected.
    public var home: String

    public init(id: String, label: String, status: String, kind: String = "", hc: BackendState? = nil, target: String = "",
                error: String = "", home: String = "") {
        self.id = id
        self.label = label
        self.status = status
        self.kind = kind
        self.hc = hc
        self.target = target
        self.error = error
        self.home = home
    }

    /// Why a target typed for a new machine cannot be one, as the core
    /// checks it: an ssh destination of printable ASCII without spaces that
    /// does not read as an option, at most 255 characters.
    public static func validTarget(_ target: String) -> Bool {
        let t = target.trimmingCharacters(in: .whitespaces)
        return !t.isEmpty && !t.hasPrefix("-") && t.count <= 255 && t.unicodeScalars.allSatisfy { $0.value > 0x20 && $0.value < 0x7f }
    }
}

/// A window of a program on a machine's virtual display.
public struct ProgramWindow: Equatable {
    public var machine: String
    public var id: Int
    public var title: String
    public var width: Int
    public var height: Int
    /// The window this one is a dialog of; 0 for none.
    public var transient: Int
    /// The terminal (of the machine's terminal core) its program runs in,
    /// "" when unknown.
    public var terminal: String

    public init(machine: String, id: Int, title: String, width: Int, height: Int, transient: Int = 0, terminal: String = "") {
        self.machine = machine
        self.id = id
        self.title = title
        self.width = width
        self.height = height
        self.transient = transient
        self.terminal = terminal
    }
}

/// The client of the core's event channel (`/ws`): the machines, their
/// program windows, the settings and the keybindings as they change. It
/// reconnects by itself (`CoreSocket`), and the core then sends the whole
/// state again. Use it from the main queue.
public final class EventConnection {
    public enum Event: Equatable {
        /// Every machine, in the core's order.
        case machines([Machine])
        /// A machine that changed or was added.
        case machine(Machine)
        /// The windows on a machine's virtual display.
        case gui(machine: String, windows: [ProgramWindow])
        /// The settings changed: the message, with every value and the
        /// problems of the file (`SettingsModel.apply`).
        case settings(JSONValue)
        /// The keybindings changed: the message, with the user's rules and
        /// the bindings in effect (`KeybindingsModel.apply`).
        case keybindings(JSONValue)
        /// An agent's status changed in a terminal.
        case agent(Activity.AgentEvent)
        /// Text sent from a VS Code window of a machine ("Send to agent"),
        /// with the window's folders when it said them.
        case send(machine: String, text: String, folders: [String]?)
        /// Files chosen in VS Code's explorer to download.
        case download(machine: String, paths: [String])
    }

    public var onEvent: ((Event) -> Void)?
    /// The connection came (true) or went (false).
    public var onConnection: ((Bool) -> Void)?
    public var isConnected: Bool { socket.isConnected }

    private let socket: CoreSocket

    /// `core` is the core's HTTP origin, such as http://127.0.0.1:7781.
    public init(core: URL) {
        socket = CoreSocket(core: core, path: "/ws")
        socket.onOpen = { [weak self] in self?.onConnection?(true) }
        socket.onClose = { [weak self] wasConnected in if wasConnected { self?.onConnection?(false) } }
        socket.onText = { [weak self] text in
            if let event = EventConnection.decode(text) { self?.onEvent?(event) }
        }
    }

    public func start() { socket.start() }

    public func close() { socket.close() }

    /// Sends a message while connected: retry ({"t": "retry", "m": id})
    /// ends the wait before a machine's next connection attempt, active
    /// tells the core this client is in use (it plays notification sounds),
    /// theme the appearance VS Code windows follow.
    public func send(_ message: [String: Any]) {
        if socket.isConnected { socket.send(json: message) }
    }

    /// The event a text message of `/ws` carries; nil for the messages the
    /// application does not use.
    public static func decode(_ text: String) -> Event? {
        guard let msg = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return nil }
        switch msg["t"] as? String {
        case "machines":
            guard let list = msg["list"] as? [[String: Any]] else { return nil }
            return .machines(list.compactMap(machine))
        case "machine":
            return (msg["state"] as? [String: Any]).flatMap(machine).map { .machine($0) }
        case "gui":
            guard let state = msg["state"] as? [String: Any], let id = state["m"] as? String else { return nil }
            let windows = (state["windows"] as? [[String: Any]] ?? []).compactMap { raw -> ProgramWindow? in
                guard let window = raw["id"] as? Int else { return nil }
                return ProgramWindow(machine: id, id: window, title: raw["title"] as? String ?? "",
                                     width: raw["w"] as? Int ?? 0, height: raw["h"] as? Int ?? 0, transient: raw["transient"] as? Int ?? 0,
                                     terminal: raw["terminal"] as? String ?? "")
            }
            return .gui(machine: id, windows: windows)
        case "settings":
            return .settings(JSONValue(any: msg))
        case "keybindings":
            return .keybindings(JSONValue(any: msg))
        case "agent":
            guard let machine = msg["m"] as? String, let data = msg["data"] as? [String: Any],
                  let terminal = data["terminal"] as? String, let status = data["agent_status"] as? String else { return nil }
            return .agent(Activity.AgentEvent(machine: machine, terminal: terminal, status: status, agent: data["agent"] as? String,
                                              displayAgent: data["display_agent"] as? String, title: data["title"] as? String,
                                              sound: msg["sound"] as? Bool ?? false))
        case "bridge.send":
            guard let machine = msg["m"] as? String, let text = msg["text"] as? String else { return nil }
            return .send(machine: machine, text: text, folders: (msg["folders"] as? [Any])?.compactMap { $0 as? String })
        case "bridge.download":
            guard let machine = msg["m"] as? String, let paths = msg["paths"] as? [Any] else { return nil }
            return .download(machine: machine, paths: paths.compactMap { $0 as? String })
        default:
            return nil
        }
    }

    private static func machine(_ raw: [String: Any]) -> Machine? {
        guard let id = raw["id"] as? String, !id.isEmpty else { return nil }
        let label = raw["label"] as? String ?? ""
        let hc = (raw["hc"] as? [String: Any]).map {
            BackendState(phase: BackendState.Phase(rawValue: $0["state"] as? String ?? "") ?? .starting,
                         code: $0["code"] as? String ?? "", version: $0["version"] as? String ?? "")
        }
        return Machine(id: id, label: label.isEmpty ? id : label, status: raw["status"] as? String ?? "",
                       kind: raw["kind"] as? String ?? "", hc: hc, target: raw["target"] as? String ?? "",
                       error: raw["error"] as? String ?? "", home: (raw["info"] as? [String: Any])?["home"] as? String ?? "")
    }
}
