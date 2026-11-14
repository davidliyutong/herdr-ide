import XCTest
@testable import TermKit

final class ProtocolTests: XCTestCase {
    func testFrames() {
        let frame = Frame(stream: 0x0102_0304, kind: .automatic, payload: Data("ab".utf8))
        XCTAssertEqual(Array(frame.encoded()), [4, 3, 2, 1, 6, 97, 98])
        XCTAssertEqual(Frame(frame.encoded()), frame)
        XCTAssertNil(Frame(Data([1, 2, 3, 4])))
        // A frame cut from a larger buffer keeps its own indices.
        let slice = (Data([9, 9]) + Frame(stream: 7, kind: .resize, payload: Data([100, 0, 30, 1])).encoded()).dropFirst(2)
        let resize = Frame(slice)
        XCTAssertEqual(resize?.stream, 7)
        XCTAssertEqual(resize?.grid?.cols, 100)
        XCTAssertEqual(resize?.grid?.rows, 286)
        XCTAssertNil(Frame(stream: 7, kind: .data, payload: Data([1, 0, 2, 0])).grid)
    }

    func testRecordNames() {
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1", "name": "build", "title": "x"]).displayName, "build")
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1", "title": "vim a.txt"]).displayName, "vim a.txt")
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1", "foreground": ["name": "zsh"]]).displayName, "zsh")
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1", "argv": ["/bin/bash", "-l"]]).displayName, "bash")
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1"]).displayName, "t1")
        XCTAssertEqual(TerminalRecord(raw: ["address": "t1", "status": ["state": "working"]]).status, "working")
    }
}

