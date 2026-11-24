package machines

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxTargetLen bounds an ssh target, in bytes.
const MaxTargetLen = 255

// targetPunct are the ASCII characters besides letters and digits a target
// may hold: what destinations, ssh:// URLs, IPv6 literals with zone ids and
// user names need (`[user@]host[:port]`, `ssh://u%40x@h:22`,
// `[fe80::1%en0]`, `user+tag=x,y~#@host`). The other printable ASCII
// characters, ! " $ & ' ( ) * ; < > ? \ ` { | }, are the shell's (quoting,
// substitution, separators, redirection, globs, braces, history): a user's
// ProxyCommand or Match exec runs %h, %r and %n in a shell, so a target
// never holds one. OpenSSH (9.6 and later) refuses most of them itself on
// the command line, but not ! * ? in host names, nor $ ! * ? and spaces in
// user names.
const targetPunct = "#%+,-./:=@[]^_~"

// CodeInvalidTarget is the code of a machine whose ssh target ValidTarget
// refuses (State.Code): it is shown, never dialed.
const CodeInvalidTarget = "invalid_target"

// ErrInvalidTarget is returned for an ssh target ValidTarget refuses.
var ErrInvalidTarget = errors.New("invalid ssh target")

// ValidTarget accepts an ssh destination as OpenSSH takes it, a
// ~/.ssh/config alias, host, user@host, ssh:// URL or IPv6 literal, of at
// most MaxTargetLen bytes of UTF-8 that does not start with "-" (which ssh
// would read as an option; every ssh command also puts "--" before it,
// internal/transport). Its characters are letters, digits, the
// punctuation of targetPunct, and outside ASCII Unicode letters, marks and
// numbers: no whitespace, control or format character and no shell
// metacharacter. spec/vectors/machines/targets.json holds the vectors
// the web UI's check (web/src/lib/machine.ts) runs too.
func ValidTarget(t string) bool {
	if t == "" || len(t) > MaxTargetLen || t[0] == '-' || !utf8.ValidString(t) {
		return false
	}
	for _, r := range t {
		switch {
		case r < utf8.RuneSelf:
			if !('a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' || '0' <= r && r <= '9' || strings.ContainsRune(targetPunct, r)) {
				return false
			}
		case unicode.In(r, unicode.L, unicode.M, unicode.N):
		default:
			return false
		}
	}
	return true
}
