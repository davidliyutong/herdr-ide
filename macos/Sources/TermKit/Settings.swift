import Foundation

/// A setting as the core defines it (`GET /api/settings`,
/// internal/settings): its type, default, allowed values, scope and place.
public struct SettingDefinition: Equatable {
    public let key: String
    /// bool, number, string, enum, color or list.
    public let type: String
    public let defaultValue: JSONValue
    public let options: [String]
    public let min: Double?
    public let max: Double?
    public let integer: Bool
    /// The type of a list's items, and how many it must have (0: any).
    public let item: String?
    public let length: Int
    /// app, machine or remote-machine.
    public let scope: String
    public let section: String
    public let order: Int
    public let platforms: [String]
    public let flag: String?

    public init?(_ json: JSONValue) {
        guard let key = json["key"]?.string, let type = json["type"]?.string else { return nil }
        self.key = key
        self.type = type
        defaultValue = json["default"] ?? .null
        options = json["enum"]?.array?.compactMap(\.string) ?? []
        min = json["min"]?.number
        max = json["max"]?.number
        integer = json["integer"]?.bool ?? false
        item = json["item"]?.string
        length = Int(json["length"]?.number ?? 0)
        scope = json["scope"]?.string ?? "app"
        section = json["section"]?.string ?? ""
        order = Int(json["order"]?.number ?? 0)
        platforms = json["platforms"]?.array?.compactMap(\.string) ?? []
        flag = json["flag"]?.string
    }

    /// Whether the macOS application uses the setting.
    public var onMac: Bool { platforms.isEmpty || platforms.contains("macos") }
}

/// A setting's state: its global value and where it comes from (default,
/// global, flag), machines' own values, and whether a flag fixes it.
public struct SettingState: Equatable {
    public var value: JSONValue
    public var source: String
    public var machines: [String: JSONValue]
    public var locked: Bool

    public init(value: JSONValue, source: String = "default", machines: [String: JSONValue] = [:], locked: Bool = false) {
        self.value = value
        self.source = source
        self.machines = machines
        self.locked = locked
    }

    init(_ json: JSONValue) {
        value = json["value"] ?? .null
        source = json["source"]?.string ?? "default"
        machines = json["machines"]?.object ?? [:]
        locked = json["locked"]?.bool ?? false
    }

    /// Whether the user changed the global value.
    public var isModified: Bool { source == "global" }
}

/// Something wrong in the settings file, or in the keybindings file
/// (`index` set).
public struct SettingProblem: Equatable {
    public let key: String?
    public let machine: String?
    public let index: Int?
    public let code: String
    public let detail: String?

    init(_ json: JSONValue) {
        key = json["key"]?.string
        machine = json["machine"]?.string
        index = json["index"]?.number.map { Int($0) }
        code = json["code"]?.string ?? ""
        detail = json["detail"]?.string
    }
}

/// The core's settings: definitions and values from `GET /api/settings`,
/// kept current with the `settings` messages of the event channel.
public final class SettingsModel {
    public private(set) var sections: [String] = []
    public private(set) var definitions: [SettingDefinition] = []
    public private(set) var values: [String: SettingState] = [:]
    public private(set) var problems: [SettingProblem] = []
    public private(set) var readOnly = false
    /// The settings file on the core host.
    public private(set) var file = ""
    public private(set) var loaded = false

    public init() {}

    /// Takes a `GET /api/settings` reply.
    public func load(_ reply: JSONValue) {
        let sorted = (reply["sections"]?.array ?? []).compactMap { s -> (String, Double)? in
            s["id"]?.string.map { ($0, s["order"]?.number ?? 0) }
        }.sorted { $0.1 < $1.1 }
        sections = sorted.map(\.0)
        definitions = (reply["definitions"]?.array ?? []).compactMap(SettingDefinition.init)
        readOnly = reply["read_only"]?.bool ?? false
        file = reply["file"]?.string ?? ""
        loaded = true
        apply(reply)
    }

    /// Takes the values and problems of a reply or a `settings` message.
    @discardableResult
    public func apply(_ message: JSONValue) -> Bool {
        guard let raw = message["values"]?.object else { return false }
        values = raw.mapValues(SettingState.init)
        problems = (message["problems"]?.array ?? []).map(SettingProblem.init)
        return true
    }

    public func definition(_ key: String) -> SettingDefinition? { definitions.first { $0.key == key } }

    /// A setting's global value: the core's, else the definition's default.
    public func value(_ key: String) -> JSONValue? {
        values[key]?.value ?? definition(key)?.defaultValue
    }

    public func bool(_ key: String, _ fallback: Bool) -> Bool { value(key)?.bool ?? fallback }
    public func number(_ key: String, _ fallback: Double) -> Double { value(key)?.number ?? fallback }
    public func string(_ key: String, _ fallback: String) -> String { value(key)?.string ?? fallback }
    public func list(_ key: String) -> [String] { value(key)?.array?.compactMap(\.string) ?? [] }

    /// The definitions of a section the macOS application shows, in order.
    public func definitions(in section: String) -> [SettingDefinition] {
        definitions.filter { $0.section == section && $0.onMac }
    }

    /// Whether a setting matches a search: every word is in its label, key,
    /// description or an option's label.
    public static func matches(_ definition: SettingDefinition, query: String, text: (String) -> String?) -> Bool {
        let words = query.lowercased().split(separator: " ").map(String.init)
        if words.isEmpty { return true }
        var parts = [definition.key, text("settings." + definition.key) ?? "", text("settings.\(definition.key).desc") ?? ""]
        parts += definition.options.map { text("settings.\(definition.key).\($0)") ?? $0 }
        let haystack = parts.joined(separator: " ").lowercased()
        return words.allSatisfy { haystack.contains($0) }
    }
}

