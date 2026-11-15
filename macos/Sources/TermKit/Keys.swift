import Foundation

/// One key press with its modifiers, as keybindings write it: modifiers in
/// the order cmd, ctrl, alt, shift and keys named after the US layout's
/// unshifted keys ("?" is "shift+slash"). internal/keybindings and
/// web/src/keys.ts use the same rules; design/testdata/keys holds the
/// vectors all three are tested with.
public struct KeyStroke: Equatable, CustomStringConvertible {
    public var cmd = false
    public var ctrl = false
    public var alt = false
    public var shift = false
    public var key: String

    public init(cmd: Bool = false, ctrl: Bool = false, alt: Bool = false, shift: Bool = false, key: String) {
        self.cmd = cmd
        self.ctrl = ctrl
        self.alt = alt
        self.shift = shift
        self.key = key
    }

    public var description: String {
        var parts: [String] = []
        if cmd { parts.append("cmd") }
        if ctrl { parts.append("ctrl") }
        if alt { parts.append("alt") }
        if shift { parts.append("shift") }
        parts.append(key)
        return parts.joined(separator: "+")
    }
}

/// Why a key sequence was refused: empty, modifier, key, repeat, typing or
/// length.
public struct KeyParseError: Error, Equatable {
    public let code: String
}

/// Key sequences: one stroke ("cmd+t") or a chord of several separated by
/// spaces ("ctrl+k c").
public enum Keys {
    public static let maxStrokes = 4

    /// Commands that close something of the main window. Their keys (⌘W)
    /// typed while another window of the application has the keyboard close
    /// that window instead.
    public static let closing: Set<String> = ["pane.close", "tab.close", "workspace.close"]

    private static let modifiers: [String: String] = [
        "cmd": "cmd", "command": "cmd", "meta": "cmd", "super": "cmd", "win": "cmd",
        "ctrl": "ctrl", "control": "ctrl", "alt": "alt", "option": "alt", "opt": "alt", "shift": "shift",
    ]

    /// Named keys with the character they type without Shift (US layout)
    /// and with it.
    private static let named: [String: (char: String?, shifted: String?)] = [
        "tab": (nil, nil), "space": (" ", nil), "enter": (nil, nil), "escape": (nil, nil), "backspace": (nil, nil),
        "delete": (nil, nil), "insert": (nil, nil), "left": (nil, nil), "right": (nil, nil), "up": (nil, nil),
        "down": (nil, nil), "home": (nil, nil), "end": (nil, nil), "pageup": (nil, nil), "pagedown": (nil, nil),
        "minus": ("-", "_"), "equal": ("=", "+"), "comma": (",", "<"), "period": (".", ">"), "slash": ("/", "?"),
        "backslash": ("\\", "|"), "semicolon": (";", ":"), "quote": ("'", "\""), "backtick": ("`", "~"),
        "bracketleft": ("[", "{"), "bracketright": ("]", "}"),
    ]

    private static let aliases: [String: String] = [
        "esc": "escape", "return": "enter", "del": "delete", "ins": "insert", "arrowleft": "left", "arrowright": "right",
        "arrowup": "up", "arrowdown": "down", "pgup": "pageup", "pgdn": "pagedown", "pgdown": "pagedown",
    ]

    private static let shiftedDigits = Array(")!@#$%^&*(").map(String.init)

    private static let byChar: [String: String] = {
        var out: [String: String] = [:]
        for (name, n) in named { if let c = n.char { out[c] = name } }
        return out
    }()

    private static let byShifted: [String: String] = {
        var out: [String: String] = ["plus": "equal", "+": "equal"]
        for (name, n) in named { if let c = n.shifted { out[c] = name } }
        for (i, c) in shiftedDigits.enumerated() { out[c] = String(i) }
        return out
    }()

    /// Whether `name` is a key name of the syntax ("t", "1", "f5", "comma"…).
    public static func isKeyName(_ name: String) -> Bool {
        isPlain(name) || named[name] != nil
    }

    private static func isPlain(_ name: String) -> Bool {
        if name.count == 1, let c = name.unicodeScalars.first, ("a" ... "z").contains(c) || ("0" ... "9").contains(c) { return true }
        return isFunction(name)
    }

    private static func isFunction(_ name: String) -> Bool {
        guard name.hasPrefix("f"), let n = Int(name.dropFirst()), String(n) == name.dropFirst() else { return false }
        return (1 ... 24).contains(n)
    }

