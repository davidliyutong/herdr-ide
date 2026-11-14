import AppKit
import TermKit

/// The settings window, built from the definitions the core serves
/// (`GET /api/settings`, `SettingsModel`): a page per section and one for
/// the keyboard shortcuts, a search across them, a control per type (switch,
/// menu, number, text, color well, the 16-color palette), a marker on changed
/// settings, reset, machines' own values, the lock of a command-line flag,
/// the file's problems, and a button that shows settings.json in the Finder.
/// A setting is named by `settings.<key>`, described by `settings.<key>.desc`
/// and its options by `settings.<key>.<option>`; one without a translation
/// shows its key.
final class SettingsWindow: NSObject, NSWindowDelegate, NSTextFieldDelegate, NSSearchFieldDelegate {
    private let model: AppModel
    /// The commands this application runs; the others are marked.
    private let supported: Set<String>
    private var window: NSWindow?
    private let nav = NSStackView()
    private let stack = NSStackView()
    private let search = NSSearchField()
    private let openButton = NSButton(title: "", target: nil, action: nil)
    private var page = "appearance"
    private var handlers: [Handler] = []
    /// A change arrived while a field was being edited: the page is built
    /// again when editing ends.
    private var stale = false
    private var colorTimers: [String: Timer] = [:]

    static let keysPage = "keys"

    init(model: AppModel, supported: Set<String>) {
        self.model = model
        self.supported = supported
    }

    func show(page: String? = nil) {
        if window == nil { build() }
        if let page { self.page = page }
        window?.makeKeyAndOrderFront(nil)
        rebuild()
    }

    /// The settings or keybindings changed.
    func refresh() {
        guard window?.isVisible == true else { return }
        // A field being edited would lose what was typed; the search field
        // is not rebuilt.
        if let editor = window?.firstResponder as? NSTextView, editor.delegate as? NSSearchField !== search {
            stale = true
        } else {
            rebuild()
        }
    }

    // MARK: - Window

