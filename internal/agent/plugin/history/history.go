//go:build unix

// Package history is the machine side of the terminal history plugin
// (internal/plugins/history): snapshots of the terminals' output, with
// their styles, in the agent's data directory, which pages show above the
// new shell of a terminal whose program was replaced (its terminal core
// started again). The core asks for captures only while history.capture is
// on for the machine. Actions:
//
//   - capture {lines, maxTerminals, maxTotalBytes, days}: snapshots every
//     live terminal of the instance's terminal core whose screen changed
//     since its last snapshot, within the limits (agentproto.History*),
//     and removes what the limits, the age and the terminal core's records
//     no longer allow; it changes files, and the core never asks for it
//     in read-only mode;
//   - list: the snapshots, whether the current one shows a screen the
//     terminal core restored itself, and whether the user's herdr-core
//     configuration restores screens (restore_screen);
//   - read {terminal, generation}: one generation's bytes;
//   - clear {terminal?}: one terminal's snapshots, or all;
//   - adopt {from, to}: the newest generation of from's snapshots becomes
//     the previous one of to, a terminal of the terminal core's records
//     that took from's place, and from's snapshots go ({adopted}).
//
// Every limit is enforced here, whatever the core asks: lines per
// snapshot, bytes per generation, terminals, total bytes and days. The
// days apply also without captures: when the agent starts, and at every
// list and read. The snapshots of a terminal that finished with its
// program go at the next capture; those of one gone from the terminal
// core's records once the agent has seen it gone for goneGrace, which
// leaves a page the time to adopt them for the terminal that took its
// place. Errors reach the core with a code and a fixed wording, never with
// a path of the machine.
package history

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path"
	"sort"
	"strings"
	"time"

	"herdr-ide/internal/agent/plugin"
	"herdr-ide/internal/agentproto"
	"herdr-ide/internal/hc"
)

// ID names the plugin on every side.
const ID = "history"

// clearTimeout bounds a clear, which waits for a capture that holds the
// snapshots' directory.
const clearTimeout = 40 * time.Second

func init() { plugin.Register(ID, handle) }

func handle(ctx context.Context, st net.Conn, action string, params json.RawMessage, env *plugin.Env) error {
	switch action {
	case agentproto.HistoryCapture:
		var p agentproto.HistoryCaptureParams
		if err := plugin.Decode(params, &p); err != nil {
			return plugin.Reply(st, nil, err)
		}
		ctx, cancel := untilClosed(ctx, st, captureTimeout)
		defer cancel()
		res, err := capture(ctx, env, p)
		return plugin.Reply(st, res, err)
	case agentproto.HistoryList:
		return plugin.Reply(st, list(env), nil)
	case agentproto.HistoryRead:
		var p agentproto.HistoryReadParams
		if err := plugin.Decode(params, &p); err != nil {
			return plugin.Reply(st, nil, err)
		}
		res, err := read(env, p)
		return plugin.Reply(st, res, err)
	case agentproto.HistoryClear:
		var p agentproto.HistoryClearParams
		if err := plugin.Decode(params, &p); err != nil {
			return plugin.Reply(st, nil, err)
		}
		ctx, cancel := untilClosed(ctx, st, clearTimeout)
		defer cancel()
		res, err := clearSnapshots(ctx, env, p)
		return plugin.Reply(st, res, err)
	case agentproto.HistoryAdopt:
		var p agentproto.HistoryAdoptParams
		if err := plugin.Decode(params, &p); err != nil {
			return plugin.Reply(st, nil, err)
		}
		ctx, cancel := untilClosed(ctx, st, clearTimeout)
		defer cancel()
		res, err := adopt(ctx, env, p)
		return plugin.Reply(st, res, err)
	}
	return plugin.Reply(st, nil, plugin.Errorf("bad_params", "history: unknown action %q", action))
}

