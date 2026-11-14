import Foundation

/// LaTeX formulas in terminal text, for the formula shown when the pointer
/// rests on one: the rules of web/src/terminal/math.ts, on UTF-16 offsets as
/// there, run on the vectors of design/testdata/math. Agents write markdown
/// math — $…$ and $$…$$, \(…\) and \[…\] — and their terminal renderers drop
/// the backslash before punctuation, so \[ … \] can arrive as lines holding
/// only "[" and "]", and \( … \) as ( … ). Text that only looks like a
/// formula is weeded out by KaTeX, which must read it before it is shown.
public enum MathText {
    public struct Found: Equatable {
        /// UTF-16 offsets of the formula with its delimiters.
        public var start: Int
        public var end: Int
        /// The formula without its delimiters.
        public var tex: String
        public var display: Bool
    }

    static let maxTex = 4000
    static let maxParen = 400

    private static func regex(_ pattern: String) -> NSRegularExpression {
        try! NSRegularExpression(pattern: pattern, options: [])
    }

    private static let displayDollars = regex(#"\$\$([\s\S]+?)\$\$"#)
    private static let displayBrackets = regex(#"\\\[([\s\S]+?)\\\]"#)
    private static let bareBrackets = regex(#"(?<=^|\n)[ \t]*\[[ \t]*\n([\s\S]+?)\n[ \t]*\][ \t]*(?=\n|$)"#)
    private static let inlineParens = regex(#"\\\(([\s\S]+?)\\\)"#)
    private static let texish = regex(#"[\\^_{}=]"#)
    private static let command = regex(#"\\[A-Za-z]+"#)
    private static let blankLine = regex(#"\n[ \t]*\n"#)

    private static func has(_ re: NSRegularExpression, _ text: String) -> Bool {
        re.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) != nil
    }

    /// Formulas in text, ordered by where they start. None spans an empty
    /// line.
    public static func find(_ text: String) -> [Found] {
        let ns = text as NSString
        let u = Array(text.utf16)
        var out: [Found] = []
        func add(_ start: Int, _ end: Int, _ tex: String, _ display: Bool) -> Bool {
            let t = tex.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.isEmpty || t.utf16.count > maxTex || has(blankLine, tex) { return false }
            if out.contains(where: { start < $0.end && end > $0.start }) { return false }
            out.append(Found(start: start, end: end, tex: t, display: display))
            return true
        }
        func char(_ i: Int) -> UInt16? { u.indices.contains(i) ? u[i] : nil }
        func escaped(_ i: Int) -> Bool { char(i - 1) == 0x5C }
        func blank(_ c: UInt16?) -> Bool {
            guard let c, let scalar = Unicode.Scalar(c) else { return c == nil }
            return CharacterSet.whitespacesAndNewlines.contains(scalar)
        }
        func each(_ re: NSRegularExpression, _ body: (NSTextCheckingResult) -> Void) {
            re.enumerateMatches(in: text, range: NSRange(location: 0, length: ns.length)) { m, _, _ in if let m { body(m) } }
        }
        let dollar: UInt16 = 0x24

        // Display formulas first: their delimiters contain the inline ones'.
        each(displayDollars) { m in
            if !escaped(m.range.location) { _ = add(m.range.location, NSMaxRange(m.range), ns.substring(with: m.range(at: 1)), true) }
        }
        each(displayBrackets) { m in _ = add(m.range.location, NSMaxRange(m.range), ns.substring(with: m.range(at: 1)), true) }
        each(bareBrackets) { m in
            let tex = ns.substring(with: m.range(at: 1))
            if has(command, tex) { _ = add(m.range.location, NSMaxRange(m.range), tex, true) }
        }
        each(inlineParens) { m in _ = add(m.range.location, NSMaxRange(m.range), ns.substring(with: m.range(at: 1)), false) }

        // $…$: the $ opening it is followed by a non-space, the one closing
        // it follows a non-space and is not followed by a digit.
        var i = 0
        while i < u.count {
            defer { i += 1 }
            if u[i] != dollar || escaped(i) || char(i + 1) == dollar || char(i - 1) == dollar || blank(char(i + 1)) { continue }
            var j = i + 2
            while j < u.count, j - i <= maxTex {
                if u[j] != dollar || escaped(j) {
                    j += 1
                    continue
                }
                let next = char(j + 1)
                if next == dollar || blank(u[j - 1]) || next.map({ (0x30 ... 0x39).contains($0) }) == true { break }
                let tex = ns.substring(with: NSRange(location: i + 1, length: j - i - 1))
                if has(texish, tex), add(i, j + 1, tex, false) { i = j }
                break
            }
        }

        // \( … \) that lost its backslashes: parentheses not after a word
        // (a call) around a TeX command.
        func word(_ c: UInt16?) -> Bool {
            guard let c else { return false }
            return (0x30 ... 0x39).contains(c) || (0x41 ... 0x5A).contains(c) || (0x61 ... 0x7A).contains(c) || c == 0x5F
        }
        for i in u.indices where u[i] == 0x28 && !word(char(i - 1)) {
            var depth = 0
            var j = i
            while j < u.count, j - i <= maxParen {
                if u[j] == 0x28 {
                    depth += 1
                } else if u[j] == 0x29 {
                    depth -= 1
                    if depth == 0 {
                        let tex = ns.substring(with: NSRange(location: i + 1, length: j - i - 1))
                        if has(command, tex) { _ = add(i, j + 1, tex, false) }
                        break
                    }
                }
                j += 1
            }
        }
        return out.sorted { $0.start < $1.start }
    }

    /// A row of the screen: its text and the column of each UTF-16 offset of
    /// it, then the column after the row.
    public struct Row {
        public var text: String
        public var columns: [Int]
        /// The row's width in columns.
        public var width: Int

        /// A row as the terminal shows it, `width` columns wide: wide
        /// characters take two columns.
        public init(_ text: String, width: Int) {
            var cols: [Int] = []
            var col = 0
            for ch in text {
                let w = ch.unicodeScalars.contains { Self.isWide($0) } ? 2 : 1
                for _ in 0 ..< ch.utf16.count { cols.append(col) }
                col += w
            }
            cols.append(col)
            self.text = text
            columns = cols
            self.width = width
        }

        static func isWide(_ s: Unicode.Scalar) -> Bool {
            switch s.value {
            case 0x1100 ... 0x115F, 0x2E80 ... 0x303E, 0x3041 ... 0x33FF, 0x3400 ... 0x4DBF, 0x4E00 ... 0x9FFF, 0xA000 ... 0xA4CF,
                 0xAC00 ... 0xD7A3, 0xF900 ... 0xFAFF, 0xFE30 ... 0xFE4F, 0xFF00 ... 0xFF60, 0xFFE0 ... 0xFFE6, 0x1F300 ... 0x1F64F,
                 0x1F900 ... 0x1F9FF, 0x20000 ... 0x3FFFD:
                return true
            default:
                return false
            }
        }

        /// Whether the text reaches the row's last column: the line goes on
        /// in the next row.
        var reachesEnd: Bool {
            let n = (text.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression) as NSString).length
            return n > 0 && columns[n] >= width
        }
    }

    /// A formula on screen: its text and, per row, the columns it covers.
    public struct OnScreen: Equatable {
        public var tex: String
        public var display: Bool
        public var cells: [(row: Int, from: Int, to: Int)]

        public static func == (a: OnScreen, b: OnScreen) -> Bool {
            a.tex == b.tex && a.display == b.display && a.cells.map { [$0.row, $0.from, $0.to] } == b.cells.map { [$0.row, $0.from, $0.to] }
        }
    }

    /// The formula under the cell (`column`, `row`) of rows: the rows looked
    /// at are the paragraph around it (between empty rows, at most 40 each
    /// way); a row reaching the last column goes on in the next one after
    /// its indentation, other rows are separate lines.
    public static func at(column: Int, row y: Int, rows: [Row]) -> OnScreen? {
        func blank(_ r: Int) -> Bool { rows[r].text.trimmingCharacters(in: .whitespaces).isEmpty }
        guard rows.indices.contains(y), !blank(y) else { return nil }
        var a = y
        while a > 0, y - a < 40, !blank(a - 1) { a -= 1 }
        var b = y
        while b + 1 < rows.count, b - y < 40, !blank(b + 1) { b += 1 }
        var text = ""
        var cellOf: [(row: Int, from: Int, to: Int)?] = []
        for r in a ... b {
            let row = rows[r]
            let t = row.text as NSString
            var start = 0
            if r > a {
                if rows[r - 1].reachesEnd {
                    start = t.length - (row.text.replacingOccurrences(of: #"^\s+"#, with: "", options: .regularExpression) as NSString).length
                } else {
                    text += "\n"
                    cellOf.append(nil)
                }
            }
            let end = (row.text.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression) as NSString).length
            if start < end {
                for i in start ..< end { cellOf.append((r, row.columns[i], row.columns[i + 1])) }
                text += t.substring(with: NSRange(location: start, length: end - start))
            }
        }
        let u = Array(text.utf16)
        for found in find(text) {
            var cells: [(row: Int, from: Int, to: Int)] = []
            for i in found.start ..< found.end {
                guard let c = cellOf[i], let scalar = Unicode.Scalar(u[i]), !CharacterSet.whitespaces.contains(scalar) else { continue }
                if let last = cells.last, last.row == c.row {
                    cells[cells.count - 1].to = max(last.to, c.to)
                } else {
                    cells.append(c)
                }
            }
            if cells.contains(where: { $0.row == y && column >= $0.from && column < $0.to }) {
                return OnScreen(tex: found.tex, display: found.display, cells: cells)
            }
        }
        return nil
    }
}
