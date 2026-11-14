import Foundation

/// File paths as programs print them in a terminal.
public enum TerminalPath {
    /// The path a piece of output names on its machine, nil when it is not
    /// a path the application can ask for: absolute as it is, `~` kept for
    /// the machine to expand, anything else relative to `cwd`. A trailing
    /// `:line` or `:line:column`, as compilers print, is dropped.
    public static func resolve(_ text: String, cwd: String) -> String? {
        var path = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.hasPrefix("file://") {
            guard let url = URL(string: path), url.host == nil || url.host == "" || url.host == "localhost" else { return nil }
            path = url.path
        }
        if let range = path.range(of: #":\d+(:\d+)?:?$"#, options: .regularExpression) {
            path.removeSubrange(range)
        }
        guard !path.isEmpty, !path.contains("\0"), !path.contains("://") else { return nil }
        if path.hasPrefix("/") || path == "~" || path.hasPrefix("~/") { return path }
        guard cwd.hasPrefix("/") else { return nil }
        return (cwd as NSString).appendingPathComponent(path)
    }

    /// A name for the local copy of a previewed file: the path's last
    /// component, without anything that would leave the directory it is
    /// written to.
    public static func fileName(_ path: String) -> String {
        let name = (path as NSString).lastPathComponent
        return name.isEmpty || name == "/" || name == "." || name == ".." || name == "~" ? "file" : name
    }
}