// untilClosed is ctx ended after d or when the core closes st (it stopped
// waiting, plugin.UntilClosed).
func untilClosed(ctx context.Context, st net.Conn, d time.Duration) (context.Context, context.CancelFunc) {
	ctx, closed := plugin.UntilClosed(ctx, st)
	ctx, cancel := context.WithTimeout(ctx, d)
	return ctx, func() {
		cancel()
		closed()
	}
}

// existingDir is the snapshots' directory when there is one (a read
// creates nothing), "" otherwise.
func existingDir(base string) string {
	if base == "" || !path.IsAbs(base) {
		return ""
	}
	dir := path.Join(base, dirName)
	if st, err := os.Lstat(dir); err != nil || !st.IsDir() {
		return ""
	}
	return dir
}

// environ is the environment the agent starts the terminal core with.
func environ(env *plugin.Env) []string {
	if env.Environ != nil {
		return env.Environ()
	}
	return os.Environ()
}

// storeError is a failure to use the snapshots' directory as the core gets
// it: a code and a fixed wording, never the directory's path.
func storeError(err error) error {
	if errors.Is(err, errBusy) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return plugin.Errorf("busy", "history: a capture holds the snapshots")
	}
	return plugin.Errorf("io", "history: the snapshots' directory cannot be used")
}

// list lists the terminals' snapshots, by address, after the expired ones
// went (Prune).
func list(env *plugin.Env) agentproto.HistoryListResult {
	out := agentproto.HistoryListResult{Terminals: []agentproto.HistoryEntry{}, RestoreScreen: restoreScreen(env.Home, environ(env))}
	dir := existingDir(env.Base)
	if dir == "" {
		return out
	}
	now := clock()
	Prune(env.Base, now)
	byAddr := map[string]*agentproto.HistoryEntry{}
	for _, e := range entries(dir) {
		addr, prev, ext, ok := parseName(e.Name())
		if !ok || ext != ".json" || !e.Type().IsRegular() {
			continue
		}
		// A writer that holds the directory meanwhile prunes too; until
		// then an expired generation is not listed.
		m := readMeta(dir, addr, prev)
		if m == nil || expired(m, now, 0) {
			continue
		}
		en := byAddr[addr]
		if en == nil {
			en = &agentproto.HistoryEntry{Terminal: addr}
			byAddr[addr] = en
		}
		if prev {
			s := m.HistorySnapshot
			en.Previous = &s
		} else {
			en.HistorySnapshot, en.Restored = m.HistorySnapshot, m.Restored
		}
	}
	for _, en := range byAddr {
		out.Terminals = append(out.Terminals, *en)
	}
	sort.Slice(out.Terminals, func(i, j int) bool { return out.Terminals[i].Terminal < out.Terminals[j].Terminal })
	return out
}

// read returns one generation's bytes. A capture may replace the
// generation meanwhile: what is returned is the bytes and the description
// of one generation, read again when they changed under it.
func read(env *plugin.Env, p agentproto.HistoryReadParams) (agentproto.HistoryData, error) {
	if !agentproto.ValidHistoryTerminal(p.Terminal) || !agentproto.ValidHistoryGeneration(p.Generation) {
		return agentproto.HistoryData{}, plugin.Errorf("bad_params", "history: bad terminal or generation")
	}
	dir := existingDir(env.Base)
	if dir == "" {
		return agentproto.HistoryData{}, plugin.Errorf("not_found", "history: no snapshot")
	}
	now := clock()
	Prune(env.Base, now)
	prev := p.Generation == agentproto.HistoryPrevious
	for range 3 {
		m := readMeta(dir, p.Terminal, prev)
		if m == nil || expired(m, now, 0) {
			return agentproto.HistoryData{}, plugin.Errorf("not_found", "history: no snapshot")
		}
		data, err := readRegular(path.Join(dir, fileName(p.Terminal, prev, ".vt")), agentproto.HistoryMaxBytes)
		if again := readMeta(dir, p.Terminal, prev); err != nil || again == nil || again.At != m.At || int64(len(data)) != m.Bytes {
			continue
		}
		return agentproto.HistoryData{Terminal: p.Terminal, Generation: p.Generation, HistorySnapshot: m.HistorySnapshot, Data: data}, nil
	}
	return agentproto.HistoryData{}, plugin.Errorf("busy", "history: the snapshot is being replaced")
}

