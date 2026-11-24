// Package hostid names the host a process runs on, for files that must be
// kept per host although the directory holding them may be on a home that
// several hosts share (NFS): databases, logs, executables, runtime
// directories and the terminal core's session.
package hostid

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"sync"
)

// Key is this host's key: its whole name (Name) and, when the system has
// one, "-" with the first 8 hex digits of the SHA-256 of its machine id
// (MachineID). Two hosts of one name (cloned machines, or node01 of two
// clusters that share a home) get different keys; the name is there for
// people looking at the files. The id is hashed (systemd asks programs not
// to show it), with a prefix of its own, so that the hash names no id
// elsewhere. Without an id (a container without /etc/machine-id) the key
// is the host's name alone.
var Key = sync.OnceValue(func() string {
	h, _ := os.Hostname()
	return KeyOf(h, MachineID())
})

// KeyOf is the key of host name h with machine id id ("" for none).
func KeyOf(h, id string) string {
	key := Name(h)
	if id = strings.TrimSpace(id); id != "" {
		key += "-" + idHash("store host", id)
	}
	return key
}

// ID is a short id of this host that does not change with its name: the
// first 8 hex digits of a hash of its machine id; without one, its name
// (Name), or a hash of it when it is longer than 24 bytes. It names what a
// host must find again after its name changed (macOS changes it with the
// network): its runtime directory when it has no /run/user, and its
// terminal core's session.
var ID = sync.OnceValue(func() string {
	h, _ := os.Hostname()
	return IDOf(h, MachineID())
})

// IDOf is ID for host name h with machine id id ("" for none).
func IDOf(h, id string) string {
	if id = strings.TrimSpace(id); id != "" {
		return idHash("host id", id)
	}
	if n := Name(h); len(n) <= 24 {
		return n
	}
	return idHash("host name", Name(h))
}

func idHash(prefix, s string) string {
	sum := sha256.Sum256([]byte(prefix + "\x00" + s))
	return hex.EncodeToString(sum[:4])
}

// MachineID is the machine's own id, which the system keeps on the
// machine (not on a home that hosts share), "" for none.
func MachineID() string { return machineID() }

// MaxName is the length of a host's name in keys at most: with the hash
// and a file's name, a file name stays far below the 255 bytes file
// systems take.
const MaxName = 128

// Name is host name h as keys have it: the whole name, lowercase, with
// what is not a letter, a digit, -, _ or . replaced by _, without dots at
// its ends, at most MaxName bytes; "localhost" for none.
func Name(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	var b strings.Builder
	for _, r := range h {
		if b.Len() >= MaxName {
			break
		}
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	if n := strings.Trim(b.String(), "."); n != "" {
		return n
	}
	return "localhost"
}

// ValidKey reports whether key may be a host's key (Key of some host, or
// of an earlier version: the host's first label): of the letters, digits,
// -, _ and . Name leaves, without a dot at its ends, at most as long as a
// name and a hash.
func ValidKey(key string) bool {
	if key == "" || len(key) > MaxName+9 || key[0] == '.' || key[len(key)-1] == '.' {
		return false
	}
	for _, r := range key {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}
