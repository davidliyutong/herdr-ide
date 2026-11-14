import AppKit
import GhosttyTerminal
import TermKit

/// The one Ghostty controller of the application: its colors follow the
/// terminal.colors.* settings in the light and the dark appearance, the
/// other terminal settings become Ghostty configuration (`apply`).
@MainActor
final class TerminalControllerBox {
    let controller: TerminalController

    /// Keys of the menu that are not commands, as Ghostty names them.
    static let systemKeys = ["super+q", "super+h", "super+m"]

    init() {
        controller = TerminalController(theme: Self.theme(nil)) { builder in
            builder.withFontSize(Theme.terminalFontSize)
            builder.withWindowPaddingX(8)
            builder.withWindowPaddingY(6)
        }
        controller.setTerminalConfiguration(Self.configuration(nil, menuKeys: []))
    }

    static func theme(_ settings: SettingsModel?) -> TerminalTheme {
        func colors(dark: Bool) -> TerminalConfiguration {
            let colors = Theme.terminalColors(dark: dark, settings: settings)
            return TerminalConfiguration { builder in
                builder.withBackground(colors.background)
                builder.withForeground(colors.foreground)
                builder.withCursorColor(colors.cursor)
                builder.withSelectionBackground(colors.selection)
                for (index, color) in colors.palette.enumerated() {
                    builder.withPalette(index, color: color)
                }
            }
        }
        return TerminalTheme(light: colors(dark: false), dark: colors(dark: true))
    }

    /// Ghostty's configuration from the terminal settings, and the menu's
    /// single-stroke keys unbound: a terminal with the keyboard takes the
    /// keys Ghostty binds (most Cmd keys) before the menu sees them.
    static func configuration(_ settings: SettingsModel?, menuKeys: [String]) -> TerminalConfiguration {
        TerminalConfiguration { builder in
            for key in systemKeys + menuKeys.flatMap(Keys.ghosttyTriggers) {
                builder.withCustom("keybind", key + "=unbind")
            }
            guard let s = settings, s.loaded else { return }
            let family = s.string("terminal.fontFamily", "").trimmingCharacters(in: .whitespaces)
            if !family.isEmpty { builder.withFontFamily(family) }
            builder.withFontSize(Float(s.number("terminal.fontSize", Double(Theme.terminalFontSize))))
            builder.withFontThicken(s.string("terminal.fontWeight", "regular") == "medium")
            let extra = Int(((s.number("terminal.lineHeight", 1.05) - 1) * 100).rounded())
            builder.withCustom("adjust-cell-height", "\(extra)%")
            builder.withCursorStyle(TerminalCursorStyle(rawValue: s.string("terminal.cursorStyle", "block")) ?? .block)
            builder.withCursorStyleBlink(s.bool("terminal.cursorBlink", true))
            // Ghostty bounds its scrollback in bytes: about 2 KB a line.
            let lines = max(0, s.number("terminal.scrollback", 10000))
            builder.withCustom("scrollback-limit", String(Int(lines) * 2048))
            builder.withCustom("copy-on-select", s.bool("terminal.copyOnSelect", false) ? "clipboard" : "false")
            builder.withCustom("bold-is-bright", s.bool("terminal.boldIsBright", false) ? "true" : "false")
            builder.withCustom("macos-option-as-alt", s.bool("terminal.optionIsMeta", false) ? "true" : "false")
            let clipboard = ["auto": "allow", "ask": "ask", "off": "deny"][s.string("terminal.programClipboard", "auto")] ?? "allow"
            builder.withCustom("clipboard-write", clipboard)
        }
    }

    /// Applies the settings and the menu's keys to every terminal.
    func apply(_ settings: SettingsModel, menuKeys: [String]) {
        controller.setTheme(Self.theme(settings))
        controller.setTerminalConfiguration(Self.configuration(settings, menuKeys: menuKeys))
    }
}

/// The tabs of the selected machine's selected workspace: a click selects
/// one, a double click renames it, dragging moves it, its menu renames,
/// moves and closes it. A pane dragged here moves into the tab (or a new
/// one, on the plus button).
final class TabBar: NSView {
    private let model: AppModel
    private let stack = NSStackView()
    private(set) var buttons: [NSView] = []
    private(set) var addButton: NSButton?
    var dialogs: Dialogs?
    /// Views at the end of the bar (transfers).
    let trailing = NSStackView()

