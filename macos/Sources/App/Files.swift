import AppKit
import TermKit

/// Uploads and downloads of the window, as the web UI's uploads and
/// downloads panels: each transfer's progress, speed and result, cancelling
/// it, and the history of finished ones (the last 50, in the application's
/// preferences: names and paths, no contents). Files of one paste or drop
/// go one after the other; a file that cannot go into the directory asked
/// for goes into the machine's upload directory.
final class Transfers {
    let list: TransferList
    private let client: TransferClient
    private let model: AppModel
    private var tasks: [String: URLSessionTask] = [:]
    private var speeds: [String: Speed] = [:]
    /// Shows a short message in the main window.
    var toast: ((String) -> Void)?
    private static let key = "transfers"

    init(model: AppModel) {
        self.model = model
        client = TransferClient(core: model.core)
        let stored = UserDefaults.standard.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([Transfer].self, from: $0) } ?? []
        list = TransferList(history: stored) { history in
            UserDefaults.standard.set(try? JSONEncoder().encode(history), forKey: Self.key)
        }
    }

    private func label(_ machine: String) -> String { model.machines.first { $0.id == machine }?.label ?? machine }

    private func track(_ id: String, _ event: TransferClient.Event, upload: Bool, done: ((String?) -> Void)? = nil) {
        switch event {
        case let .progress(sent, total):
            var speed = speeds[id] ?? Speed()
            let rate = speed.add(sent)
            speeds[id] = speed
            list.update(id) { t in
                if t.status == .queued { t.status = .running }
                t.speed = rate
                t.sent = sent
                if let total { t.size = total }
            }
        case .sent:
            list.update(id) { $0.status = .finishing }
        case let .done(result):
            tasks[id] = nil
            speeds[id] = nil
            list.end(id, .done, result: result)
            done?(result)
        case let .failed(reason):
            tasks[id] = nil
            speeds[id] = nil
            let name = list.find(id)?.name ?? ""
            list.end(id, reason == "cancelled" ? .cancelled : .failed, error: reason == "cancelled" ? nil : reason)
            if reason != "cancelled" { toast?(upload ? tr("transfers.uploadFailed", name, reason) : tr("transfers.downloadFailed", name, reason)) }
            done?(nil)
        }
    }

    // MARK: - Downloads

    /// Asks where to save paths of a machine and downloads them there.
    func download(_ paths: [String], on machine: String, isFile: Bool, window: NSWindow?) {
        guard !paths.isEmpty else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = RemoteEntry.downloadName(paths, single: isFile)
        panel.canCreateDirectories = true
        let start = { [weak self] (response: NSApplication.ModalResponse) in
            guard response == .OK, let url = panel.url else { return }
            self?.download(paths, on: machine, to: url)
        }
        if let window { panel.beginSheetModal(for: window, completionHandler: start) } else { start(panel.runModal()) }
    }

    func download(_ paths: [String], on machine: String, to destination: URL) {
        let transfer = Transfer(kind: .download, machine: machine, machineLabel: label(machine), name: destination.lastPathComponent, paths: paths)
        list.add(transfer)
        tasks[transfer.id] = client.download(machine: machine, paths: paths, to: destination) { [weak self] in
            self?.track(transfer.id, $0, upload: false)
        }
    }

    // MARK: - Uploads

    /// Uploads files (or one piece of data) to a machine one after the
    /// other, into `dir` when given, else its upload directory; `done` gets
    /// the paths of those that arrived, in order.
    func upload(_ files: [URL], data: (Data, String)? = nil, to machine: String, dir: String?, done: @escaping ([String]) -> Void) {
        var items: [(Transfer, URL?, Data?)] = files.map { file in
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize).map { Int64($0) }
            return (Transfer(kind: .upload, machine: machine, machineLabel: label(machine), name: file.lastPathComponent, paths: [dir ?? ""], size: size), file, nil)
        }
        if let (bytes, name) = data {
            items.append((Transfer(kind: .upload, machine: machine, machineLabel: label(machine), name: name, paths: [dir ?? ""],
                                   size: Int64(bytes.count)), nil, bytes))
        }
        items.forEach { list.add($0.0) }
        var paths: [String] = []
        func next(_ index: Int) {
            guard index < items.count else { return done(paths) }
            let (transfer, file, bytes) = items[index]
            guard list.find(transfer.id) != nil else { return next(index + 1) } // cancelled while waiting
            send(transfer, file: file, data: bytes, dir: dir ?? "") { path in
                if let path { paths.append(path) }
                next(index + 1)
            }
        }
        next(0)
    }

    private func send(_ transfer: Transfer, file: URL?, data: Data?, dir: String, done: @escaping (String?) -> Void) {
        list.update(transfer.id) { $0.status = .running }
        tasks[transfer.id] = client.upload(machine: transfer.machine, name: transfer.name, dir: dir, file: file, data: data) { [weak self] event in
            guard let self else { return }
            // A directory that refuses the file: the upload directory instead.
            if case let .failed(reason) = event, reason != "cancelled", !dir.isEmpty {
                self.toast?(tr("transfers.dirFailed", dir, reason))
                self.list.update(transfer.id) { $0.paths = [""] }
                return self.send(transfer, file: file, data: data, dir: "", done: done)
            }
            self.track(transfer.id, event, upload: true, done: done)
        }
    }

    func cancel(_ id: String) {
        guard let transfer = list.find(id), transfer.cancellable else { return }
        if let task = tasks[id] { task.cancel() } else { list.end(id, .cancelled) }
    }
}

