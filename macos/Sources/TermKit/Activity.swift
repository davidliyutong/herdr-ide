import Foundation

/// What runs in terminals and what their agents wait for: the rules the web
/// UI follows too (web/src/actions.ts, notify.ts, sound.ts, lib/bridge.ts),
/// for asking before closing, the attention list, notifications and where
/// text sent from VS Code goes.
public enum Activity {
    /// Shells a terminal waits at the prompt in.
    static let shells: Set<String> = [
        "sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "mksh", "yash", "csh", "tcsh", "nu", "xonsh", "elvish", "osh",
        "pwsh", "powershell", "cmd",
    ]

    /// What runs in a terminal in front of its shell: the agent's name for
    /// an agent, the foreground program's otherwise; nil when only the shell
    /// waits at its prompt or the program has ended. Jobs sent to the
    /// background do not count.
    public static func runningProgram(_ record: TerminalRecord?) -> String? {
        guard let record, record.isLive, let fg = record.raw["foreground"] as? [String: Any],
              let raw = fg["name"] as? String, !raw.isEmpty else { return nil }
        var name = raw.hasPrefix("-") ? String(raw.dropFirst()) : raw
        if name.lowercased().hasSuffix(".exe") { name = String(name.dropLast(4)) }
        name = (name as NSString).lastPathComponent
        if let pid = fg["pid"] as? Int, pid == record.raw["pid"] as? Int, shells.contains(name.lowercased()) { return nil }
        return record.agent ?? name
    }

    /// The programs that end when these terminals close, each once, in order.
    public static func runningPrograms(_ records: [TerminalRecord?]) -> [String] {
        var out: [String] = []
        for name in records.compactMap(runningProgram) where !out.contains(name) { out.append(name) }
        return out
    }

    // MARK: - Agents

    /// How much a status needs the user, highest first.
    public static let rank: [String: Int] = ["blocked": 4, "done": 3, "working": 2, "idle": 1, "unknown": 0]

    /// What a terminal's agent is doing: the detected state, else what the
    /// program reported (OSC 7501), with a program's "error" counting as
    /// blocked; nil for anything else.
    public static func status(_ record: TerminalRecord?) -> String? {
        guard let s = record?.status else { return nil }
        if rank[s] != nil { return s }
        return s == "error" ? "blocked" : nil
    }

    /// A terminal of the attention list.
    public struct Item: Equatable {
        public var machine: String
        public var record: TerminalRecord
        public var status: String
        public var terminal: String { record.address }
    }

    /// Live terminals with an agent (or a status their program reports
    /// other than idle) on the machines in order, by how much they need the
    /// user; the order of the machines and terminals within a status.
    public static func attention(_ machines: [(id: String, terminals: [TerminalRecord])]) -> [Item] {
        var out: [Item] = []
        for (id, terminals) in machines {
            for record in terminals where record.isLive {
                guard let s = status(record), record.agent != nil || s != "idle" else { continue }
                out.append(Item(machine: id, record: record, status: s))
            }
        }
        return out.enumerated().sorted { a, b in
            let (ra, rb) = (rank[a.element.status] ?? 0, rank[b.element.status] ?? 0)
            return ra != rb ? ra > rb : a.offset < b.offset
        }.map(\.element)
    }

    /// The count on the Dock icon: blocked terminals.
    public static func badge(_ items: [Item]) -> Int { items.filter { $0.status == "blocked" }.count }

    /// An agent's status change, as the event channel's `agent` message
    /// carries it.
    public struct AgentEvent: Equatable {
        public var machine: String
        public var terminal: String
        public var status: String
        public var agent: String?
        public var displayAgent: String?
        public var title: String?
        /// The core chose this client to play sounds (the one used last).
        public var sound: Bool

        public init(machine: String, terminal: String, status: String, agent: String? = nil, displayAgent: String? = nil,
                    title: String? = nil, sound: Bool = false) {
            self.machine = machine
            self.terminal = terminal
            self.status = status
            self.agent = agent
            self.displayAgent = displayAgent
            self.title = title
            self.sound = sound
        }

        /// Who to name in a notification.
        public var who: String { displayAgent ?? agent ?? "agent" }
    }

    /// The muted agents setting: names separated by commas or spaces.
    public static func muted(_ raw: String) -> Set<String> {
        Set(raw.lowercased().split(whereSeparator: { $0 == "," || $0.isWhitespace }).map(String.init))
    }

    public enum Sound: String { case request, done }

    /// What an agent's status change does: the sound it plays and whether a
    /// notification is posted (when the window is not in front) or a note
    /// shown in it (blocked, in front).
    public struct Reaction: Equatable {
        public var sound: Sound?
        public var notification: Bool
        public var note: Bool
    }

    /// The web UI's rules: only blocked and done count; sounds play on the
    /// client the core chose, with the setting on and the agent not muted,
    /// the done sound not for a terminal on screen in a window in front.
    public static func reaction(_ event: AgentEvent, soundsOn: Bool, muted: Set<String>, onScreen: Bool, inFront: Bool) -> Reaction {
        guard event.status == "blocked" || event.status == "done" else { return Reaction(sound: nil, notification: false, note: false) }
        var sound: Sound?
        let silenced = [event.agent, event.displayAgent].contains { $0.map { muted.contains($0.lowercased()) } ?? false }
        if event.sound, soundsOn, !silenced {
            if event.status == "blocked" { sound = .request } else if !(onScreen && inFront) { sound = .done }
        }
        return Reaction(sound: sound, notification: !inFront, note: inFront && event.status == "blocked")
    }

    // MARK: - Send to agent

    /// The terminal that text sent from a VS Code window of a machine goes
    /// to: the focused terminal when the window shows that machine, else an
    /// agent of the machine waiting for input (idle or done), else any agent.
    public static func sendTarget(focused: String?, terminals: [TerminalRecord], order: [String]) -> String? {
        if let focused { return focused }
        let byAddress = Dictionary(terminals.map { ($0.address, $0) }, uniquingKeysWith: { a, _ in a })
        let agents = order.compactMap { byAddress[$0] }.filter { $0.agent != nil && $0.isLive }
        return (agents.first { ["idle", "done"].contains(status($0) ?? "") } ?? agents.first)?.address
    }
}

/// Where a dragged item lands in a list: slots run from 0 (before the first
/// item) to the count (after the last).
public func slotIndex(from: Int, slot: Int) -> Int { slot > from ? slot - 1 : slot }

/// The command palette's matching: the query's characters appear in the
/// text in order, ignoring case.
public func fuzzyMatch(_ query: String, _ text: String) -> Bool {
    var q = query.lowercased()[...]
    for ch in text.lowercased() where ch == q.first { q = q.dropFirst() }
    return q.isEmpty
}