/// A command keys can run (`GET /api/keybindings`).
public struct KeyCommand: Equatable {
    public let id: String
    public let section: String
    public let when: String
}

/// A key bound to several commands where they all apply, or a stroke bound
/// alone that also starts chords.
public struct KeyConflict: Equatable {
    public let key: String
    public let commands: [String]
    public let prefix: Bool
}

/// The keybindings: commands, the default and effective bindings of the
/// macOS application (platform "mac") and the user's rules, kept current
/// with the `keybindings` messages of the event channel.
public final class KeybindingsModel {
    public static let platform = "mac"

    public private(set) var sections: [String] = []
    public private(set) var commands: [KeyCommand] = []
    public private(set) var defaults: [KeyBinding] = []
    public private(set) var user: [JSONValue] = []
    public private(set) var effective: [KeyBinding] = []
    public private(set) var conflicts: [KeyConflict] = []
    public private(set) var problems: [SettingProblem] = []
    public private(set) var file = ""
    public private(set) var loaded = false

    public init() {}

    private static func bindings(_ json: JSONValue?) -> [KeyBinding] {
        (json?.array ?? []).compactMap { b in
            guard let key = b["key"]?.string, let command = b["command"]?.string else { return nil }
            return KeyBinding(key: key, command: command, when: b["when"]?.string ?? "terminal")
        }
    }

    /// Takes a `GET /api/keybindings` reply.
    public func load(_ reply: JSONValue) {
        let sorted = (reply["sections"]?.array ?? []).compactMap { s -> (String, Double)? in
            s["id"]?.string.map { ($0, s["order"]?.number ?? 0) }
        }.sorted { $0.1 < $1.1 }
        sections = sorted.map(\.0)
        commands = (reply["commands"]?.array ?? []).compactMap { c in
            guard let id = c["id"]?.string else { return nil }
            return KeyCommand(id: id, section: c["section"]?.string ?? "", when: c["when"]?.string ?? "terminal")
        }
        defaults = Self.bindings(reply["defaults"]?[Self.platform])
        file = reply["file"]?.string ?? ""
        loaded = true
        apply(reply)
    }

    /// Takes the rules and what follows from them, of a reply or a
    /// `keybindings` message.
    @discardableResult
    public func apply(_ message: JSONValue) -> Bool {
        guard let effective = message["effective"]?[Self.platform]?.array else { return false }
        self.effective = Self.bindings(.array(effective))
        user = message["user"]?.array ?? []
        conflicts = (message["conflicts"]?[Self.platform]?.array ?? []).compactMap { c in
            guard let key = c["key"]?.string else { return nil }
            return KeyConflict(key: key, commands: c["commands"]?.array?.compactMap(\.string) ?? [], prefix: c["prefix"]?.bool ?? false)
        }
        problems = (message["problems"]?.array ?? []).map(SettingProblem.init)
        return true
    }

    /// The keys in effect for a command, in order.
    public func keys(of command: String) -> [String] {
        effective.filter { $0.command == command }.map(\.key)
    }

    /// Whether the user's rules change a command's keys.
    public func isChanged(_ command: String) -> Bool {
        user.contains { $0["command"]?.string == command || $0["command"]?.string == "-" + command }
    }

    /// The other commands a key of `command` also runs.
    public func conflicts(of command: String, key: String) -> [String] {
        var out: [String] = []
        for c in conflicts where c.commands.contains(command) {
            let hit = c.key == key || (c.prefix && (key.hasPrefix(c.key + " ") || c.key.hasPrefix(key + " ")))
            if hit { out += c.commands.filter { $0 != command && !out.contains($0) } }
        }
        return out
    }

    /// The rules that give `command` exactly `keys`: other commands' rules
    /// are kept, its own replaced, and defaults it no longer has removed
    /// with "-<command>" rules.
    public static func rules(for command: String, keys: [String], user: [JSONValue], defaults: [KeyBinding]) -> [JSONValue] {
        var out = user.filter { $0["command"]?.string != command && $0["command"]?.string != "-" + command }
        let own = defaults.filter { $0.command == command }.map(\.key)
        for key in own where !keys.contains(key) {
            out.append(.object(["key": .string(key), "command": .string("-" + command)]))
        }
        for key in keys where !own.contains(key) {
            out.append(.object(["key": .string(key), "command": .string(command)]))
        }
        return out
    }

    /// The rules without any of the command's: its defaults again.
    public static func reset(_ command: String, user: [JSONValue]) -> [JSONValue] {
        user.filter { $0["command"]?.string != command && $0["command"]?.string != "-" + command }
    }
}

/// Requests to the core's JSON endpoints, answered on the main queue.
public final class CoreAPI {
    private let core: URL

    public init(core: URL) {
        self.core = core
    }

    /// The reply's status (0 when there was none) and its JSON body.
    public func request(_ method: String, _ path: String, query: [String: String] = [:], body: Any? = nil,
                        done: @escaping (Int, JSONValue?) -> Void)
    {
        var parts = URLComponents(url: core.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { parts.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: parts.url!)
        request.httpMethod = method
        if let body, let data = try? JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed]) {
            request.httpBody = data
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) }.map { JSONValue(any: $0) }
            DispatchQueue.main.async { done(status, json) }
        }.resume()
    }
}