    private static func parseStroke(_ text: String) throws -> KeyStroke {
        let lower = text.lowercased()
        var parts: [String]
        if lower == "+" {
            parts = ["+"]
        } else if lower.hasSuffix("++") {
            parts = String(lower.dropLast(2)).components(separatedBy: "+") + ["+"]
        } else {
            parts = lower.components(separatedBy: "+")
        }
        var key = parts.removeLast()
        var stroke = KeyStroke(key: "")
        for part in parts {
            guard let m = modifiers[part] else { throw KeyParseError(code: "modifier") }
            switch m {
            case "cmd":
                if stroke.cmd { throw KeyParseError(code: "repeat") }
                stroke.cmd = true
            case "ctrl":
                if stroke.ctrl { throw KeyParseError(code: "repeat") }
                stroke.ctrl = true
            case "alt":
                if stroke.alt { throw KeyParseError(code: "repeat") }
                stroke.alt = true
            default:
                if stroke.shift { throw KeyParseError(code: "repeat") }
                stroke.shift = true
            }
        }
        if let alias = aliases[key] {
            key = alias
        } else if let name = byChar[key] {
            key = name
        } else if let name = byShifted[key] {
            key = name
            stroke.shift = true
        }
        if key.isEmpty { throw KeyParseError(code: "empty") }
        guard isKeyName(key) else { throw KeyParseError(code: "key") }
        stroke.key = key
        return stroke
    }

    /// Reads a key sequence. The first stroke must hold cmd, ctrl or alt (or
    /// be a function key), so a binding never takes a key that types text.
    public static func parse(_ text: String) throws -> [KeyStroke] {
        let fields = text.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" }).map(String.init)
        if fields.isEmpty { throw KeyParseError(code: "empty") }
        if fields.count > maxStrokes { throw KeyParseError(code: "length") }
        let strokes = try fields.map(parseStroke)
        let first = strokes[0]
        if !first.cmd, !first.ctrl, !first.alt, !isFunction(first.key) { throw KeyParseError(code: "typing") }
        return strokes
    }

    /// The canonical form of a key sequence.
    public static func normalize(_ text: String) throws -> String {
        try parse(text).map(\.description).joined(separator: " ")
    }

    /// macOS virtual key codes of the US layout's keys, for keys whose
    /// character names nothing (non-Latin layouts, Shift, function keys).
    private static let keyCodes: [UInt16: String] = [
        0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x", 8: "c", 9: "v", 11: "b", 12: "q", 13: "w", 14: "e",
        15: "r", 16: "y", 17: "t", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "equal", 25: "9", 26: "7",
        27: "minus", 28: "8", 29: "0", 30: "bracketright", 31: "o", 32: "u", 33: "bracketleft", 34: "i", 35: "p", 36: "enter",
        37: "l", 38: "j", 39: "quote", 40: "k", 41: "semicolon", 42: "backslash", 43: "comma", 44: "slash", 45: "n", 46: "m",
        47: "period", 48: "tab", 49: "space", 50: "backtick", 51: "backspace", 53: "escape", 76: "enter",
        96: "f5", 97: "f6", 98: "f7", 99: "f3", 100: "f8", 101: "f9", 103: "f11", 105: "f13", 106: "f16", 107: "f14",
        109: "f10", 111: "f12", 113: "f15", 114: "insert", 115: "home", 116: "pageup", 117: "delete", 118: "f4", 119: "end",
        120: "f2", 121: "pagedown", 122: "f1", 123: "left", 124: "right", 125: "down", 126: "up", 64: "f17", 79: "f18",
        80: "f19", 90: "f20",
    ]

    /// The name of a pressed key: its character on the current layout
    /// (AppKit's charactersIgnoringModifiers) when that is a letter, digit or
    /// named punctuation, else the key at its place on a US layout. Shift
    /// does not change it.
    public static func keyName(characters: String, keyCode: UInt16) -> String? {
        let c = characters.lowercased()
        if c.count == 1, let scalar = c.unicodeScalars.first, scalar.isASCII {
            if ("a" ... "z").contains(scalar) || ("0" ... "9").contains(scalar) { return c }
            if let name = byChar[c] { return name }
        }
        return keyCodes[keyCode]
    }

    /// The stroke of a key press; nil for a lone modifier.
    public static func stroke(characters: String, keyCode: UInt16, cmd: Bool, ctrl: Bool, alt: Bool, shift: Bool) -> String? {
        guard let key = keyName(characters: characters, keyCode: keyCode) else { return nil }
        return KeyStroke(cmd: cmd, ctrl: ctrl, alt: alt, shift: shift, key: key).description
    }

    /// How a key sequence is shown in menus and settings, with macOS's
    /// modifier symbols: "⌃B C", "⌘}", "⇧⌘D".
    public static func label(_ seq: String) -> String {
        seq.split(separator: " ").map { part -> String in
            guard let stroke = try? parseStroke(String(part)) else { return String(part) }
            var mods = ""
            if stroke.ctrl { mods += "⌃" }
            if stroke.alt { mods += "⌥" }
            var key = keyLabel(stroke.key)
            if stroke.shift, let shifted = shiftedChar(stroke.key) {
                key = shifted
            } else if stroke.shift {
                mods += "⇧"
            }
            if stroke.cmd { mods += "⌘" }
            return mods + key
        }.joined(separator: " ")
    }

    private static func shiftedChar(_ key: String) -> String? {
        if let s = named[key]?.shifted { return s }
        if let d = Int(key), key.count == 1 { return shiftedDigits[d] }
        return nil
    }