    private func build() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 640),
                              styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = tr("settings.title")
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.minSize = NSSize(width: 640, height: 420)
        let root = NSView()

        nav.orientation = .vertical
        nav.alignment = .leading
        nav.spacing = 2
        nav.edgeInsets = NSEdgeInsets(top: 12, left: 10, bottom: 12, right: 10)
        let navBackground = FillView(Theme.sidebar)
        let divider = FillView(Theme.border)

        search.placeholderString = tr("settings.search")
        search.delegate = self
        search.sendsSearchStringImmediately = true
        openButton.target = self
        openButton.action = #selector(openFile)
        openButton.bezelStyle = .rounded

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 24, bottom: 24, right: 24)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let document = FlippedView()
        document.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        scroll.documentView = document

        for view in [navBackground, nav, divider, search, openButton, scroll] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(view)
        }
        NSLayoutConstraint.activate([
            navBackground.topAnchor.constraint(equalTo: root.topAnchor), navBackground.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            navBackground.leadingAnchor.constraint(equalTo: root.leadingAnchor), navBackground.widthAnchor.constraint(equalToConstant: 190),
            nav.topAnchor.constraint(equalTo: root.topAnchor), nav.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            nav.widthAnchor.constraint(equalTo: navBackground.widthAnchor),
            divider.topAnchor.constraint(equalTo: root.topAnchor), divider.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            divider.leadingAnchor.constraint(equalTo: navBackground.trailingAnchor), divider.widthAnchor.constraint(equalToConstant: Theme.divider),
            search.topAnchor.constraint(equalTo: root.topAnchor, constant: 12),
            search.leadingAnchor.constraint(equalTo: divider.trailingAnchor, constant: 24),
            search.widthAnchor.constraint(equalToConstant: 260),
            openButton.centerYAnchor.constraint(equalTo: search.centerYAnchor),
            openButton.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            scroll.topAnchor.constraint(equalTo: search.bottomAnchor, constant: 6), scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: divider.trailingAnchor), scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            stack.topAnchor.constraint(equalTo: document.topAnchor), stack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])
        window.contentView = root
        window.center()
        self.window = window
    }

    /// Opens the settings file (or the keybindings file, from the keyboard
    /// page) in the application that edits JSON; without one, or before the
    /// file exists, shows it in the Finder.
    @objc private func openFile() {
        let path = page == Self.keysPage ? model.keybindings.file : model.settings.file
        guard !path.isEmpty else { return }
        let url = URL(fileURLWithPath: path)
        if !FileManager.default.fileExists(atPath: path) {
            NSWorkspace.shared.open(url.deletingLastPathComponent())
        } else if !NSWorkspace.shared.open(url) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
    }

    func controlTextDidChange(_ notification: Notification) {
        if notification.object as? NSSearchField === search { rebuild() }
    }

    func controlTextDidEndEditing(_ notification: Notification) {
        if stale {
            stale = false
            DispatchQueue.main.async { [weak self] in self?.rebuild() }
        }
    }

    // MARK: - Text

    /// A translation, or nil when the strings have none.
    static func text(_ key: String) -> String? {
        let value = tr(key)
        return value == key ? nil : value
    }

    private func label(_ key: String) -> String { Self.text("settings." + key) ?? key }

    private func optionLabel(_ key: String, _ option: String) -> String { Self.text("settings.\(key).\(option)") ?? option }

    private func valueLabel(_ definition: SettingDefinition, _ value: JSONValue) -> String {
        switch definition.type {
        case "bool": return tr(value.bool == true ? "settings.on" : "settings.off")
        case "enum": return optionLabel(definition.key, value.string ?? "")
        default: return value.string ?? value.number.map { String(format: "%g", $0) } ?? ""
        }
    }

    // MARK: - Pages

    private func rebuild() {
        handlers.removeAll()
        window?.title = tr("settings.title")
        search.placeholderString = tr("settings.search")
        let file = page == Self.keysPage ? model.keybindings.file : model.settings.file
        openButton.title = tr("settings.openNamed", (file as NSString).lastPathComponent)
        openButton.isHidden = file.isEmpty
        nav.arrangedSubviews.forEach { $0.removeFromSuperview() }
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let settings = model.settings
        let sections = settings.sections.filter { !settings.definitions(in: $0).isEmpty }
        let query = search.stringValue.trimmingCharacters(in: .whitespaces)
        for id in sections + [Self.keysPage] {
            let title = id == Self.keysPage ? tr("settings.section.keyboard") : Self.text("settings.section." + id) ?? id
            let button = NSButton(title: title, target: nil, action: nil)
            button.bezelStyle = .recessed
            button.setButtonType(.pushOnPushOff)
            button.state = query.isEmpty && id == page ? .on : .off
            button.alignment = .left
            button.font = Theme.font
            button.widthAnchor.constraint(equalToConstant: 168).isActive = true
            bind(button) { [weak self] _ in
                self?.search.stringValue = ""
                self?.page = id
                self?.rebuild()
            }
            nav.addArrangedSubview(button)
        }
        if !settings.loaded {
            note(tr("settings.failed"))
            return
        }
        if settings.readOnly { note(tr("settings.readOnly")) }
        let fileProblems = settings.problems.filter { p in p.key == nil || settings.definition(p.key!) == nil }
        if !fileProblems.isEmpty { problems(tr("settings.problems"), fileProblems, codes: "settings.problem.") }
        if query.isEmpty {
            if page == Self.keysPage {
                keysPage(query: "")
            } else {
                sectionPage(page, definitions: settings.definitions(in: page), heading: false)
            }
            return
        }
        for id in sections {
            let found = settings.definitions(in: id).filter { SettingsModel.matches($0, query: query, text: Self.text) }
            if !found.isEmpty { sectionPage(id, definitions: found, heading: true) }
        }
        keysPage(query: query)
    }

    private func note(_ text: String) {
        let label = NSTextField(wrappingLabelWithString: text)
        label.textColor = Theme.muted
        label.font = Theme.fontSmall
        label.preferredMaxLayoutWidth = 600
        stack.addArrangedSubview(label)
    }

    private func heading(_ text: String) {
        let label = NSTextField(labelWithString: text)
        label.font = NSFont.systemFont(ofSize: Theme.font.pointSize + 1, weight: .semibold)
        stack.addArrangedSubview(label)
    }

    /// The problems of a file: those of the settings file are named by
    /// settings.problem.<code>, the keybindings file's by keys.problem.<code>.
    private func problems(_ title: String, _ list: [SettingProblem], codes: String) {
        let lines = list.map { p -> String in
            var parts: [String] = []
            if let index = p.index, index >= 0 { parts.append(tr("keys.problemAt", String(index + 1))) }
            if let key = p.key { parts.append(p.machine.map { "\(key) (\($0))" } ?? key) }
            parts.append(Self.text(codes + p.code) ?? p.code)
            if let detail = p.detail { parts.append(detail) }
            return parts.joined(separator: " · ")
        }
        let label = NSTextField(wrappingLabelWithString: "⚠︎ " + ([title] + lines).joined(separator: "\n"))
        label.textColor = Theme.statusBlocked
        label.font = Theme.fontSmall
        label.preferredMaxLayoutWidth = 600
        stack.addArrangedSubview(label)
    }

    private func sectionPage(_ id: String, definitions: [SettingDefinition], heading show: Bool) {
        if show { heading(Self.text("settings.section." + id) ?? id) }
        for definition in definitions {
            row(definition)
        }
        let perMachine = definitions.filter { $0.scope != "app" && ["bool", "enum"].contains($0.type) }
        if !perMachine.isEmpty { machineTable(perMachine) }
        if !show, !model.settings.file.isEmpty { note(tr("settings.file", model.settings.file)) }
    }

    // MARK: - Rows

    private func row(_ definition: SettingDefinition) {
        let settings = model.settings
        let key = definition.key
        let state = settings.values[key] ?? SettingState(value: definition.defaultValue)
        let disabled = settings.readOnly || state.locked

        let title = NSTextField(labelWithString: label(key))
        title.font = Theme.fontStrong
        let marker = NSTextField(labelWithString: state.isModified ? "●" : "")
        marker.textColor = Theme.statusWorking
        marker.font = Theme.fontSmall
        marker.toolTip = state.isModified ? tr("settings.modified") : nil
        marker.widthAnchor.constraint(equalToConstant: 12).isActive = true
        let keyLabel = NSTextField(labelWithString: key)
        keyLabel.font = NSFont.monospacedSystemFont(ofSize: Theme.fontSmall.pointSize, weight: .regular)
        keyLabel.textColor = Theme.muted
        let titleRow = NSStackView(views: [marker, title, keyLabel])
        titleRow.spacing = 6

        let control = self.control(definition, state.value, disabled: disabled)
        let reset = NSButton(image: NSImage(systemSymbolName: "arrow.counterclockwise", accessibilityDescription: tr("settings.reset"))!,
                             target: nil, action: nil)
        reset.bezelStyle = .inline
        reset.isBordered = false
        reset.toolTip = tr("settings.reset")
        reset.isEnabled = !disabled && state.isModified
        bind(reset) { [weak self] _ in self?.reset(key) }
        let controls = NSStackView(views: [control, reset])
        controls.spacing = 6

        let column = NSStackView(views: [titleRow, controls])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 5
        if let description = Self.text("settings.\(key).desc") {
            let label = NSTextField(wrappingLabelWithString: description)
            label.font = Theme.fontSmall
            label.textColor = Theme.muted
            label.preferredMaxLayoutWidth = 600
            column.addArrangedSubview(label)
        }
        if state.locked {
            let label = NSTextField(labelWithString: tr("settings.lockedByFlag", "--" + (definition.flag ?? key)))
            label.font = Theme.fontSmall
            label.textColor = Theme.statusBlocked
            column.addArrangedSubview(label)
        }
        for problem in settings.problems where problem.key == key && problem.machine == nil {
            let label = NSTextField(wrappingLabelWithString: tr("settings.problemInFile",
                                                               (Self.text("settings.problem." + problem.code) ?? problem.code)
                                                                   + (problem.detail.map { " · " + $0 } ?? "")))
            label.font = Theme.fontSmall
            label.textColor = Theme.statusError
            label.preferredMaxLayoutWidth = 600
            column.addArrangedSubview(label)
        }
        stack.addArrangedSubview(column)
    }

    private func control(_ definition: SettingDefinition, _ value: JSONValue, disabled: Bool) -> NSView {
        let key = definition.key
        let view: NSView
        switch definition.type {
        case "bool":
            let toggle = NSSwitch()
            toggle.state = value.bool == true ? .on : .off
            bind(toggle) { [weak self] sender in self?.set(key, .bool((sender as? NSSwitch)?.state == .on)) }
            view = toggle
        case "enum":
            let menu = NSPopUpButton()
            for option in definition.options {
                menu.addItem(withTitle: optionLabel(key, option))
                menu.lastItem?.representedObject = option
            }
            menu.selectItem(at: definition.options.firstIndex(of: value.string ?? "") ?? 0)
            bind(menu) { [weak self] sender in
                if let option = (sender as? NSPopUpButton)?.selectedItem?.representedObject as? String { self?.set(key, .string(option)) }
            }
            view = menu
        case "number":
            let field = NSTextField(string: value.number.map { String(format: "%g", $0) } ?? "")
            field.alignment = .right
            field.widthAnchor.constraint(equalToConstant: 90).isActive = true
            bind(field) { [weak self] sender in
                guard let text = (sender as? NSTextField)?.stringValue.trimmingCharacters(in: .whitespaces), let number = Double(text) else {
                    self?.rebuild()
                    return
                }
                if number != value.number { self?.set(key, .number(number)) }
            }
            let range = [definition.min, definition.max].compactMap { $0 }.map { String(format: "%g", $0) }
            let hint = NSTextField(labelWithString: range.count == 2 ? range.joined(separator: " – ") : "")
            hint.textColor = Theme.muted
            hint.font = Theme.fontSmall
            let row = NSStackView(views: [field, hint])
            field.isEnabled = !disabled
            return row
        case "color":
            view = colorWell(key, value.string ?? "#000000", disabled: disabled) { [weak self] hex in self?.set(key, .string(hex)) }
        case "list" where definition.item == "color":
            // Two rows of eight: the colors, then their bright variants.
            let colors = value.array?.compactMap(\.string) ?? []
            let rows = stride(from: 0, to: colors.count, by: 8).map { start -> NSView in
                let wells = colors[start ..< min(start + 8, colors.count)].enumerated().map { offset, hex -> NSView in
                    let index = start + offset
                    return colorWell("\(key).\(index)", hex, disabled: disabled) { [weak self] picked in
                        var next = colors
                        next[index] = picked
                        self?.set(key, .array(next.map { .string($0) }))
                    }
                }
                let row = NSStackView(views: wells)
                row.spacing = 4
                return row
            }
            let grid = NSStackView(views: rows)
            grid.orientation = .vertical
            grid.alignment = .leading
            grid.spacing = 4
            return grid
        default:
            let text = value.array.map { $0.compactMap(\.string).joined(separator: ", ") } ?? value.string ?? ""
            let field = NSTextField(string: text)
            field.placeholderString = Self.text("settings.\(key).placeholder")
            field.widthAnchor.constraint(equalToConstant: 300).isActive = true
            bind(field) { [weak self] sender in
                let next = (sender as? NSTextField)?.stringValue.trimmingCharacters(in: .whitespaces) ?? ""
                guard next != text else { return }
                if definition.type == "list" {
                    let items = next.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                    self?.set(key, .array(items.map { .string($0) }))
                } else {
                    self?.set(key, .string(next))
                }
            }
            view = field
        }
        (view as? NSControl)?.isEnabled = !disabled
        return view
    }

    /// A color well; a pick is saved once it rests, as the panel reports
    /// every step of a drag.
    private func colorWell(_ id: String, _ hex: String, disabled: Bool, save: @escaping (String) -> Void) -> NSView {
        let well = NSColorWell()
        if #available(macOS 13.0, *) { well.colorWellStyle = .minimal }
        well.color = Self.color(hex) ?? .black
        well.isEnabled = !disabled
        well.toolTip = hex
        well.widthAnchor.constraint(equalToConstant: 34).isActive = true
        well.heightAnchor.constraint(equalToConstant: 22).isActive = true
        bind(well) { [weak self] sender in
            guard let self, let color = (sender as? NSColorWell)?.color else { return }
            let next = Self.hex(color)
            self.colorTimers[id]?.invalidate()
            self.colorTimers[id] = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { _ in
                if next != hex { save(next) }
            }
        }
        return well
    }

    static func color(_ hex: String) -> NSColor? {
        guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return Theme.hex(value)
    }

    static func hex(_ color: NSColor) -> String {
        let c = color.usingColorSpace(.sRGB) ?? color
        let r = Int((c.redComponent * 255).rounded()), g = Int((c.greenComponent * 255).rounded()), b = Int((c.blueComponent * 255).rounded())
        return String(format: "#%02x%02x%02x", r, g, b)
    }

    /// One row per machine for settings that machines can have their own
    /// value of: each follows the global value or has its own.
    private func machineTable(_ definitions: [SettingDefinition]) {
        let settings = model.settings
        heading(tr("settings.perMachine"))
        note(tr("settings.perMachineInfo"))
        // Settings only other machines than the core's host can differ in
        // leave the local machine out.
        let remoteOnly = definitions.allSatisfy { $0.scope == "remote-machine" }
        let machines = model.machines.filter { !remoteOnly || $0.kind != "local" }
        if machines.isEmpty { return note(tr("settings.noMachines")) }
        let grid = NSGridView()
        grid.rowSpacing = 6
        grid.columnSpacing = 12
        let header = [tr("settings.machine")] + definitions.map { label($0.key) }
        grid.addRow(with: header.map { text -> NSView in
            let field = NSTextField(labelWithString: text)
            field.font = Theme.fontSmall
            field.textColor = Theme.muted
            return field
        })
        for machine in machines {
            var cells: [NSView] = [NSTextField(labelWithString: machine.label)]
            for definition in definitions {
                let state = settings.values[definition.key] ?? SettingState(value: definition.defaultValue)
                let menu = NSPopUpButton()
                menu.addItem(withTitle: tr("settings.inherit", valueLabel(definition, state.value)))
                menu.lastItem?.representedObject = nil
                let options: [JSONValue] = definition.type == "bool" ? [.bool(true), .bool(false)] : definition.options.map { .string($0) }
                for option in options {
                    menu.addItem(withTitle: valueLabel(definition, option))
                    menu.lastItem?.representedObject = option.any
                }
                if let own = state.machines[machine.id], let index = options.firstIndex(of: own) { menu.selectItem(at: index + 1) }
                menu.isEnabled = !settings.readOnly && !state.locked && !(definition.scope == "remote-machine" && machine.kind == "local")
                let key = definition.key
                bind(menu) { [weak self] sender in
                    guard let item = (sender as? NSPopUpButton)?.selectedItem else { return }
                    if let value = item.representedObject {
                        self?.set(key, JSONValue(any: value), machine: machine.id)
                    } else {
                        self?.reset(key, machine: machine.id)
                    }
                }
                cells.append(menu)
            }
            grid.addRow(with: cells)
        }
        stack.addArrangedSubview(grid)
    }

    // MARK: - Changes

    private func set(_ key: String, _ value: JSONValue, machine: String? = nil) {
        var body: [String: Any] = ["key": key, "value": value.any]
        if let machine { body["machine"] = machine }
        model.api.request("PUT", "api/settings", body: body) { [weak self] status, reply in
            self?.answered(key, status: status, reply: reply)
        }
    }

    private func reset(_ key: String, machine: String? = nil) {
        var query = ["key": key]
        if let machine { query["machine"] = machine }
        model.api.request("DELETE", "api/settings", query: query) { [weak self] status, reply in
            self?.answered(key, status: status, reply: reply)
        }
    }

    /// The core's answer: its values, or why it refused (the page shows the
    /// core's value again).
    private func answered(_ key: String, status: Int, reply: JSONValue?) {
        if status == 200, let reply, model.settings.apply(reply) {
            model.onSettings?()
            return
        }
        rebuild()
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = tr("settings.rejected", label(key))
        if let code = reply?["error"]?.string { alert.informativeText = Self.text("settings.error." + code) ?? code }
        alert.beginSheetModal(for: window)
    }

    // MARK: - Keyboard shortcuts

    private func keysPage(query: String) {
        let keys = model.keybindings
        let words = query.lowercased().split(separator: " ").map(String.init)
        let commands = keys.commands.filter { command in
            let text = ([Self.text("command." + command.id) ?? "", command.id] + keys.keys(of: command.id).map(Keys.label)).joined(separator: " ").lowercased()
            return words.allSatisfy { text.contains($0) }
        }
        if !query.isEmpty, commands.isEmpty { return }
        if !query.isEmpty { heading(tr("settings.section.keyboard")) } else { note(tr("keys.note")) }
        if !keys.problems.isEmpty { problems(tr("keys.problems"), keys.problems, codes: "keys.problem.") }
        let readOnly = model.settings.readOnly
        for section in keys.sections {
            let inSection = commands.filter { $0.section == section }
            guard !inSection.isEmpty else { continue }
            let title = NSTextField(labelWithString: (Self.text("command.section." + section) ?? section).uppercased())
            title.font = NSFont.systemFont(ofSize: Theme.fontSmall.pointSize, weight: .semibold)
            title.textColor = Theme.muted
            stack.addArrangedSubview(title)
            for command in inSection {
                stack.addArrangedSubview(commandRow(command, readOnly: readOnly))
            }
        }
        if query.isEmpty, !keys.file.isEmpty { note(tr("settings.file", keys.file)) }
    }

    private func commandRow(_ command: KeyCommand, readOnly: Bool) -> NSView {
        let keys = model.keybindings
        let changed = keys.isChanged(command.id)
        let marker = NSTextField(labelWithString: changed ? "●" : "")
        marker.textColor = Theme.statusWorking
        marker.font = Theme.fontSmall
        marker.widthAnchor.constraint(equalToConstant: 12).isActive = true
        let title = NSTextField(labelWithString: Self.text("command." + command.id) ?? command.id)
        title.font = Theme.font
        if !supported.contains(command.id) {
            title.textColor = Theme.muted
            title.toolTip = tr("keys.unavailable")
        }
        title.widthAnchor.constraint(equalToConstant: 300).isActive = true
        var views: [NSView] = [marker, title]
        let current = keys.keys(of: command.id)
        for key in current {
            let others = keys.conflicts(of: command.id, key: key)
            let chip = NSTextField(labelWithString: (others.isEmpty ? "" : "⚠︎ ") + Keys.label(key))
            chip.font = NSFont.monospacedSystemFont(ofSize: Theme.font.pointSize, weight: .regular)
            chip.textColor = others.isEmpty ? Theme.foreground : Theme.statusBlocked
            if !others.isEmpty { chip.toolTip = tr("keys.conflict", others.map { Self.text("command." + $0) ?? $0 }.joined(separator: ", ")) }
            views.append(chip)
            if !readOnly {
                let remove = symbolButton("xmark", tr("keys.remove")) { [weak self] in
                    self?.saveRules(KeybindingsModel.rules(for: command.id, keys: current.filter { $0 != key }, user: keys.user, defaults: keys.defaults))
                }
                views.append(remove)
            }
        }
        if !readOnly {
            views.append(symbolButton("plus", tr("keys.add")) { [weak self] in self?.record(command.id, current: current) })
            if changed {
                views.append(symbolButton("arrow.counterclockwise", tr("keys.reset")) { [weak self] in
                    self?.saveRules(KeybindingsModel.reset(command.id, user: keys.user))
                })
            }
        }
        let row = NSStackView(views: views)
        row.spacing = 6
        return row
    }

    private func symbolButton(_ symbol: String, _ tip: String, _ action: @escaping () -> Void) -> NSButton {
        let button = NSButton(image: NSImage(systemSymbolName: symbol, accessibilityDescription: tip)!, target: nil, action: nil)
        button.bezelStyle = .inline
        button.isBordered = false
        button.toolTip = tip
        bind(button) { _ in action() }
        return button
    }

    /// Records a key for a command in a sheet: strokes as they are pressed,
    /// Return keeps them, Escape cancels.
    private func record(_ command: String, current: [String]) {
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = tr("keys.record", Self.text("command." + command) ?? command)
        alert.informativeText = tr("keys.press")
        let recorder = KeyRecorder(frame: NSRect(x: 0, y: 0, width: 320, height: 52))
        recorder.clashes = { [weak self] key in
            (self?.model.keybindings.clashes(key, for: command) ?? []).map { Self.text("command." + $0) ?? $0 }
        }
        alert.accessoryView = recorder
        alert.addButton(withTitle: tr("keys.save"))
        alert.addButton(withTitle: tr("workspace.cancel"))
        alert.window.initialFirstResponder = recorder
        recorder.onChange = { [weak alert] valid in alert?.buttons.first?.isEnabled = valid }
        recorder.onConfirm = { [weak alert] in
            guard let alert else { return }
            window.endSheet(alert.window, returnCode: .alertFirstButtonReturn)
        }
        alert.buttons.first?.isEnabled = false
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn, let key = recorder.sequence, !current.contains(key) else { return }
            let keys = self.model.keybindings
            self.saveRules(KeybindingsModel.rules(for: command, keys: current + [key], user: keys.user, defaults: keys.defaults))
        }
        DispatchQueue.main.async { alert.window.makeFirstResponder(recorder) }
    }

    #if DEBUG
        /// Development: opens the key recorder for a command with strokes
        /// already pressed.
        func debugRecord(_ command: String, _ strokes: [String]) {
            show(page: Self.keysPage)
            record(command, current: model.keybindings.keys(of: command))
            (window?.attachedSheet?.contentView.flatMap { Self.find(KeyRecorder.self, in: $0) })?.debugSet(strokes)
        }

        private static func find<T: NSView>(_: T.Type, in view: NSView) -> T? {
            if let hit = view as? T { return hit }
            for sub in view.subviews { if let hit = find(T.self, in: sub) { return hit } }
            return nil
        }
    #endif

    private func saveRules(_ rules: [JSONValue]) {
        model.api.request("PUT", "api/keybindings", body: rules.map(\.any)) { [weak self] status, reply in
            guard let self else { return }
            if status == 200, let reply, self.model.keybindings.apply(reply) {
                self.model.onKeybindings?()
                return
            }
            guard let window = self.window else { return }
            let alert = NSAlert()
            alert.messageText = tr("keys.rejected")
            if let code = reply?["error"]?.string {
                alert.informativeText = (Self.text("settings.error." + code) ?? code) + (reply?["detail"]?.string.map { "\n" + $0 } ?? "")
            }
            alert.beginSheetModal(for: window)
        }
    }

    // MARK: - Actions

    private func bind(_ control: NSControl, _ fn: @escaping (Any?) -> Void) {
        let handler = Handler(fn)
        handlers.append(handler)
        control.target = handler
        control.action = #selector(Handler.run(_:))
    }
}