// clearSnapshots removes one terminal's snapshots, or all with their
// temporary files.
func clearSnapshots(ctx context.Context, env *plugin.Env, p agentproto.HistoryClearParams) (agentproto.HistoryClearResult, error) {
	if p.Terminal != "" && !agentproto.ValidHistoryTerminal(p.Terminal) {
		return agentproto.HistoryClearResult{}, plugin.Errorf("bad_params", "history: bad terminal")
	}
	if existingDir(env.Base) == "" {
		return agentproto.HistoryClearResult{}, nil
	}
	s, _, err := openStore(ctx, env.Base, true, clock())
	if err != nil {
		return agentproto.HistoryClearResult{}, storeError(err)
	}
	defer s.close()
	forgetTerminal(p.Terminal)
	if p.Terminal != "" {
		if s.remove(p.Terminal) {
			return agentproto.HistoryClearResult{Removed: 1}, nil
		}
		return agentproto.HistoryClearResult{}, nil
	}
	n := s.clearAll()
	for _, e := range entries(s.dir) {
		if name := e.Name(); strings.HasPrefix(name, ".") && strings.HasSuffix(name, tmpSuffix) {
			os.Remove(path.Join(s.dir, name))
		}
	}
	return agentproto.HistoryClearResult{Removed: n}, nil
}

// adopt gives terminal p.To, which took the place of p.From, the newest
// generation of p.From's snapshots (its current, else its previous) as its
// previous generation, unless p.To has a previous one captured later;
// p.From's snapshots go either way. p.To must be a terminal of the
// terminal core's records. The generation keeps its time and the days it
// was written under. What the snapshots take does not grow (one generation
// moves, those it replaces go), so the limits the captures kept still
// hold.
func adopt(ctx context.Context, env *plugin.Env, p agentproto.HistoryAdoptParams) (agentproto.HistoryAdoptResult, error) {
	var res agentproto.HistoryAdoptResult
	if !agentproto.ValidHistoryAdopt(p) {
		return res, plugin.Errorf("bad_params", "history: bad terminals")
	}
	known, err := recorded(ctx, env, p.To)
	if err != nil {
		return res, err
	}
	if !known {
		return res, plugin.Errorf("not_found", "history: no such terminal")
	}
	if existingDir(env.Base) == "" {
		return res, nil
	}
	s, _, err := openStore(ctx, env.Base, true, clock())
	if err != nil {
		return res, storeError(err)
	}
	defer s.close()
	forgetTerminal(p.From)
	if res.Adopted, err = s.adopt(p.From, p.To); err != nil {
		return res, storeError(err)
	}
	return res, nil
}

// recorded tells whether addr is a terminal of the instance's terminal
// core's records.
func recorded(ctx context.Context, env *plugin.Env, addr string) (bool, error) {
	conn, err := dial(ctx, env.RunDir)
	if err != nil {
		return false, errNotRunning
	}
	defer conn.Close()
	lctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	var list struct {
		Terminals []hc.Terminal `json:"terminals"`
	}
	if err := conn.Call(lctx, "terminal.list", map[string]any{"all": true}, &list); err != nil {
		return false, errNotRunning
	}
	for _, t := range list.Terminals {
		if t.Address == addr {
			return true, nil
		}
	}
	return false, nil
}

// Prune applies the snapshots' retention below the agent's data directory
// base, as the agent's housekeeping does when it starts and list and read
// do: snapshots older than the days they were written under go, with what
// is not whole and temporary files older than an hour. It does not wait
// for a writer that holds the directory: a capture running meanwhile
// (also another agent's of the instance) does the same itself.
func Prune(base string, now time.Time) {
	if existingDir(base) == "" {
		return
	}
	s, _, err := openStore(context.Background(), base, false, now)
	if err != nil {
		return
	}
	defer s.close()
	s.pruneAge(now, 0)
}
