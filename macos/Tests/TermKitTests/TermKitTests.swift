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

final class LayoutTests: XCTestCase {
    func testTabsAndSplits() throws {
        var layout = Layout()
        XCTAssertFalse(layout.split(.horizontal, new: "t9"))
        layout.open("t1")
        layout.open("t2")
        layout.open("t1") // selects it where it is
        XCTAssertEqual(layout.selected, 0)
        XCTAssertEqual(layout.tabs.count, 2)
        XCTAssertTrue(layout.split(.horizontal, new: "t3"))
        XCTAssertTrue(layout.split(.vertical, new: "t4"))
        XCTAssertEqual(layout.tabs[0].root, .split(axis: .horizontal, ratio: 0.5, first: .terminal("t1"),
                                                   second: .split(axis: .vertical, ratio: 0.5, first: .terminal("t3"), second: .terminal("t4"))))
        XCTAssertEqual(layout.tabs[0].focused, "t4")
        XCTAssertEqual(layout.terminals, ["t1", "t3", "t4", "t2"])

        // Ratios are set by the path to their split, and clamped.
        layout.tabs[0].root = layout.tabs[0].root.settingRatio(0.99, at: [true][...])
        guard case let .split(_, outer, _, .split(_, inner, _, _)) = layout.tabs[0].root else { return XCTFail("shape") }
        XCTAssertEqual(outer, 0.5)
        XCTAssertEqual(inner, 0.9)

        // The layout survives a round trip through its document, whose
        // shape other clients read too.
        let data = try JSONEncoder().encode(layout)
        XCTAssertEqual(try JSONDecoder().decode(Layout.self, from: data), layout)
        let document = #"{"tabs":[{"root":{"split":"vertical","ratio":0.95,"children":[{"terminal":"a"},{"terminal":"b"}]},"focused":"b"}],"selected":0}"#
        let decoded = try JSONDecoder().decode(Layout.self, from: Data(document.utf8))
        XCTAssertEqual(decoded.tabs[0].root, .split(axis: .vertical, ratio: 0.9, first: .terminal("a"), second: .terminal("b")))
        let reencoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? [String: Any]
        let root = (reencoded?["tabs"] as? [[String: Any]])?[0]["root"] as? [String: Any]
        XCTAssertEqual(root?["split"] as? String, "vertical")
        XCTAssertEqual((root?["children"] as? [[String: String]])?.map { $0["terminal"] }, ["a", "b"])
        XCTAssertThrowsError(try JSONDecoder().decode(Layout.Node.self, from: Data(#"{"split":"vertical","children":[{"terminal":"a"}]}"#.utf8)))

        // Closing a pane gives its sibling the room and moves the focus.
        layout.close("t4")
        XCTAssertEqual(layout.tabs[0].root, .split(axis: .horizontal, ratio: 0.5, first: .terminal("t1"), second: .terminal("t3")))
        XCTAssertEqual(layout.tabs[0].focused, "t1")
        // Closing a tab before the selected one keeps the selection on its tab.
        layout.selected = 1
        layout.close("t1")
        layout.close("t3")
        XCTAssertEqual(layout.tabs.map(\.root), [.terminal("t2")])
        XCTAssertEqual(layout.selected, 0)
        XCTAssertFalse(layout.prune(keeping: ["t2"]))
        XCTAssertTrue(layout.prune(keeping: []))
        XCTAssertTrue(layout.tabs.isEmpty)
        XCTAssertEqual(layout.selected, 0)
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
        let literal = try NSRegularExpression(pattern: #"tr\("([a-z_.A-Z]+)"|add\(menu, "([a-z_.A-Z]+)""#)
        var used: Set<String> = []
        for match in literal.matches(in: code, range: NSRange(code.startIndex..., in: code)) {
            for group in 1...2 {
                if let range = Range(match.range(at: group), in: code) { used.insert(String(code[range])) }
            }
        }
        // Keys built from a state or code: tr("backend." + code).
        let prefixes = ["backend.", "machine.", "status.", "quicklook.", "settings."]
        for key in used where !prefixes.contains(key) {
            XCTAssertNotNil(english[key], "missing string \(key)")
        }
        for key in english.keys where !used.contains(key) && !prefixes.contains(where: key.hasPrefix) {
            XCTFail("unused string \(key)")
        }
    }
}
