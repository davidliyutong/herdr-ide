import Foundation

// The core's terminal protocol (/api/v1/term): JSON text messages with a
// "t" field and binary frames [stream u32 LE][kind u8][payload].

public enum FrameKind: UInt8 {
    /// Output to the client, input from it.
    case data = 0
    /// To the client: cols u16 LE, rows u16 LE of an observed terminal.
    case resize = 3
    /// From the client: its terminal's own answers to the program.
    case automatic = 6
}

public struct Frame: Equatable {
    public var stream: UInt32
    public var kind: UInt8
    public var payload: Data

    public init(stream: UInt32, kind: FrameKind, payload: Data) {
        self.stream = stream
        self.kind = kind.rawValue
        self.payload = payload
    }

    public func encoded() -> Data {
        var out = Data(capacity: 5 + payload.count)
        withUnsafeBytes(of: stream.littleEndian) { out.append(contentsOf: $0) }
        out.append(kind)
        out.append(payload)
        return out
    }

    /// Decodes a binary message; nil when it is shorter than a frame's head.
    public init?(_ data: Data) {
        guard data.count >= 5 else { return nil }
        let base = data.startIndex
        stream = UInt32(data[base]) | UInt32(data[base + 1]) << 8 | UInt32(data[base + 2]) << 16 | UInt32(data[base + 3]) << 24
        kind = data[base + 4]
        payload = data.subdata(in: (base + 5)..<data.endIndex)
    }

    /// The grid of a resize frame.
    public var grid: (cols: Int, rows: Int)? {
        guard kind == FrameKind.resize.rawValue, payload.count == 4 else { return nil }
        let b = payload.startIndex
        return (Int(payload[b]) | Int(payload[b + 1]) << 8, Int(payload[b + 2]) | Int(payload[b + 3]) << 8)
    }
}

/// A failed call: the core's error kind ("not_found", "read_only",
/// "refused", "unavailable", ...).
public struct TermError: Error, Equatable {
    public var kind: String
    public var message: String

    public init(kind: String, message: String = "") {
        self.kind = kind
        self.message = message
    }
}

/// What a machine's terminal backend is doing, with the code of an error.
public struct BackendState: Equatable {
    public enum Phase: String { case starting, ready, error }
    public var phase: Phase
    public var code: String
    public var version: String

    public init(phase: Phase, code: String = "", version: String = "") {
        self.phase = phase
        self.code = code
        self.version = version
    }
}

/// A terminal as the core reports it. `raw` keeps every field.
public struct TerminalRecord: Equatable, Identifiable {
    public var raw: [String: Any]

    public init(raw: [String: Any]) {
        self.raw = raw
    }

    public static func == (a: TerminalRecord, b: TerminalRecord) -> Bool {
        NSDictionary(dictionary: a.raw).isEqual(to: b.raw)
    }

    public var id: String { address }
    public var address: String { raw["address"] as? String ?? "" }
    public var name: String? { raw["name"] as? String }
    public var title: String { raw["title"] as? String ?? "" }
    public var cwd: String { raw["cwd"] as? String ?? "" }
    public var isLive: Bool { raw["state"] as? String == "live" }
    public var argv: [String] { raw["argv"] as? [String] ?? [] }
    public var labels: [String: String] { raw["labels"] as? [String: String] ?? [:] }
    public var createdMS: Int { raw["created_ms"] as? Int ?? 0 }

    /// What the program says it is doing (OSC 7501), nil if it never said.
    public var status: String? { (raw["status"] as? [String: Any])?["state"] as? String }

    /// The program in the foreground, by name.
    public var foreground: String? { (raw["foreground"] as? [String: Any])?["name"] as? String }

    /// What to call the terminal in a list: its name, its title, the
    /// program in it, or its address.
    public var displayName: String {
        if let name, !name.isEmpty { return name }
        if !title.isEmpty { return title }
        if let foreground, !foreground.isEmpty { return foreground }
        if let first = argv.first { return (first as NSString).lastPathComponent }
        return address
    }
}
