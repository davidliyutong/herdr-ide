import Foundation

/// Folders of this Mac opened in the application: dropped on the sidebar or
/// the Dock icon, also when the drop launched it. Only folders become
/// workspaces.
public enum LocalFolders {
    /// The paths that are directories, in order, and how many are not.
    public static func split(_ paths: [String], fileManager: FileManager = .default) -> (folders: [String], others: Int) {
        var folders: [String] = []
        for path in paths {
            var isDir: ObjCBool = false
            if fileManager.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue { folders.append(path) }
        }
        return (folders, paths.count - folders.count)
    }
}

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

    /// The line a path printed as `path:line[:column]` points at.
    public static func line(_ text: String) -> Int? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let range = t.range(of: #":(\d+)(:\d+)?:?$"#, options: .regularExpression) else { return nil }
        return Int(t[range].dropFirst().prefix { $0.isNumber })
    }

    /// Media the system's Quick Look shows: a ⌘-click previews these and
    /// opens other files in VS Code, as the web UI does.
    public static func isMedia(_ path: String) -> Bool {
        let media: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "mp4", "webm", "mov", "m4v", "mkv",
                                  "mp3", "wav", "ogg", "flac", "m4a", "aac", "pdf"]
        return media.contains((path as NSString).pathExtension.lowercased())
    }

    /// A name for the local copy of a previewed file: the path's last
    /// component, without anything that would leave the directory it is
    /// written to.
    public static func fileName(_ path: String) -> String {
        let name = (path as NSString).lastPathComponent
        return name.isEmpty || name == "/" || name == "." || name == ".." || name == "~" ? "file" : name
    }
}
