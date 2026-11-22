//go:build unix

package history

import (
	"bytes"
	"path"
	"strings"
	"unicode/utf8"
)

// maxConfig bounds the user's herdr-core configuration file as read here.
const maxConfig = 64 << 10

// configPath is the user's herdr-core configuration file, as herdr-core
// finds it with the environment the agent starts it with:
// $XDG_CONFIG_HOME/herdr-core/config.toml, else ~/.config/herdr-core/.
func configPath(home string, environ []string) string {
	dir := ""
	for _, kv := range environ {
		if v, ok := strings.CutPrefix(kv, "XDG_CONFIG_HOME="); ok {
			dir = v
		}
	}
	if !path.IsAbs(dir) {
		if !path.IsAbs(home) {
			return ""
		}
		dir = path.Join(home, ".config")
	}
	return path.Join(dir, "herdr-core", "config.toml")
}

// restoreScreen tells whether the user's herdr-core configuration has
// restore_screen = true: herdr-core then shows a kept terminal's last
// screen above the new shell itself, after a stop of the terminal core but
// not after the machine lost its power (core and holder ended), when it
// has nothing to restore. The answer is advisory: a page uses it only
// until a capture of the new shell tells (meta.Restored). The file is the
// user's own, shared with their other herdr-core sessions: it is only
// read, as a regular file of at most maxConfig bytes, never written.
func restoreScreen(home string, environ []string) bool {
	p := configPath(home, environ)
	if p == "" {
		return false
	}
	// A link is followed: the user's dotfiles may link it, and herdr-core
	// reads it so.
	b, err := readFile(p, maxConfig, 0)
	if err != nil {
		return false
	}
	return parseRestoreScreen(b)
}

// parseRestoreScreen reads restore_screen from a TOML file with what
// herdr-core's flat configuration needs of TOML: a top-level key (bare or
// quoted) set to true or false, with comments, after an optional byte
// order mark. The keys after a table's header are not top-level. A file
// that is not UTF-8, has the key twice or a value that is not a boolean
// counts as false here. herdr-core cannot load such a file at all and then
// restores nothing: its kept terminals wait for a shell until the file is
// fixed. A line parser cannot tell a key inside a multi-line string, or a
// file with another syntax error, from a valid one, so the answer may be
// true where herdr-core loads nothing; it is advisory (restoreScreen).
func parseRestoreScreen(b []byte) bool {
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	if !utf8.Valid(b) {
		return false
	}
	found, on := false, false
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		if line[0] == '[' {
			break
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue // a line of a value that spans lines
		}
		key = strings.TrimSpace(key)
		if len(key) >= 2 && (key[0] == '"' || key[0] == '\'') && key[len(key)-1] == key[0] {
			key = key[1 : len(key)-1]
		}
		if key != "restore_screen" {
			continue
		}
		if i := strings.IndexByte(val, '#'); i >= 0 {
			val = val[:i]
		}
		if found {
			return false
		}
		found = true
		switch strings.TrimSpace(val) {
		case "true":
			on = true
		case "false":
			on = false
		default:
			return false
		}
	}
	return on
}
