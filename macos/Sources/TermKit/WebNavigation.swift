import Foundation

/// What the application's web views (VS Code, program windows, the formula
/// preview) may load: the core's own origin, and inside its pages the
/// documents VS Code builds for its frames.
public enum WebNavigation {
    /// Whether a navigation to `url` may load in a web view showing the core
    /// at `core` (scheme, host and port). `mainFrame` is true for the page
    /// itself and for a navigation without a target frame (a new window).
    /// `about:`, `blob:` and `data:` documents load only in frames inside a
    /// page, where VS Code's webviews and editors use them; as the page
    /// itself only the empty `about:blank` loads.
    public static func allows(_ url: URL?, core: URL, mainFrame: Bool) -> Bool {
        guard let url, let scheme = url.scheme?.lowercased() else { return false }
        switch scheme {
        case "about":
            return !mainFrame || url.absoluteString.lowercased() == "about:blank"
        case "blob", "data":
            return !mainFrame
        default:
            return scheme == core.scheme?.lowercased() && url.host?.lowercased() == core.host?.lowercased() && url.port == core.port
        }
    }
}
