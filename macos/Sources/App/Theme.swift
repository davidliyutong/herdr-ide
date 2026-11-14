import AppKit

/// Text of the interface in the user's language.
func tr(_ key: String, _ args: CVarArg...) -> String {
    let format = Bundle.app.localizedString(forKey: key, value: key, table: nil)
    return args.isEmpty ? format : String(format: format, arguments: args)
}

extension Bundle {
    /// The bundle with the application's resources: the package's own when
    /// SwiftPM builds it, the application's when Xcode does.
    static var app: Bundle {
        #if SWIFT_PACKAGE
            return .module
        #else
            return .main
        #endif
    }
}

/// The design language shared with the web UI: neutral greys, color only
/// for state, dense rows. The values are the design tokens
/// (design/tokens.json, generated into Tokens.swift).
enum Theme {
    private static func dynamic(_ token: Tokens.Color) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return hex(isDark ? token.dark : token.light, alpha: isDark ? token.darkAlpha : token.lightAlpha)
        }
    }

    static func hex(_ value: UInt32, alpha: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat(value >> 16 & 0xff) / 255, green: CGFloat(value >> 8 & 0xff) / 255,
                blue: CGFloat(value & 0xff) / 255, alpha: alpha)
    }

    static let background = dynamic(Tokens.colorBackground)
    static let foreground = dynamic(Tokens.colorForeground)
    static let sidebar = dynamic(Tokens.colorSidebar)
    static let tabBar = dynamic(Tokens.colorTabBar)
    static let tabActive = dynamic(Tokens.colorTabActive)
    static let muted = dynamic(Tokens.colorMuted)
    static let accent = dynamic(Tokens.colorAccent)
    static let border = dynamic(Tokens.colorBorder)
    static let focusRing = dynamic(Tokens.colorFocusRing)

    static let statusWorking = dynamic(Tokens.statusWorking)
    static let statusBlocked = dynamic(Tokens.statusBlocked)
    static let statusDone = dynamic(Tokens.statusDone)
    static let statusError = dynamic(Tokens.statusError)
    static let statusIdle = dynamic(Tokens.statusIdle)

    static func status(_ state: String?) -> NSColor? {
        switch state {
        case "working": return statusWorking
        case "blocked": return statusBlocked
        case "done": return statusDone
        case "error": return statusError
        case "idle": return statusIdle
        default: return nil
        }
    }

    /// A terminal's colors as Ghostty configuration values: the 16 ANSI
    /// colors (black to white, then their bright variants) are the web
    /// UI's default palette (web/src/terminal/options.ts).
    struct TerminalColors {
        var background, foreground, cursor, selection: String
        var palette: [String]
    }

    static func terminalColors(dark: Bool) -> TerminalColors {
        let token = dark ? Tokens.terminalDark : Tokens.terminalLight
        return TerminalColors(background: token.background, foreground: token.foreground, cursor: token.cursor,
                              selection: token.selection, palette: token.palette)
    }

    static let rowHeight = Tokens.metricRowHeight
    static let tabHeight = Tokens.metricTabHeight
    static let sidebarWidth = Tokens.metricSidebarWidth
    static let radius = Tokens.metricRadius
    static let divider = Tokens.metricDivider

    static let font = NSFont.systemFont(ofSize: Tokens.fontSizeBase)
    static let fontStrong = NSFont.systemFont(ofSize: Tokens.fontSizeBase, weight: .medium)
    static let fontSmall = NSFont.systemFont(ofSize: Tokens.fontSizeSmall)
    static let terminalFontSize = Float(Tokens.fontSizeTerminal)
}

/// A view filled with a color that follows the appearance.
final class FillView: NSView {
    var fill: NSColor { didSet { needsDisplay = true } }

    init(_ fill: NSColor) {
        self.fill = fill
        super.init(frame: .zero)
        wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = fill.cgColor
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }
}
