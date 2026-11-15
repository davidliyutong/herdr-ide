package keybindings

import (
	"fmt"
	"regexp"
	"strings"
)

// Key syntax: a key sequence is one or more strokes separated by spaces
// ("ctrl+b c" is ctrl+b, then c); a stroke is modifiers and a key joined by
// "+" ("cmd+shift+t"). The canonical form, which every client compares,
// writes modifiers in the order cmd, ctrl, alt, shift and names keys in
// lower case after the US layout's unshifted keys ("?" is "shift+slash").
// web/src/keys.ts implements the same rules; design/testdata/keys holds the
// vectors both are tested with.

// Stroke is one key press with its modifiers.
type Stroke struct {
	Cmd, Ctrl, Alt, Shift bool
	Key                   string
}

func (s Stroke) String() string {
	var b strings.Builder
	for _, m := range []struct {
		on   bool
		name string
	}{{s.Cmd, "cmd"}, {s.Ctrl, "ctrl"}, {s.Alt, "alt"}, {s.Shift, "shift"}} {
		if m.on {
			b.WriteString(m.name)
			b.WriteByte('+')
		}
	}
	b.WriteString(s.Key)
	return b.String()
}

// Sequence is a key sequence: a stroke, or a chord of several.
type Sequence []Stroke

func (q Sequence) String() string {
	parts := make([]string, len(q))
	for i, s := range q {
		parts[i] = s.String()
	}
	return strings.Join(parts, " ")
}

// MaxStrokes bounds a sequence.
const MaxStrokes = 4

// ParseError tells why a key sequence was refused; Code is one of empty,
// modifier, key, repeat, typing, length.
type ParseError struct {
	Code, Detail string
}

func (e *ParseError) Error() string {
	if e.Detail == "" {
		return "key: " + e.Code
	}
	return fmt.Sprintf("key: %s: %s", e.Code, e.Detail)
}

var modifierNames = map[string]string{
	"cmd": "cmd", "command": "cmd", "meta": "cmd", "super": "cmd", "win": "cmd",
	"ctrl": "ctrl", "control": "ctrl",
	"alt": "alt", "option": "alt", "opt": "alt",
	"shift": "shift",
}

var namedKeys = map[string]bool{
	"tab": true, "space": true, "enter": true, "escape": true, "backspace": true, "delete": true, "insert": true,
	"left": true, "right": true, "up": true, "down": true, "home": true, "end": true, "pageup": true, "pagedown": true,
	"minus": true, "equal": true, "comma": true, "period": true, "slash": true, "backslash": true,
	"semicolon": true, "quote": true, "backtick": true, "bracketleft": true, "bracketright": true,
}

var keyAliases = map[string]string{
	"esc": "escape", "return": "enter", "del": "delete", "ins": "insert",
	"arrowleft": "left", "arrowright": "right", "arrowup": "up", "arrowdown": "down",
	"pgup": "pageup", "pgdn": "pagedown", "pgdown": "pagedown",
	"-": "minus", "=": "equal", ",": "comma", ".": "period", "/": "slash", "\\": "backslash",
	";": "semicolon", "'": "quote", "`": "backtick", "[": "bracketleft", "]": "bracketright",
}

// shiftedKeys are characters typed with Shift on a US layout, and the key.
var shiftedKeys = map[string]string{
	"?": "slash", "{": "bracketleft", "}": "bracketright", "|": "backslash", "_": "minus", "plus": "equal", "+": "equal",
	":": "semicolon", "\"": "quote", "~": "backtick", "<": "comma", ">": "period",
	"!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
}

var plainKey = regexp.MustCompile(`^([a-z0-9]|f([1-9]|1[0-9]|2[0-4]))$`)
var functionKey = regexp.MustCompile(`^f([1-9]|1[0-9]|2[0-4])$`)

// parseStroke reads one stroke.
func parseStroke(text string) (Stroke, error) {
	lower := strings.ToLower(text)
	var parts []string
	switch {
	case lower == "+":
		parts = []string{"+"}
	case strings.HasSuffix(lower, "++"):
		parts = append(strings.Split(strings.TrimSuffix(lower, "++"), "+"), "+")
	default:
		parts = strings.Split(lower, "+")
	}
	key := parts[len(parts)-1]
	var s Stroke
	for _, p := range parts[:len(parts)-1] {
		m, ok := modifierNames[p]
		if !ok {
			return s, &ParseError{"modifier", p}
		}
		flag := map[string]*bool{"cmd": &s.Cmd, "ctrl": &s.Ctrl, "alt": &s.Alt, "shift": &s.Shift}[m]
		if *flag {
			return s, &ParseError{"repeat", m}
		}
		*flag = true
	}
	if a, ok := keyAliases[key]; ok {
		key = a
	} else if k, ok := shiftedKeys[key]; ok {
		s.Shift, key = true, k
	}
	if key == "" {
		return s, &ParseError{"empty", ""}
	}
	if !plainKey.MatchString(key) && !namedKeys[key] {
		return s, &ParseError{"key", key}
	}
	s.Key = key
	return s, nil
}

// Parse reads a key sequence. The first stroke must hold cmd, ctrl or alt
// (or be a function key), so a binding never takes a key that types text.
func Parse(text string) (Sequence, error) {
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return nil, &ParseError{"empty", ""}
	}
	if len(fields) > MaxStrokes {
		return nil, &ParseError{"length", fmt.Sprintf("at most %d strokes", MaxStrokes)}
	}
	seq := make(Sequence, 0, len(fields))
	for _, f := range fields {
		s, err := parseStroke(f)
		if err != nil {
			return nil, err
		}
		seq = append(seq, s)
	}
	if first := seq[0]; !first.Cmd && !first.Ctrl && !first.Alt && !functionKey.MatchString(first.Key) {
		return nil, &ParseError{"typing", first.String()}
	}
	return seq, nil
}

// Normalize returns a key sequence in its canonical form.
func Normalize(text string) (string, error) {
	seq, err := Parse(text)
	if err != nil {
		return "", err
	}
	return seq.String(), nil
}
