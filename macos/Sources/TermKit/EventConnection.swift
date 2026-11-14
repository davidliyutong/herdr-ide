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

    public init(id: String, label: String, status: String, kind: String = "", hc: BackendState? = nil) {
        self.id = id
        self.label = label
        self.status = status
        self.kind = kind
        self.hc = hc
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

/// The client of the core's event channel (`/ws?events=1`): the machines,
/// their program windows, the settings and the keybindings as they change. As an events-only client it
/// takes no part in the browser UI's pane session. It reconnects by itself
/// (`CoreSocket`), and the core then sends the whole state again. Use it
/// from the main queue.
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
    }

    public var onEvent: ((Event) -> Void)?
    /// The connection came (true) or went (false).
    public var onConnection: ((Bool) -> Void)?
    public var isConnected: Bool { socket.isConnected }

    private let socket: CoreSocket

    /// `core` is the core's HTTP origin, such as http://127.0.0.1:7781.
    public init(core: URL) {
        socket = CoreSocket(core: core, path: "/ws", query: "events=1")
        socket.onOpen = { [weak self] in self?.onConnection?(true) }
        socket.onClose = { [weak self] wasConnected in if wasConnected { self?.onConnection?(false) } }
        socket.onText = { [weak self] text in
            if let event = EventConnection.decode(text) { self?.onEvent?(event) }
        }
    }

    public func start() { socket.start() }

    public func close() { socket.close() }

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
                       kind: raw["kind"] as? String ?? "", hc: hc)
    }
}