/// The transfers button at the end of the tab bar and its popover: active
/// transfers with progress and a cancel button, then the history.
final class TransfersButton: NSButton, NSPopoverDelegate {
    private let transfers: Transfers
    private let popover = NSPopover()
    private let stack = NSStackView()

    init(transfers: Transfers) {
        self.transfers = transfers
        super.init(frame: .zero)
        image = NSImage(systemSymbolName: "arrow.up.arrow.down.circle", accessibilityDescription: tr("transfers.title"))
        imagePosition = .imageLeading
        isBordered = false
        contentTintColor = Theme.muted
        font = Theme.fontSmall
        toolTip = tr("transfers.title")
        target = self
        action = #selector(toggle)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let document = FlippedStack()
        document.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        scroll.documentView = document
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: document.topAnchor), stack.bottomAnchor.constraint(equalTo: document.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor), stack.trailingAnchor.constraint(equalTo: document.trailingAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])
        let controller = NSViewController()
        controller.view = scroll
        controller.preferredContentSize = NSSize(width: 420, height: 360)
        popover.contentViewController = controller
        popover.behavior = .transient
        popover.delegate = self
        transfers.list.onChange = { [weak self] in self?.update() }
        update()
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) { fatalError() }

    @objc private func toggle() {
        if popover.isShown { popover.close() } else { show() }
    }

    func show() {
        update()
        popover.show(relativeTo: bounds, of: self, preferredEdge: .maxY)
    }

    var isOpen: Bool { popover.isShown }

    private static let bytes: ByteCountFormatter = {
        let f = ByteCountFormatter()
        f.countStyle = .file
        return f
    }()

    private func update() {
        let list = transfers.list
        title = list.active.isEmpty ? "" : String(list.active.count)
        isHidden = list.active.isEmpty && list.history.isEmpty
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        func heading(_ text: String) {
            let label = NSTextField(labelWithString: text.uppercased())
            label.font = .systemFont(ofSize: Theme.fontSmall.pointSize, weight: .semibold)
            label.textColor = Theme.muted
            stack.addArrangedSubview(label)
        }
        if !list.active.isEmpty { heading(tr("transfers.active")) }
        for t in list.active { stack.addArrangedSubview(row(t)) }
        if !list.history.isEmpty {
            let clear = ClosureButton(title: tr("transfers.clear")) { [weak self] in self?.transfers.list.clearHistory() }
            clear.bezelStyle = .inline
            heading(tr("transfers.history"))
            for t in list.history { stack.addArrangedSubview(row(t)) }
            stack.addArrangedSubview(clear)
        }
        if list.active.isEmpty, list.history.isEmpty {
            let none = NSTextField(labelWithString: tr("transfers.none"))
            none.textColor = Theme.muted
            stack.addArrangedSubview(none)
        }
    }

    /// A transfer: its direction, name and machine, progress or result, and
    /// what can be done with it.
    private func row(_ t: Transfer) -> NSView {
        let icon = NSImageView(image: NSImage(systemSymbolName: t.kind == .upload ? "arrow.up" : "arrow.down", accessibilityDescription: nil)!)
        icon.contentTintColor = t.status == .failed ? Theme.statusError : Theme.muted
        let name = NSTextField(labelWithString: t.name)
        name.lineBreakMode = .byTruncatingMiddle
        name.font = Theme.font
        let size = t.size.map { Self.bytes.string(fromByteCount: $0) }
        var detail: [String] = [t.machineLabel]
        switch t.status {
        case .queued: detail.append(tr("transfers.queued"))
        case .running:
            detail.append([Self.bytes.string(fromByteCount: t.sent), size].compactMap { $0 }.joined(separator: " / "))
            if t.speed > 0 { detail.append(tr("transfers.speed", Self.bytes.string(fromByteCount: Int64(t.speed)))) }
        case .finishing: detail.append(tr("transfers.finishing"))
        case .done: detail.append(size ?? "")
        case .failed: detail.append(tr("transfers.failed", t.error ?? ""))
        case .cancelled: detail.append(tr("transfers.cancelled"))
        }
        let info = NSTextField(labelWithString: detail.filter { !$0.isEmpty }.joined(separator: " · "))
        info.font = Theme.fontSmall
        info.textColor = t.status == .failed ? Theme.statusError : Theme.muted
        info.lineBreakMode = .byTruncatingTail
        let text = NSStackView(views: [name, info])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = 2
        if t.status == .running, let total = t.size, total > 0 {
            let bar = NSProgressIndicator()
            bar.isIndeterminate = false
            bar.minValue = 0
            bar.maxValue = Double(total)
            bar.doubleValue = Double(t.sent)
            bar.controlSize = .small
            bar.widthAnchor.constraint(equalToConstant: 300).isActive = true
            text.addArrangedSubview(bar)
        }
        var views: [NSView] = [icon, text]
        if t.cancellable {
            views.append(ClosureButton(symbol: "xmark.circle", tip: tr("transfers.cancel")) { [weak self] in self?.transfers.cancel(t.id) })
        } else if t.status == .done, let result = t.result {
            if t.kind == .download {
                views.append(ClosureButton(symbol: "magnifyingglass.circle", tip: tr("transfers.reveal")) {
                    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: result)])
                })
            } else {
                views.append(ClosureButton(symbol: "doc.on.doc", tip: tr("transfers.copyPath")) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(result, forType: .string)
                })
            }
        }
        if t.isFinished {
            views.append(ClosureButton(symbol: "minus.circle", tip: tr("transfers.forget")) { [weak self] in self?.transfers.list.forget(t.id) })
        }
        let row = NSStackView(views: views)
        row.spacing = 8
        row.alignment = .centerY
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        text.setContentHuggingPriority(.defaultLow, for: .horizontal)
        row.widthAnchor.constraint(equalToConstant: 396).isActive = true
        return row
    }
}