    private static func keyLabel(_ key: String) -> String {
        let symbols = ["tab": "⇥", "space": "Space", "enter": "↩", "escape": "⎋", "backspace": "⌫", "delete": "⌦",
                       "left": "←", "right": "→", "up": "↑", "down": "↓", "home": "↖", "end": "↘", "pageup": "⇞",
                       "pagedown": "⇟", "insert": "Ins"]
        if let s = symbols[key] { return s }
        if let c = named[key]?.char { return c }
        return key.uppercased()
    }

    /// A menu item's key equivalent for a single stroke: the character and
    /// the modifiers; nil for a chord. A shifted key is its shifted
    /// character, as menus name it.
    public static func menuEquivalent(_ seq: String) -> (key: String, cmd: Bool, ctrl: Bool, alt: Bool, shift: Bool)? {
        guard let strokes = try? parse(seq), strokes.count == 1 else { return nil }
        let s = strokes[0]
        let functionKeys: [String: Int] = ["left": 0xF702, "right": 0xF703, "up": 0xF700, "down": 0xF701, "home": 0xF729,
                                           "end": 0xF72B, "pageup": 0xF72C, "pagedown": 0xF72D, "delete": 0xF728]
        var key: String
        var shift = s.shift
        if let code = functionKeys[s.key], let scalar = Unicode.Scalar(code) {
            key = String(Character(scalar))
        } else if isFunction(s.key), let n = Int(s.key.dropFirst()), let scalar = Unicode.Scalar(0xF704 + n - 1) {
            key = String(Character(scalar))
        } else if let c = ["tab": "\t", "space": " ", "enter": "\r", "escape": "\u{1b}", "backspace": "\u{8}"][s.key] {
            key = c
        } else if s.shift, let shifted = shiftedChar(s.key) {
            key = shifted
            shift = false
        } else if s.shift, s.key.count == 1, s.key.unicodeScalars.first.map({ ("a" ... "z").contains($0) }) == true {
            key = s.key.uppercased()
            shift = false
        } else {
            key = named[s.key]?.char ?? s.key
        }
        return (key, s.cmd, s.ctrl, s.alt, shift)
    }

    /// Ghostty's names of a single stroke, for unbinding it in the terminal
    /// so the application's menu gets the key: the key by name and by
    /// character where it has one ("super+shift+d", "super+comma",
    /// "super+,").
    public static func ghosttyTriggers(_ seq: String) -> [String] {
        guard let strokes = try? parse(seq), strokes.count == 1 else { return [] }
        let s = strokes[0]
        var mods: [String] = []
        if s.cmd { mods.append("super") }
        if s.ctrl { mods.append("ctrl") }
        if s.alt { mods.append("alt") }
        if s.shift { mods.append("shift") }
        let names: [String: String] = ["left": "arrow_left", "right": "arrow_right", "up": "arrow_up", "down": "arrow_down",
                                       "pageup": "page_up", "pagedown": "page_down", "bracketleft": "left_bracket",
                                       "bracketright": "right_bracket", "backtick": "grave_accent", "quote": "apostrophe"]
        var keys = [names[s.key] ?? s.key]
        if let c = named[s.key]?.char, c != " ", !keys.contains(c) { keys.append(c) }
        return keys.map { (mods + [$0]).joined(separator: "+") }
    }
}

/// A binding in effect: a key sequence, the command it runs and where.
public struct KeyBinding: Equatable {
    public var key: String
    public var command: String
    public var when: String

    public init(key: String, command: String, when: String) {
        self.key = key
        self.command = command
        self.when = when
    }
}

/// Matches strokes against bindings, chords included (users bind chords; no
/// default is one): a stroke that starts a chord waits for the next; the
/// chord's first stroke pressed again goes on to the terminal like a key no
/// binding takes (so it can still be typed); a chord that matches nothing
/// ends and its last key is dropped.
public struct KeyMatcher {
    public enum Result: Equatable {
        /// The key is not the application's.
        case none
        case pending
        case run(String)
        /// The chord's first stroke, pressed again: this press goes on to
        /// the terminal.
        case literal(String)
        case swallow
    }

    public private(set) var pending = ""

    public init() {}

    public static func applies(_ when: String, in context: String) -> Bool {
        when == "always" || when == context
    }

    /// Feeds one stroke, in `context` (terminal, vscode or dialog).
    public mutating func feed(_ stroke: String, bindings: [KeyBinding], context: String) -> Result {
        let live = bindings.filter { Self.applies($0.when, in: context) }
        let seq = pending.isEmpty ? stroke : pending + " " + stroke
        let previous = pending
        if let exact = live.first(where: { $0.key == seq }) {
            pending = ""
            return .run(exact.command)
        }
        if live.contains(where: { $0.key.hasPrefix(seq + " ") }) {
            pending = seq
            return .pending
        }
        pending = ""
        if previous.isEmpty { return .none }
        if !previous.contains(" "), stroke == previous { return .literal(previous) }
        return .swallow
    }

    public mutating func reset() { pending = "" }
}
