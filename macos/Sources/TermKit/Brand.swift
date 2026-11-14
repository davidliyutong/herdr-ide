// Product names for the macOS application. Mirrors internal/brand (checked
// by internal/brand/brand_test.go); scripts/rename.sh updates both.

public enum Brand {
    public static let appName = "herdr-ide"
    public static let appSlug = "herdr-ide"

    /// The prefix of the application's environment variables.
    public static var envPrefix: String {
        appSlug.uppercased().replacingOccurrences(of: "-", with: "_") + "_"
    }
}