    init(model: AppModel) {
        self.model = model
        super.init(frame: .zero)
        let background = FillView(Theme.tabBar)
        let border = FillView(Theme.border)
        stack.orientation = .horizontal
        stack.spacing = 2
        stack.alignment = .centerY
        trailing.orientation = .horizontal
        trailing.spacing = 6
        for view in [background, stack, trailing, border] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Theme.tabHeight),
            background.topAnchor.constraint(equalTo: topAnchor), background.bottomAnchor.constraint(equalTo: bottomAnchor),
            background.leadingAnchor.constraint(equalTo: leadingAnchor), background.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6), stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailing.leadingAnchor, constant: -6),
            trailing.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8), trailing.centerYAnchor.constraint(equalTo: centerYAnchor),
            border.bottomAnchor.constraint(equalTo: bottomAnchor), border.heightAnchor.constraint(equalToConstant: Theme.divider),
            border.leadingAnchor.constraint(equalTo: leadingAnchor), border.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    func update() {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        buttons = []
        addButton = nil
        guard let machine = model.selectedMachine else { return }
        let workspace = model.layout.selectedWorkspace
        for (index, tab) in (workspace?.tabs ?? []).enumerated() {
            let record = model.store.terminal(tab.focused, on: machine)
            let button = TabButton(title: tab.name ?? record?.displayName ?? tab.focused, dot: Theme.status(Activity.status(record)),
                                   selected: index == workspace?.selected)
            button.onPress = { [weak self] event in self?.pressed(index, event) }
            button.menuBuilder = { [weak self] in self?.menu(index) }
            stack.addArrangedSubview(button)
            buttons.append(button)
        }
        guard !model.readOnly else { return }
        let add = ClosureButton(symbol: "plus", tip: tr("menu.newTerminal")) { [weak self] in self?.model.newTerminal() }
        stack.addArrangedSubview(add)
        addButton = add
    }

    /// A click selects, a double click renames, a drag moves the tab.
    private func pressed(_ index: Int, _ event: NSEvent) {
        if event.clickCount == 2, !model.readOnly { return dialogs?.renameTab(index) ?? () }
        let moved = !model.readOnly && DragTracker.track(event) { [weak self] point in
            guard let self, let window, let content = window.contentView else { return nil }
            let frames = self.buttons.map { $0.convert($0.bounds, to: content) }
            guard let first = frames.first, let last = frames.last, abs(point.y - first.midY) < 40 else { return nil }
            let slot = frames.firstIndex { point.x < $0.midX } ?? frames.count
            guard slot != index, slot != index + 1 else { return nil }
            let x = slot == frames.count ? last.maxX + 1 : frames[slot].minX - 1
            return (NSRect(x: x - 1, y: first.minY, width: 3, height: first.height), { [weak self] in self?.model.moveTab(index, toSlot: slot) })
        }
        if !moved { model.selectTab(index) }
    }

    private func menu(_ index: Int) -> NSMenu? {
        guard !model.readOnly, let count = model.layout.selectedWorkspace?.tabs.count else { return nil }
        let menu = ClosureMenu()
        menu.item(tr("menu.renameTab"), symbol: "pencil") { [weak self] in self?.dialogs?.renameTab(index) }
        menu.item(tr("menu.newTerminal"), symbol: "plus") { [weak self] in self?.model.newTerminal() }
        menu.separator()
        menu.item(tr("menu.moveLeft"), symbol: "arrow.left", enabled: index > 0) { [weak self] in self?.model.moveTab(index, toSlot: index - 1) }
        menu.item(tr("menu.moveRight"), symbol: "arrow.right", enabled: index < count - 1) { [weak self] in
            self?.model.moveTab(index, toSlot: index + 2)
        }
        menu.separator()
        menu.item(tr("menu.closeTab"), symbol: "xmark") { [weak self] in self?.dialogs?.closeTab(index) }
        return menu
    }

    /// The tab (or the plus button: nil) under a point of the window's
    /// content view, with its frame there.
    func target(at point: NSPoint) -> (index: Int?, frame: NSRect)? {
        guard let content = window?.contentView else { return nil }
        for (index, button) in buttons.enumerated() {
            let frame = button.convert(button.bounds, to: content)
            if frame.contains(point) { return (index, frame) }
        }
        if let add = addButton {
            let frame = add.convert(add.bounds, to: content).insetBy(dx: -4, dy: -4)
            if frame.contains(point) { return (nil, frame) }
        }
        return nil
    }
}

private final class TabButton: NSView {
    var onPress: ((NSEvent) -> Void)?
    var menuBuilder: (() -> NSMenu?)?

    init(title: String, dot: NSColor?, selected: Bool) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = Theme.radius
        let fill = FillView(selected ? Theme.tabActive : .clear)
        fill.wantsLayer = true
        fill.layer?.cornerRadius = Theme.radius
        fill.layer?.masksToBounds = true
        let label = NSTextField(labelWithString: title)
        label.font = selected ? Theme.fontStrong : Theme.font
        label.textColor = selected ? Theme.foreground : Theme.muted
        label.lineBreakMode = .byTruncatingTail
        let mark = FillView(dot ?? .clear)
        mark.wantsLayer = true
        mark.layer?.cornerRadius = 3
        mark.layer?.masksToBounds = true
        for view in [fill, mark, label] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        let labelLeading = dot == nil ? label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10)
            : label.leadingAnchor.constraint(equalTo: mark.trailingAnchor, constant: 6)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Theme.tabHeight - 8),
            widthAnchor.constraint(lessThanOrEqualToConstant: 200),
            fill.topAnchor.constraint(equalTo: topAnchor), fill.bottomAnchor.constraint(equalTo: bottomAnchor),
            fill.leadingAnchor.constraint(equalTo: leadingAnchor), fill.trailingAnchor.constraint(equalTo: trailingAnchor),
            mark.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10), mark.centerYAnchor.constraint(equalTo: centerYAnchor),
            mark.widthAnchor.constraint(equalToConstant: 6), mark.heightAnchor.constraint(equalToConstant: 6),
            labelLeading, label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override func mouseDown(with event: NSEvent) { onPress?(event) }

    override func menu(for _: NSEvent) -> NSMenu? { menuBuilder?() }
}