private final class FlippedStack: NSView {
    override var isFlipped: Bool { true }
}

/// A machine's files, as the web UI's download dialog and preview list:
/// one directory at a time (Up, Home, a path typed in), several entries
/// chosen at once; a double click enters a directory or previews a file.
/// Its buttons preview (Quick Look), open in VS Code, download the chosen
/// entries (folders and several as one zip), upload files into the
/// directory, and copy the paths.
final class FilesWindow: NSObject, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate {
    private let model: AppModel
    private let transfers: Transfers
    private let window: NSWindow
    private let table = NSTableView()
    private let path = NSTextField()
    private let status = NSTextField(labelWithString: "")
    private var buttons: [NSButton] = []
    private var upload: NSButton?
    private(set) var machine = ""
    private(set) var directory = ""
    private var entries: [RemoteEntry] = []
    /// Shows a file of a machine with Quick Look.
    var onPreview: ((String, String) -> Void)?
    /// Opens a file of a machine in VS Code.
    var onCode: ((String, String) -> Void)?

    init(model: AppModel, transfers: Transfers) {
        self.model = model
        self.transfers = transfers
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 480), styleMask: [.titled, .closable, .resizable, .miniaturizable],
                          backing: .buffered, defer: false)
        super.init()
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.minSize = NSSize(width: 460, height: 300)
        window.setFrameAutosaveName(Brand.appSlug + ".files")
        for (id, title, width) in [("name", tr("files.name"), 340.0), ("size", tr("files.size"), 90.0), ("modified", tr("files.modified"), 150.0)] {
            let column = NSTableColumn(identifier: .init(id))
            column.title = title
            column.width = width
            table.addTableColumn(column)
        }
        table.allowsMultipleSelection = true
        table.usesAlternatingRowBackgroundColors = true
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(open)
        table.rowHeight = 22
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        path.delegate = self
        path.lineBreakMode = .byTruncatingHead
        path.font = .monospacedSystemFont(ofSize: Theme.font.pointSize, weight: .regular)
        status.font = Theme.fontSmall
        status.textColor = Theme.muted
        status.lineBreakMode = .byTruncatingTail
        func button(_ symbol: String, _ tip: String, _ run: @escaping () -> Void) -> NSButton {
            let b = ClosureButton(symbol: symbol, tip: tip, run: run)
            b.contentTintColor = Theme.foreground
            return b
        }
        let up = button("arrow.up", tr("files.up")) { [weak self] in self?.go(RemoteEntry.parent(self?.directory ?? "/")) }
        let home = button("house", tr("files.home")) { [weak self] in self?.go("~") }
        let refresh = button("arrow.clockwise", tr("files.refresh")) { [weak self] in self?.go(self?.directory ?? "~") }
        let preview = ClosureButton(title: tr("files.preview")) { [weak self] in self?.previewSelected() }
        let code = ClosureButton(title: tr("files.openCode")) { [weak self] in self?.codeSelected() }
        let download = ClosureButton(title: tr("files.download")) { [weak self] in self?.downloadSelected() }
        let upload = ClosureButton(title: tr("files.upload")) { [weak self] in self?.chooseUploads() }
        let copy = ClosureButton(title: tr("files.copyPath")) { [weak self] in self?.copyPaths() }
        self.upload = upload
        buttons = [preview, code, download, copy]
        for b in buttons + [upload] { b.bezelStyle = .rounded }
        let top = NSStackView(views: [up, home, path, refresh])
        top.spacing = 6
        let bottom = NSStackView(views: [status, NSView(), preview, code, download, upload, copy])
        bottom.spacing = 6
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let root = FillView(Theme.background)
        for view in [top, scroll, bottom] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(view)
        }
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: root.topAnchor, constant: 10), top.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 10),
            top.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10),
            scroll.topAnchor.constraint(equalTo: top.bottomAnchor, constant: 8), scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bottom.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 8),
            bottom.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 10),
            bottom.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10),
            bottom.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -10),
        ])
        window.contentView = root
        if window.frame.origin == .zero { window.center() }
    }

    /// Shows a directory of a machine.
    func show(machine: String, directory: String) {
        self.machine = machine
        window.makeKeyAndOrderFront(nil)
        go(directory.isEmpty ? "~" : directory)
    }

    var isVisible: Bool { window.isVisible }

    private func go(_ dir: String) {
        let label = model.machines.first { $0.id == machine }?.label ?? machine
        window.title = tr("files.title", label)
        status.stringValue = tr("files.loading")
        let encoded = machine.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? machine
        model.api.request("GET", "api/m/\(encoded)/list", query: ["path": dir]) { [weak self] code, reply in
            guard let self else { return }
            guard code == 200, let (dirEntry, entries) = RemoteEntry.listing(reply) else {
                self.status.stringValue = tr("files.listFailed", dir, reply?["error"]?.string ?? String(code))
                self.path.stringValue = self.directory
                return
            }
            self.directory = dirEntry.path.isEmpty ? dir : dirEntry.path
            self.entries = entries
            self.path.stringValue = self.directory
            self.table.reloadData()
            self.selectionChanged()
        }
    }

    private var selected: [RemoteEntry] { table.selectedRowIndexes.compactMap { entries.indices.contains($0) ? entries[$0] : nil } }
    private func full(_ entry: RemoteEntry) -> String { RemoteEntry.join(directory, entry.name) }

    private func selectionChanged() {
        let chosen = selected
        status.stringValue = chosen.isEmpty ? tr("files.count", String(entries.count)) : tr("files.selected", String(chosen.count))
        let files = !chosen.isEmpty && chosen.allSatisfy { !$0.isDirectory }
        buttons[0].isEnabled = chosen.count == 1 && files
        buttons[1].isEnabled = chosen.count == 1 && !model.readOnly
        buttons[2].isEnabled = !chosen.isEmpty
        buttons[3].isEnabled = !chosen.isEmpty
        upload?.isEnabled = !model.readOnly
    }

    @objc private func open() {
        let row = table.clickedRow
        guard entries.indices.contains(row) else { return }
        let entry = entries[row]
        if entry.isDirectory { go(full(entry)) } else { onPreview?(machine, full(entry)) }
    }

    private func previewSelected() {
        if let entry = selected.first, !entry.isDirectory { onPreview?(machine, full(entry)) }
    }

    private func codeSelected() {
        if let entry = selected.first { onCode?(machine, full(entry)) }
    }

    func downloadSelected() {
        let chosen = selected
        transfers.download(chosen.map(full), on: machine, isFile: chosen.count == 1 && !chosen[0].isDirectory, window: window)
    }

    private func chooseUploads() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK else { return }
            self.uploadFiles(panel.urls)
        }
    }

    /// Uploads files into the directory shown, then lists it again.
    func uploadFiles(_ urls: [URL]) {
        let dir = directory, machine = self.machine
        transfers.upload(urls, to: machine, dir: dir) { [weak self] _ in
            if self?.machine == machine, self?.directory == dir { self?.go(dir) }
        }
    }

    private func copyPaths() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(selected.map { shellQuote(full($0)) }.joined(separator: " "), forType: .string)
    }

    #if DEBUG
        /// Development: downloads the chosen entries to a file here.
        func debugDownload(to url: URL) {
            transfers.download(selected.map(full), on: machine, to: url)
        }

        /// Development: chooses entries by name.
        func debugSelect(_ names: [String]) {
            table.selectRowIndexes(IndexSet(entries.indices.filter { names.contains(entries[$0].name) }), byExtendingSelection: false)
        }
    #endif

    func controlTextDidEndEditing(_ notification: Notification) {
        guard notification.object as? NSTextField === path else { return }
        let typed = path.stringValue.trimmingCharacters(in: .whitespaces)
        if !typed.isEmpty, typed != directory { go(typed) }
    }

    func numberOfRows(in _: NSTableView) -> Int { entries.count }

    private static let date: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    func tableView(_: NSTableView, viewFor column: NSTableColumn?, row: Int) -> NSView? {
        let entry = entries[row]
        let text: String
        switch column?.identifier.rawValue {
        case "size": text = entry.isDirectory ? "" : ByteCountFormatter.string(fromByteCount: entry.size, countStyle: .file)
        case "modified": text = entry.modified > 0 ? Self.date.string(from: Date(timeIntervalSince1970: Double(entry.modified) / 1000)) : ""
        default:
            let icon = NSImageView(image: NSImage(systemSymbolName: entry.isDirectory ? "folder" : "doc", accessibilityDescription: nil)!)
            icon.contentTintColor = Theme.muted
            let label = NSTextField(labelWithString: entry.name)
            label.lineBreakMode = .byTruncatingMiddle
            label.font = Theme.font
            return centered(NSStackView(views: [icon, label]))
        }
        let label = NSTextField(labelWithString: text)
        label.textColor = Theme.muted
        label.font = Theme.fontSmall
        return centered(label)
    }

    /// A cell's content, centred in the row's height.
    private func centered(_ view: NSView) -> NSView {
        let cell = NSView()
        view.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
            view.trailingAnchor.constraint(lessThanOrEqualTo: cell.trailingAnchor, constant: -2),
            view.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    func tableViewSelectionDidChange(_: Notification) { selectionChanged() }
}
