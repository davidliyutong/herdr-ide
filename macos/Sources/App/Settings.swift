import AppKit
import TermKit

/// The core's settings, in a window built from their definitions
/// (`GET /api/settings`): a menu for a choice, a field for text. A setting
/// is named by `settings.<key>`, described by `settings.<key>.desc`, and its
/// options by `settings.<key>.<option>`; one without a translation shows its
/// key.
final class SettingsWindow: NSObject, NSWindowDelegate, NSTextFieldDelegate {
    private let core: URL
    private var window: NSWindow?
    private var definitions: [[String: Any]] = []
    private var readOnly = false
    private let stack = NSStackView()

    init(core: URL) {
        self.core = core
    }

    func show() {
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 520),
                                  styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            window.title = tr("settings.title")
            window.isReleasedWhenClosed = false
            window.delegate = self
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 14
            stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)
            let scroll = NSScrollView()
            scroll.hasVerticalScroller = true
            scroll.drawsBackground = false
            let document = FlippedView()
            document.translatesAutoresizingMaskIntoConstraints = false
            stack.translatesAutoresizingMaskIntoConstraints = false
            document.addSubview(stack)
            scroll.documentView = document
            NSLayoutConstraint.activate([
                stack.topAnchor.constraint(equalTo: document.topAnchor), stack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
                stack.leadingAnchor.constraint(equalTo: document.leadingAnchor), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
                document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            ])
            scroll.wantsLayer = true
            window.contentView = scroll
            window.center()
            self.window = window
        }
        window?.makeKeyAndOrderFront(nil)
        load()
    }

    private func load() {
        URLSession.shared.dataTask(with: core.appendingPathComponent("api/settings")) { [weak self] data, _, _ in
            let reply = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            DispatchQueue.main.async {
                guard let self else { return }
                self.definitions = reply?["settings"] as? [[String: Any]] ?? []
                self.readOnly = reply?["read_only"] as? Bool ?? false
                self.rebuild(failed: reply == nil)
            }
        }.resume()
    }

    /// A translation, or `fallback` when the strings have none.
    private func text(_ key: String, fallback: String) -> String {
        let value = tr(key)
        return value == key ? fallback : value
    }

    private func rebuild(failed: Bool) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if failed || definitions.isEmpty {
            let label = NSTextField(wrappingLabelWithString: tr(failed ? "settings.failed" : "settings.none"))
            label.textColor = Theme.muted
            stack.addArrangedSubview(label)
            return
        }
        for (index, definition) in definitions.enumerated() {
            guard let key = definition["key"] as? String else { continue }
            let value = definition["value"] as? String ?? ""
            let title = NSTextField(labelWithString: text("settings." + key, fallback: key))
            title.font = Theme.fontStrong
            let control: NSControl
            if definition["kind"] as? String == "enum", let options = definition["options"] as? [String] {
                let menu = NSPopUpButton()
                for option in options {
                    menu.addItem(withTitle: text("settings.\(key).\(option)", fallback: option))
                    menu.lastItem?.representedObject = option
                }
                menu.selectItem(at: options.firstIndex(of: value) ?? 0)
                menu.target = self
                menu.action = #selector(chose(_:))
                control = menu
            } else {
                let field = NSTextField(string: value)
                field.placeholderString = definition["default"] as? String
                field.delegate = self
                field.widthAnchor.constraint(equalToConstant: 280).isActive = true
                control = field
            }
            control.tag = index
            control.isEnabled = !readOnly
            control.font = Theme.font
            let row = NSStackView(views: [title, control])
            row.orientation = .vertical
            row.alignment = .leading
            row.spacing = 5
            let description = text("settings.\(key).desc", fallback: "")
            if !description.isEmpty {
                let label = NSTextField(wrappingLabelWithString: description)
                label.font = Theme.fontSmall
                label.textColor = Theme.muted
                label.preferredMaxLayoutWidth = 500
                row.addArrangedSubview(label)
            }
            stack.addArrangedSubview(row)
        }
    }

    @objc private func chose(_ sender: NSPopUpButton) {
        guard definitions.indices.contains(sender.tag), let key = definitions[sender.tag]["key"] as? String,
              let value = sender.selectedItem?.representedObject as? String else { return }
        set(key, value)
    }

    func controlTextDidEndEditing(_ notification: Notification) {
        guard let field = notification.object as? NSTextField, definitions.indices.contains(field.tag),
              let key = definitions[field.tag]["key"] as? String, field.stringValue != definitions[field.tag]["value"] as? String else { return }
        set(key, field.stringValue)
    }

    private func set(_ key: String, _ value: String) {
        var request = URLRequest(url: core.appendingPathComponent("api/settings"))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["key": key, "value": value])
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                guard let self else { return }
                if !ok, let window = self.window {
                    let alert = NSAlert()
                    alert.messageText = tr("settings.rejected", self.text("settings." + key, fallback: key))
                    alert.beginSheetModal(for: window)
                }
                self.load() // the core's value, whatever became of the change
            }
        }.resume()
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}