/// A target for a control's action.
private final class Handler: NSObject {
    let fn: (Any?) -> Void
    init(_ fn: @escaping (Any?) -> Void) { self.fn = fn }
    @objc func run(_ sender: Any?) { fn(sender) }
}

/// Takes key strokes while it has the keyboard, Cmd keys included (before
/// the menu): Return keeps the sequence, Backspace removes the last stroke,
/// Escape cancels (the sheet's own button).
final class KeyRecorder: NSView {
    private(set) var strokes: [String] = []
    var onChange: ((Bool) -> Void)?
    var onConfirm: (() -> Void)?
    /// The commands a key would clash with (shown under it).
    var clashes: ((String) -> [String])?
    private let label = NSTextField(labelWithString: "")
    private let hint = NSTextField(labelWithString: "")
    private let box = FillView(.clear)

    /// The recorded sequence when it can be a binding.
    var sequence: String? { try? Keys.normalize(strokes.joined(separator: " ")) }

    override init(frame: NSRect) {
        super.init(frame: frame)
        box.wantsLayer = true
        box.layer?.cornerRadius = 4
        box.layer?.borderWidth = 1
        label.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        hint.font = Theme.fontSmall
        hint.textColor = Theme.statusBlocked
        hint.lineBreakMode = .byTruncatingTail
        for view in [box, label, hint] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        NSLayoutConstraint.activate([
            box.topAnchor.constraint(equalTo: topAnchor), box.leadingAnchor.constraint(equalTo: leadingAnchor),
            box.trailingAnchor.constraint(equalTo: trailingAnchor), box.heightAnchor.constraint(equalToConstant: 28),
            label.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 8), label.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            label.trailingAnchor.constraint(lessThanOrEqualTo: box.trailingAnchor, constant: -8),
            hint.topAnchor.constraint(equalTo: box.bottomAnchor, constant: 6), hint.leadingAnchor.constraint(equalTo: leadingAnchor),
            hint.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
        ])
        update()
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }

    private func updateBorder() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            box.layer?.borderColor = (sequence == nil && !strokes.isEmpty ? Theme.statusError : Theme.focusRing).cgColor
        }
    }

    private func update() {
        if strokes.isEmpty {
            label.stringValue = "…"
        } else if let sequence {
            label.stringValue = Keys.label(sequence)
        } else {
            let code = (try? Keys.parse(strokes.joined(separator: " "))) == nil ? Self.error(strokes) : ""
            label.stringValue = Keys.label(strokes.joined(separator: " ")) + "  " + code
        }
        let others = sequence.flatMap { clashes?($0) } ?? []
        hint.stringValue = others.isEmpty ? "" : tr("keys.conflict", others.joined(separator: ", "))
        updateBorder()
        onChange?(sequence != nil)
    }

    private static func error(_ strokes: [String]) -> String {
        do {
            _ = try Keys.parse(strokes.joined(separator: " "))
            return ""
        } catch let error as KeyParseError {
            return SettingsWindow.text("keys.error." + error.code) ?? error.code
        } catch {
            return ""
        }
    }

    #if DEBUG
        func debugSet(_ strokes: [String]) {
            self.strokes = strokes
            update()
        }
    #endif

    private func take(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags
        let plain = flags.intersection([.command, .control, .option, .shift]).isEmpty
        if plain, event.keyCode == 36 || event.keyCode == 76 {
            if sequence != nil { onConfirm?() }
            return true
        }
        if plain, event.keyCode == 53 { return false } // Escape: the sheet's cancel
        if plain, event.keyCode == 51, !strokes.isEmpty {
            strokes.removeLast()
            update()
            return true
        }
        guard let stroke = Keys.stroke(characters: event.charactersIgnoringModifiers ?? "", keyCode: event.keyCode,
                                       cmd: flags.contains(.command), ctrl: flags.contains(.control),
                                       alt: flags.contains(.option), shift: flags.contains(.shift)) else { return true }
        strokes = strokes.count >= Keys.maxStrokes ? [stroke] : strokes + [stroke]
        update()
        return true
    }

    override func keyDown(with event: NSEvent) {
        if !take(event) { super.keyDown(with: event) }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder === self, event.type == .keyDown else { return false }
        return take(event)
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}
