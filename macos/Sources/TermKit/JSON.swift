import Foundation

/// A JSON value, for documents whose fields a newer client may extend:
/// what this version does not know is kept as it was and written back.
public enum JSONValue: Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    /// A value as `JSONSerialization` returns it; anything else is null.
    public init(any value: Any?) {
        switch value {
        case let number as NSNumber:
            // JSONSerialization's booleans are NSNumbers too.
            self = CFGetTypeID(number) == CFBooleanGetTypeID() ? .bool(number.boolValue) : .number(number.doubleValue)
        case let string as String: self = .string(string)
        case let array as [Any]: self = .array(array.map { JSONValue(any: $0) })
        case let object as [String: Any]: self = .object(object.mapValues { JSONValue(any: $0) })
        default: self = .null
        }
    }

    /// The value as `JSONSerialization` writes it.
    public var any: Any {
        switch self {
        case .null: return NSNull()
        case let .bool(value): return value
        case let .number(value): return value
        case let .string(value): return value
        case let .array(values): return values.map(\.any)
        case let .object(fields): return fields.mapValues(\.any)
        }
    }

    public var string: String? { if case let .string(value) = self { return value } else { return nil } }
    public var number: Double? { if case let .number(value) = self { return value } else { return nil } }
    public var bool: Bool? { if case let .bool(value) = self { return value } else { return nil } }
    public var array: [JSONValue]? { if case let .array(values) = self { return values } else { return nil } }
    public var object: [String: JSONValue]? { if case let .object(fields) = self { return fields } else { return nil } }

    public subscript(key: String) -> JSONValue? { object?[key] }
}