final class EventTests: XCTestCase {
    func testDecode() {
        XCTAssertEqual(EventConnection.decode(#"{"t":"machines","list":[{"id":"local","label":"Mac","status":"ready","snapshot":{}},{"id":"b","label":"","status":"connecting"},{"label":"no id"}]}"#),
                       .machines([Machine(id: "local", label: "Mac", status: "ready"), Machine(id: "b", label: "b", status: "connecting")]))
        XCTAssertEqual(EventConnection.decode(#"{"t":"machine","state":{"id":"b","label":"Box","status":"degraded","error":"x"}}"#),
                       .machine(Machine(id: "b", label: "Box", status: "degraded")))
        XCTAssertEqual(EventConnection.decode(#"{"t":"gui","state":{"m":"b","phase":"ready","windows":[{"id":3,"title":"plot","w":640,"h":480,"pid":9},{"id":4,"title":"Save","w":300,"h":200,"transient":3},{"title":"no id"}]}}"#),
                       .gui(machine: "b", windows: [ProgramWindow(machine: "b", id: 3, title: "plot", width: 640, height: 480),
                                                    ProgramWindow(machine: "b", id: 4, title: "Save", width: 300, height: 200, transient: 3)]))
        XCTAssertEqual(EventConnection.decode(#"{"t":"gui","state":{"m":"b","phase":"off","windows":null}}"#), .gui(machine: "b", windows: []))
        // Messages the application does not use.
        for text in [#"{"t":"agent","m":"b","data":{}}"#, #"{"t":"session","state":"busy"}"#, #"{"t":"machine"}"#, "nonsense", "[]"] {
            XCTAssertNil(EventConnection.decode(text), text)
        }
    }
}

final class TerminalPathTests: XCTestCase {
    func testResolve() {
        XCTAssertEqual(TerminalPath.resolve("/etc/hosts", cwd: "/home/u"), "/etc/hosts")
        XCTAssertEqual(TerminalPath.resolve("src/main.go:12:5", cwd: "/home/u/p"), "/home/u/p/src/main.go")
        XCTAssertEqual(TerminalPath.resolve("./a.png:3:", cwd: "/w"), "/w/./a.png")
        XCTAssertEqual(TerminalPath.resolve(" ~/notes.md ", cwd: ""), "~/notes.md")
        XCTAssertEqual(TerminalPath.resolve("file:///tmp/a%20b.txt", cwd: "/"), "/tmp/a b.txt")
        XCTAssertNil(TerminalPath.resolve("file://other-host/tmp/a", cwd: "/"))
        XCTAssertNil(TerminalPath.resolve("a.txt", cwd: "")) // no directory to start from
        XCTAssertNil(TerminalPath.resolve("ssh://host/x", cwd: "/"))
        XCTAssertNil(TerminalPath.resolve("", cwd: "/"))
        XCTAssertEqual(TerminalPath.fileName("/a/b/report.pdf"), "report.pdf")
        XCTAssertEqual(TerminalPath.fileName("/"), "file")
        XCTAssertEqual(TerminalPath.fileName("x/.."), "file")
        XCTAssertEqual(TerminalPath.fileName("~"), "file")
    }
}

final class TerminalStoreTests: XCTestCase {
    func testSnapshotsAndEvents() {
        let store = TerminalStore()
        XCTAssertFalse(store.apply(["t": "pong"]))
        store.apply(["t": "backend", "m": "x", "state": "ready", "code": "", "version": "0.1.21"])
        XCTAssertEqual(store.backends["x"], BackendState(phase: .ready, version: "0.1.21"))
        store.apply(["t": "snapshot", "m": "x", "terminals": [
            ["address": "t2", "state": "live", "created_ms": 20, "pid": 5, "foreground": ["name": "zsh"]],
            ["address": "t1", "state": "live", "created_ms": 10],
        ]])
        XCTAssertEqual(store.terminals(of: "x").map(\.address), ["t1", "t2"])

        func event(_ type: String, _ terminal: String, _ data: [String: Any]) {
            store.apply(["t": "event", "m": "x", "type": type, "terminal": terminal, "data": data])
        }
        event("status", "t1", ["status": ["state": "working"], "records": [:] as [String: Any], "reported": true])
        XCTAssertEqual(store.terminal("t1", on: "x")?.status, "working")
        event("status", "t1", ["status": NSNull(), "records": [:] as [String: Any], "reported": true])
        XCTAssertNil(store.terminal("t1", on: "x")?.status)
        event("title", "t1", ["title": "make"])
        event("size", "t1", ["cols": 120, "rows": 40])
        XCTAssertEqual(store.terminal("t1", on: "x")?.title, "make")
        XCTAssertEqual(store.terminal("t1", on: "x")?.raw["cols"] as? Int, 120)
        event("foreground", "t1", ["pid": 9, "name": "vim", "argv": ["vim"], "cwd": "/"])
        XCTAssertEqual(store.terminal("t1", on: "x")?.foreground, "vim")
        event("finished", "t2", ["reason": "exited", "exit_code": 0])
        XCTAssertEqual(store.terminal("t2", on: "x")?.isLive, false)
        XCTAssertNil(store.terminal("t2", on: "x")?.foreground)
        event("created", "t3", ["address": "t3", "state": "live", "created_ms": 30])
        event("labels", "t3", ["labels": ["app": "x"]])
        XCTAssertEqual(store.terminal("t3", on: "x")?.labels, ["app": "x"])
        event("removed", "t2", [:])
        XCTAssertEqual(store.terminals(of: "x").map(\.address), ["t1", "t3"])
        // Events for terminals the store does not have change nothing.
        XCTAssertFalse(store.apply(["t": "event", "m": "x", "type": "title", "terminal": "t9", "data": ["title": "x"]]))

        // A backend that is not ready has no terminals.
        store.apply(["t": "backend", "m": "x", "state": "error", "code": "disconnected", "version": ""])
        XCTAssertEqual(store.backends["x"]?.code, "disconnected")
        XCTAssertTrue(store.terminals(of: "x").isEmpty)
    }
}

/// The vectors of design/testdata/layout, which web/src/__tests__/term.test.ts
/// runs against the TypeScript layout too.
final class LayoutTests: XCTestCase {
    private func apply(_ op: JSONValue, to layout: inout Layout) {
        func s(_ key: String) -> String { op[key]?.string ?? "" }
        func n(_ key: String) -> Int { Int(op[key]?.number ?? -1) }
        func axis() -> Layout.Axis { Layout.Axis(rawValue: s("axis")) ?? .horizontal }
        switch s("op") {
        case "createWorkspace": layout.createWorkspace(id: s("id"), name: s("name"), cwd: s("cwd"))
        case "renameWorkspace": layout.renameWorkspace(s("workspace"), to: s("name"))
        case "closeWorkspace": layout.closeWorkspace(s("workspace"))
        case "moveWorkspace": layout.moveWorkspace(s("workspace"), to: n("to"))
        case "selectWorkspace": layout.selectWorkspace(s("workspace"))
        case "openTerminal": layout.open(s("terminal"), in: op["workspace"]?.string)
        case "renameTab": layout.renameTab(n("tab"), in: s("workspace"), to: s("name"))
        case "closeTab": layout.closeTab(n("tab"), in: s("workspace"))
        case "moveTab": layout.moveTab(n("from"), to: n("to"), in: s("workspace"))
        case "selectTab": layout.selectTab(n("tab"), in: s("workspace"))
        case "splitFocused": layout.split(axis(), new: s("terminal"))
        case "closeTerminal": layout.close(s("terminal"))
        case "prune": layout.prune(keeping: Set((op["live"]?.array ?? []).compactMap(\.string)))
        case "setRatio": layout.setRatio(op["ratio"]?.number ?? .nan, at: (op["path"]?.array ?? []).compactMap(\.bool))
        case "focus": layout.focus(s("terminal"))
        case "swap": layout.swap(s("a"), s("b"))
        case "moveTerminal": layout.move(s("terminal"), beside: s("target"), axis: axis(), before: op["before"]?.bool ?? false)
        case "moveToNewTab": layout.moveToNewTab(s("terminal"), in: s("workspace"))
        default: XCTFail("unknown op \(s("op"))")
        }
    }

    func testVectors() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../design/testdata/layout").standardizedFileURL
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") }.sorted()
        XCTAssertGreaterThan(files.count, 5)
        for file in files {
            let data = try Data(contentsOf: directory.appendingPathComponent(file))
            let vector = JSONValue(any: try JSONSerialization.jsonObject(with: data))
            let input = Layout(document: vector["input"])
            var layout = input
            for op in vector["ops"]?.array ?? [] { apply(op, to: &layout) }
            XCTAssertEqual(layout.document, vector["expected"], file)
            XCTAssertEqual(layout == input, !(vector["changed"]?.bool ?? true), "\(file): changed")
            XCTAssertEqual(Layout(document: vector["expected"]), layout, "\(file): reads back")
            // Through the serializer the core's documents pass.
            let written = try JSONSerialization.data(withJSONObject: layout.document.any)
            XCTAssertEqual(Layout(document: JSONValue(any: try JSONSerialization.jsonObject(with: written))), layout, "\(file): round trip")
        }
    }

    func testHelpers() {
        let id = Layout.newWorkspaceID()
        XCTAssertNotNil(id.range(of: "^[a-z0-9]{8}$", options: .regularExpression))
        XCTAssertNotEqual(Layout.newWorkspaceID(), id)
        var layout = Layout()
        layout.createWorkspace(id: id, name: "x", cwd: "/w")
        layout.open("t1")
        XCTAssertTrue(layout.split(.vertical, new: "t2"))
        XCTAssertFalse(layout.split(.vertical, new: "t2"))
        XCTAssertEqual(layout.terminals, ["t1", "t2"])
        XCTAssertEqual(layout.focusedTerminal, "t2")
        XCTAssertEqual(layout.selectedWorkspace?.cwd, "/w")
        XCTAssertEqual(layout.locate("t2")?.tab, 0)
        XCTAssertNil(layout.locate("t3"))
        XCTAssertEqual(JSONValue(any: ["a": [true, 1.5, "x", NSNull()]]).any as? NSDictionary, ["a": [true, 1.5, "x", NSNull()]])
        XCTAssertEqual(JSONValue(any: true), .bool(true))
        XCTAssertEqual(JSONValue(any: 1), .number(1))
    }
}

final class CoreProcessTests: XCTestCase {
    func testArgumentsAndReadyLine() {
        XCTAssertEqual(CoreProcess.arguments(dev: false), ["serve", "--parent-stdio", "--listen", "127.0.0.1:0", "--instance", "desktop"])
        XCTAssertTrue(CoreProcess.arguments(dev: true).contains(Brand.appSlug + "-dev"))
        XCTAssertEqual(CoreProcess.readyURL(#"{"event":"ready","url":"http://127.0.0.1:7781"}"#)?.port, 7781)
        XCTAssertNil(CoreProcess.readyURL(#"{"event":"ready","url":"http://example.com:7781"}"#))
        XCTAssertNil(CoreProcess.readyURL(#"{"event":"log","url":"http://127.0.0.1:1"}"#))
        XCTAssertNil(CoreProcess.readyURL("listening"))
        let env = CoreProcess.environment(["PATH": "/x"], home: "/Users/u")
        XCTAssertEqual(env["PATH"], "/x:/Users/u/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        XCTAssertEqual(Brand.envPrefix, Brand.appSlug.uppercased().replacingOccurrences(of: "-", with: "_") + "_")
    }

    func testMissingBinary() {
        let done = expectation(description: "answered")
        CoreProcess().start(binary: URL(fileURLWithPath: "/nonexistent/core"), dev: true, ready: { result in
            XCTAssertEqual(try? result.get(), nil)
            done.fulfill()
        }, exited: {})
        wait(for: [done], timeout: 5)
    }
}

final class LocalizationTests: XCTestCase {
    /// Every locale has the keys of the English strings, with the same
    /// placeholders.
    func testLocalesAgree() throws {
        let resources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Sources/App/Resources").standardizedFileURL
        func strings(_ locale: String) throws -> [String: String] {
            let url = resources.appendingPathComponent(locale + ".lproj/Localizable.strings")
            return try XCTUnwrap(NSDictionary(contentsOf: url) as? [String: String], url.path)
        }
        let english = try strings("en")
        XCTAssertFalse(english.isEmpty)
        let locales = try FileManager.default.contentsOfDirectory(atPath: resources.path)
            .filter { $0.hasSuffix(".lproj") }.map { String($0.dropLast(6)) }
        XCTAssertTrue(locales.contains("zh-Hans"))
        for locale in locales where locale != "en" {
            let other = try strings(locale)
            XCTAssertEqual(Set(other.keys), Set(english.keys), locale)
            for (key, text) in english {
                XCTAssertEqual(other[key]?.components(separatedBy: "%@").count, text.components(separatedBy: "%@").count, "\(locale) \(key)")
            }
        }
    }

    /// Every key the sources ask for exists, and none is unused.
    func testKeysAreUsed() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Sources/App").standardizedFileURL
        let english = try XCTUnwrap(NSDictionary(contentsOf: sources.appendingPathComponent("Resources/en.lproj/Localizable.strings")) as? [String: String])
        var code = ""
        for file in try FileManager.default.contentsOfDirectory(atPath: sources.path) where file.hasSuffix(".swift") {
            code += try String(contentsOf: sources.appendingPathComponent(file), encoding: .utf8)
        }
        let literal = try NSRegularExpression(pattern: #"tr\("([a-z_.A-Z]+)"|add\(menu, "([a-z_.A-Z]+)"|command\(menu, "([a-z_.A-Z]+)""#)
        var used: Set<String> = []
        for match in literal.matches(in: code, range: NSRange(code.startIndex..., in: code)) {
            for group in 1...3 {
                if let range = Range(match.range(at: group), in: code) { used.insert(String(code[range])) }
            }
        }
        // Keys built from a state or code: tr("backend." + code); the
        // settings' and commands' come from the core's registry (below).
        let prefixes = ["backend.", "machine.", "status.", "quicklook.", "settings.", "command.", "keys.error.", "keys.problem."]
        for key in used where !prefixes.contains(key) {
            XCTAssertNotNil(english[key], "missing string \(key)")
        }
        for key in english.keys where !used.contains(key) && !prefixes.contains(where: key.hasPrefix) {
            XCTFail("unused string \(key)")
        }
    }

    /// Every label the core's registry asks of this application
    /// (design/generated/registry.json, written by scripts/registry): its
    /// settings, their options and sections, and every command.
    func testRegistryKeys() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../..").standardizedFileURL
        let data = try Data(contentsOf: root.appendingPathComponent("design/generated/registry.json"))
        let registry = JSONValue(any: try JSONSerialization.jsonObject(with: data))
        let keys = registry["i18n"]?["macos"]?.array?.compactMap(\.string) ?? []
        XCTAssertGreaterThan(keys.count, 80)
        let english = try XCTUnwrap(NSDictionary(contentsOf: root.appendingPathComponent("macos/Sources/App/Resources/en.lproj/Localizable.strings")) as? [String: String])
        for key in keys {
            XCTAssertNotNil(english[key], "missing string \(key)")
        }
    }
}

/// The vectors of design/testdata/keys, which internal/keybindings and
/// web/src/__tests__/keys.test.ts run too.
final class KeysTests: XCTestCase {
    private func vectors(_ name: String) throws -> JSONValue {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../design/testdata/keys/\(name).json").standardizedFileURL
        return JSONValue(any: try JSONSerialization.jsonObject(with: try Data(contentsOf: url)))
    }

    func testParse() throws {
        let cases = try vectors("parse")["cases"]?.array ?? []
        XCTAssertGreaterThan(cases.count, 30)
        for c in cases {
            let input = c["input"]?.string ?? ""
            if let code = c["error"]?.string {
                XCTAssertThrowsError(try Keys.normalize(input), input) { error in
                    XCTAssertEqual((error as? KeyParseError)?.code, code, input)
                }
            } else {
                let key = c["key"]?.string ?? ""
                XCTAssertEqual(try Keys.normalize(input), key, input)
                XCTAssertEqual(try Keys.normalize(key), key, key)
            }
        }
    }

    func testEvents() throws {
        for c in try vectors("events")["cases"]?.array ?? [] {
            let mods = c["mods"]?.array?.compactMap(\.string) ?? []
            let stroke = Keys.stroke(characters: c["chars"]?.string ?? "", keyCode: UInt16(c["keyCode"]?.number ?? 0),
                                     cmd: mods.contains("cmd"), ctrl: mods.contains("ctrl"), alt: mods.contains("alt"), shift: mods.contains("shift"))
            XCTAssertEqual(stroke, c["stroke"]?.string, c["description"]?.string ?? "")
        }
    }

    func testSequences() throws {
        let file = try vectors("sequences")
        let bindings = (file["bindings"]?.array ?? []).map {
            KeyBinding(key: $0["key"]?.string ?? "", command: $0["command"]?.string ?? "", when: $0["when"]?.string ?? "")
        }
        for c in file["cases"]?.array ?? [] {
            var matcher = KeyMatcher()
            let context = c["context"]?.string ?? "terminal"
            let got = (c["strokes"]?.array ?? []).compactMap(\.string).map { stroke -> String in
                switch matcher.feed(stroke, bindings: bindings, context: context) {
                case .none: return "none"
                case .pending: return "pending"
                case .swallow: return "swallow"
                case .literal: return "literal"
                case let .run(command): return "run:" + command
                }
            }
            XCTAssertEqual(got, (c["results"]?.array ?? []).compactMap(\.string), c["description"]?.string ?? "")
        }
    }

    func testLabelsAndMenus() {
        XCTAssertEqual(Keys.label("ctrl+b shift+slash"), "⌃B ?")
        XCTAssertEqual(Keys.label("cmd+shift+bracketright"), "⌘}")
        XCTAssertEqual(Keys.label("cmd+shift+d"), "⇧⌘D")
        XCTAssertEqual(Keys.label("ctrl+b comma"), "⌃B ,")
        XCTAssertEqual(Keys.menuEquivalent("cmd+shift+d")?.key, "D")
        XCTAssertEqual(Keys.menuEquivalent("cmd+shift+d")?.shift, false)
        XCTAssertEqual(Keys.menuEquivalent("cmd+shift+bracketright")?.key, "}")
        XCTAssertEqual(Keys.menuEquivalent("cmd+comma")?.key, ",")
        XCTAssertEqual(Keys.menuEquivalent("ctrl+alt+left")?.ctrl, true)
        XCTAssertNil(Keys.menuEquivalent("ctrl+b c"))
        XCTAssertEqual(Keys.ghosttyTriggers("cmd+shift+d"), ["super+shift+d"])
        XCTAssertEqual(Keys.ghosttyTriggers("cmd+comma"), ["super+comma", "super+,"])
        XCTAssertEqual(Keys.ghosttyTriggers("cmd+shift+bracketright"), ["super+shift+right_bracket", "super+shift+]"])
        XCTAssertEqual(Keys.ghosttyTriggers("ctrl+b c"), [])
    }
}

final class SettingsModelTests: XCTestCase {
    func testLoadAndPush() throws {
        let reply = JSONValue(any: [
            "sections": [["id": "terminal", "order": 30], ["id": "appearance", "order": 10]],
            "definitions": [
                ["key": "terminal.fontSize", "type": "number", "default": 13, "min": 6, "max": 40, "scope": "app", "section": "terminal", "order": 20],
                ["key": "terminal.mathHover", "type": "bool", "default": true, "scope": "app", "section": "terminal", "order": 30, "platforms": ["web"]],
                ["key": "gui.enabled", "type": "bool", "default": true, "scope": "remote-machine", "section": "gui", "order": 10, "flag": "gui"],
            ],
            "values": ["terminal.fontSize": ["value": 15, "source": "global"],
                       "gui.enabled": ["value": true, "source": "default", "machines": ["m1": false]]],
            "problems": [["key": "x", "code": "unknown"]],
            "read_only": false,
            "file": "/tmp/settings-dev.json",
        ] as [String: Any])
        let model = SettingsModel()
        model.load(reply)
        XCTAssertEqual(model.sections, ["appearance", "terminal"])
        XCTAssertEqual(model.number("terminal.fontSize", 0), 15)
        XCTAssertTrue(model.values["terminal.fontSize"]?.isModified ?? false)
        XCTAssertEqual(model.values["gui.enabled"]?.machines["m1"], .bool(false))
        XCTAssertEqual(model.definitions(in: "terminal").map(\.key), ["terminal.fontSize"])
        XCTAssertEqual(model.problems.first?.code, "unknown")
        XCTAssertEqual(model.file, "/tmp/settings-dev.json")
        // A value the core has not sent is the default.
        XCTAssertTrue(model.bool("terminal.mathHover", false))
        XCTAssertTrue(model.apply(JSONValue(any: ["t": "settings", "values": ["terminal.fontSize": ["value": 18, "source": "global"]], "problems": []] as [String: Any])))
        XCTAssertEqual(model.number("terminal.fontSize", 0), 18)
        XCTAssertTrue(model.problems.isEmpty)
        XCTAssertFalse(model.apply(JSONValue(any: ["t": "other"])))
        let fontSize = try XCTUnwrap(model.definition("terminal.fontSize"))
        XCTAssertTrue(SettingsModel.matches(fontSize, query: "font SIZE") { $0 == "settings.terminal.fontSize" ? "Font size" : nil })
        XCTAssertFalse(SettingsModel.matches(fontSize, query: "cursor") { _ in nil })
    }

    func testKeybindings() {
        let reply = JSONValue(any: [
            "sections": [["id": "tab", "order": 30]],
            "commands": [["id": "tab.new", "section": "tab", "when": "terminal"], ["id": "tab.close", "section": "tab", "when": "terminal"]],
            "defaults": ["mac": [["key": "ctrl+b c", "command": "tab.new", "when": "terminal"], ["key": "cmd+t", "command": "tab.new", "when": "terminal"]]],
            "user": [["key": "ctrl+b x", "command": "tab.close"]],
            "effective": ["mac": [["key": "ctrl+b c", "command": "tab.new", "when": "terminal"], ["key": "cmd+t", "command": "tab.new", "when": "terminal"],
                                  ["key": "ctrl+b x", "command": "tab.close", "when": "terminal"]],
                          "pc": []],
            "conflicts": ["mac": [["key": "ctrl+b x", "commands": ["pane.close", "tab.close"]]]],
            "problems": [],
        ] as [String: Any])
        let model = KeybindingsModel()
        model.load(reply)
        XCTAssertEqual(model.keys(of: "tab.new"), ["ctrl+b c", "cmd+t"])
        XCTAssertTrue(model.isChanged("tab.close"))
        XCTAssertFalse(model.isChanged("tab.new"))
        XCTAssertEqual(model.conflicts(of: "tab.close", key: "ctrl+b x"), ["pane.close"])
        let rules = KeybindingsModel.rules(for: "tab.new", keys: ["ctrl+b c", "cmd+shift+t"], user: model.user, defaults: model.defaults)
        XCTAssertEqual(rules, [
            .object(["key": .string("ctrl+b x"), "command": .string("tab.close")]),
            .object(["key": .string("cmd+t"), "command": .string("-tab.new")]),
            .object(["key": .string("cmd+shift+t"), "command": .string("tab.new")]),
        ])
        XCTAssertEqual(KeybindingsModel.reset("tab.close", user: model.user), [])
    }

    func testEvents() {
        if case let .settings(message)? = EventConnection.decode(#"{"t":"settings","values":{},"problems":[]}"#) {
            XCTAssertEqual(message["t"]?.string, "settings")
        } else {
            XCTFail("settings message")
        }
        if case .keybindings? = EventConnection.decode(#"{"t":"keybindings","effective":{"mac":[]}}"#) {} else { XCTFail("keybindings message") }
    }
}
