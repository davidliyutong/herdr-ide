package usage

import (
	"slices"
	"sync"
	"time"
)

// Memo keeps between the Limits calls of a process what is costly to get
// again: agy's answer (seconds of CPU and a few hundred MB per run), the
// rate limits of each Codex home's newest session log (a rollout is tens of
// MB), and the Kimi Code credential files whose refresh token the provider
// refused (not tried again until the file changes). Its methods do nothing
// on a nil Memo.
type Memo struct {
	mu       sync.Mutex
	agy      map[string]agyRun
	codexLog map[string]codexLogRead
	// kimi maps a credential file to the digest of its content when its
	// refresh token was refused.
	kimi map[string][32]byte
	// agLS remembers the last working Antigravity language server endpoint
	// (port, CSRF token and scheme) so polls avoid spawning ps/lsof and
	// probing non-RPC ports while the same server stays up.
	agLS *agLSEndpoint
}

type agLSEndpoint struct {
	port   int
	csrf   string
	scheme string
}

type agyRun struct {
	a  Account
	at time.Time
}

// codexLogRead is what the newest log of a Codex home said, while that
// log is unchanged.
type codexLogRead struct {
	path  string
	size  int64
	mtime time.Time
	a     *Account
}

func copyAccount(a Account) Account {
	a.Windows = slices.Clone(a.Windows)
	a.Balances = slices.Clone(a.Balances)
	return a
}

// lastAgy is the last answer of agy at bin while it may be given again:
// AgyEvery after one with numbers, AgyBackoff after a failure.
func (m *Memo) lastAgy(bin string, now time.Time) (Account, bool) {
	if m == nil {
		return Account{}, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.agy[bin]
	if !ok {
		return Account{}, false
	}
	wait := AgyEvery
	if r.a.Status != StatusOK {
		wait = AgyBackoff
	}
	if now.Before(r.at) || now.Sub(r.at) >= wait {
		return Account{}, false
	}
	return copyAccount(r.a), true
}

func (m *Memo) keepAgy(bin string, a Account, now time.Time) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.agy == nil {
		m.agy = map[string]agyRun{}
	}
	m.agy[bin] = agyRun{copyAccount(a), now}
}

// codexLogOf is what home's newest log said when it was read, if that log
// (path) has not changed since; a nil account: it had no rate limits.
func (m *Memo) codexLogOf(home, path string, size int64, mtime time.Time) (*Account, bool) {
	if m == nil {
		return nil, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.codexLog[home]
	if !ok || r.path != path || r.size != size || !r.mtime.Equal(mtime) {
		return nil, false
	}
	if r.a == nil {
		return nil, true
	}
	a := copyAccount(*r.a)
	return &a, true
}

func (m *Memo) keepCodexLog(home, path string, size int64, mtime time.Time, a *Account) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.codexLog == nil {
		m.codexLog = map[string]codexLogRead{}
	}
	r := codexLogRead{path: path, size: size, mtime: mtime}
	if a != nil {
		c := copyAccount(*a)
		r.a = &c
	}
	m.codexLog[home] = r
}

// kimiRefused tells whether file, with content b, is the one whose refresh
// token the provider refused.
func (m *Memo) kimiRefused(file string, b []byte) bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	sum, ok := m.kimi[file]
	return ok && sum == kimiFileSum(b)
}

func (m *Memo) keepKimiRefused(file string, b []byte) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.kimi == nil {
		m.kimi = map[string][32]byte{}
	}
	m.kimi[file] = kimiFileSum(b)
}

func (m *Memo) lastAntigravityLS() (agLSEndpoint, bool) {
	if m == nil {
		return agLSEndpoint{}, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.agLS == nil {
		return agLSEndpoint{}, false
	}
	return *m.agLS, true
}

func (m *Memo) keepAntigravityLS(ep agLSEndpoint) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.agLS = &ep
}

func (m *Memo) dropAntigravityLS() {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.agLS = nil
}
