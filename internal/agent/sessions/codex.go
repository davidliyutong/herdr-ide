//go:build unix

package sessions

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/agentproto"
)

// resolveCodex tries the command line (codex resume <id>), then the rollout
// a candidate process holds open (Linux), then the rollouts of the
// program's directory made since it started: the only one (source start) or
// the most recently written (a guess), both only when no other terminal
// runs Codex there.
func (r *Resolver) resolveCodex(ctx context.Context, kind string, p Proc) (Found, bool) {
	if id, ok := codexArgv(p.Argv); ok {
		return Found{ID: id, Source: agentproto.SessionFromArgv}, true
	}
	if p.PID <= 0 {
		return Found{}, false
	}
	homes := r.codexHomesOf(p.PID, p.Cwd)
	if root, ok := r.procfs(); ok {
		sessions := codexSessionDirs(homes)
		for _, c := range r.candidates(p.PID) {
			if ctx.Err() != nil {
				return Found{}, false
			}
			for _, t := range procfsFDs(root, c) {
				if id, ok := openRollout(t, sessions); ok {
					return Found{ID: id, Source: agentproto.SessionFromFD}, true
				}
			}
		}
	}
	if p.Cwd == "" {
		return Found{}, false
	}
	start, ok := r.startOf(p.PID)
	if !ok || r.peers(kind, p.Cwd) > 0 {
		return Found{}, false
	}
	cs := r.codexRollouts(ctx, homes, p.Cwd, start)
	switch len(cs) {
	case 0:
		return Found{}, false
	case 1:
		return Found{ID: cs[0].id, Source: agentproto.SessionFromStart}, true
	}
	newest := cs[0]
	for _, c := range cs[1:] {
		if c.mod.After(newest.mod) {
			newest = c
		}
	}
	return Found{ID: newest.id, Source: agentproto.SessionFromGuess}, true
}

// codexArgv is the session Codex's command line resumes (resume <id>, also
// after exec); only a session id counts, and the arguments after "--" are
// not looked at.
func codexArgv(argv []string) (string, bool) {
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == "--" {
			break
		}
		if argv[i] == "resume" && agentkinds.ValidSessionID(argv[i+1]) {
			return argv[i+1], true
		}
	}
	return "", false
}

// codexHomesOf are the Codex homes a process may write in: its own
// $CODEX_HOME when its environment can be read (Linux), and the agent's
// user's (codexHomes). A process's own home counts only when it is trusted
// (trustedDir), as Claude Code's configuration directory does: none does
// otherwise, as no rollout there is believed.
func (r *Resolver) codexHomesOf(pid int, cwd string) []string {
	var own string
	if env, ok := r.environ(pid); ok {
		own = r.expand(env["CODEX_HOME"], cwd)
	}
	if own != "" && !r.trustedDir(own, r.codexHomes()) {
		return nil
	}
	return uniq(append([]string{own}, r.codexHomes()...)...)
}

// codexSessionDirs are the sessions directories of homes, as named and
// resolved through symlinks (the links of /proc/<pid>/fd name resolved
// paths).
func codexSessionDirs(homes []string) []string {
	var out []string
	for _, h := range homes {
		d := path.Join(h, "sessions")
		out = append(out, d)
		if real, err := filepath.EvalSymlinks(d); err == nil {
			out = append(out, path.Clean(real))
		}
	}
	return uniq(out...)
}

// rolloutID is the session of a rollout's file name,
// rollout-<time>-<id>.jsonl.
func rolloutID(name string) (string, bool) {
	stem, ok := strings.CutSuffix(name, ".jsonl")
	if !ok || !strings.HasPrefix(stem, "rollout-") || len(stem) < len("rollout-")+37 {
		return "", false
	}
	id := stem[len(stem)-36:]
	if stem[len(stem)-37] != '-' || !agentkinds.ValidSessionID(id) {
		return "", false
	}
	return id, true
}

// openRollout is the session of a file a Codex process holds open when it
// is a rollout inside one of the sessions directories.
func openRollout(target string, sessions []string) (string, bool) {
	id, ok := rolloutID(path.Base(target))
	if !ok {
		return "", false
	}
	for _, s := range sessions {
		if strings.HasPrefix(target, s+"/") {
			return id, true
		}
	}
	return "", false
}

// codexDays are the dated directories (YYYY/MM/DD, local time) that may
// hold a rollout made between start and now: from the day before start's to
// the day after now's, as the agent's and Codex's time zones may differ; at
// most 9 days back from now and the 3 days around start.
func codexDays(start, now time.Time) []string {
	day := func(t time.Time) time.Time {
		y, m, d := t.Local().Date()
		return time.Date(y, m, d, 12, 0, 0, 0, time.Local)
	}
	s, n := day(start), day(now)
	var out []string
	add := func(t time.Time) {
		if k := t.Format("2006/01/02"); !slices.Contains(out, k) {
			out = append(out, k)
		}
	}
	for d := n.AddDate(0, 0, 1); !d.Before(s.AddDate(0, 0, -1)) && len(out) < 9; d = d.AddDate(0, 0, -1) {
		add(d)
	}
	for i := -1; i <= 1; i++ {
		add(s.AddDate(0, 0, i))
	}
	return out
}

// rollout is a candidate rollout of resolveCodex.
type rollout struct {
	id  string
	mod time.Time
}

// codexRollouts are the rollouts of homes' dated directories since start
// whose first line is a session_meta of cwd made at start - startSlack or
// later, the newest names first, reading at most maxMetaReads first lines.
func (r *Resolver) codexRollouts(ctx context.Context, homes []string, cwd string, start time.Time) []rollout {
	since := start.Add(-startSlack)
	var out []rollout
	reads := 0
	for _, h := range homes {
		for _, d := range codexDays(start, r.clock()) {
			dir := path.Join(h, "sessions", d)
			ents := readDir(dir, maxEntries)
			slices.SortFunc(ents, func(a, b os.DirEntry) int { return strings.Compare(b.Name(), a.Name()) })
			for _, e := range ents {
				id, ok := rolloutID(e.Name())
				if !ok || !e.Type().IsRegular() || slices.ContainsFunc(out, func(c rollout) bool { return c.id == id }) {
					continue
				}
				info, err := e.Info()
				if err != nil || info.ModTime().Before(since) {
					continue
				}
				if reads >= maxMetaReads || ctx.Err() != nil {
					return out
				}
				reads++
				m, ok := r.rolloutMeta(path.Join(dir, e.Name()))
				if !ok || m.id != id || !samePath(m.cwd, cwd) || m.started.Before(since) {
					continue
				}
				out = append(out, rollout{id: id, mod: info.ModTime()})
			}
		}
	}
	return out
}

// rolloutMeta is what a rollout's first line (session_meta) says.
type rolloutMeta struct {
	id, cwd string
	started time.Time
}

// rolloutMeta reads a rollout's session_meta, kept by path once complete.
func (r *Resolver) rolloutMeta(file string) (rolloutMeta, bool) {
	r.mu.Lock()
	m, ok := r.metas[file]
	r.mu.Unlock()
	if ok {
		return m, true
	}
	f, err := openNoFollow(file)
	if err != nil {
		return rolloutMeta{}, false
	}
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		f.Close()
		return rolloutMeta{}, false
	}
	m, ok = decodeSessionMeta(io.LimitReader(f, maxMetaLine))
	f.Close()
	if !ok {
		return rolloutMeta{}, false
	}
	r.mu.Lock()
	if r.metas == nil || len(r.metas) >= maxRemembered {
		r.metas = map[string]rolloutMeta{}
	}
	r.metas[file] = m
	r.mu.Unlock()
	return m, true
}

// decodeSessionMeta reads a rollout's first line, a session_meta, token by
// token and stops once it has the type, the session's id, its directory
// and when it was made (payload.timestamp, else the line's): the line goes
// on with the model's instructions, tens of KiB or more, which are never
// needed. Any other first line, or one cut off before those fields, is not
// a session_meta.
func decodeSessionMeta(rd io.Reader) (rolloutMeta, bool) {
	dec := json.NewDecoder(rd)
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return rolloutMeta{}, false
	}
	var m rolloutMeta
	var typ, ts, lineTS string
	done := func() bool { return typ == "session_meta" && m.id != "" && m.cwd != "" && ts != "" }
	finish := func() (rolloutMeta, bool) {
		t, err := time.Parse(time.RFC3339Nano, ts)
		if err != nil {
			return rolloutMeta{}, false
		}
		m.started = t
		return m, true
	}
	str := func(s *string) bool { return dec.Decode(s) == nil }
	skip := func() bool {
		var raw json.RawMessage
		return dec.Decode(&raw) == nil
	}
	for dec.More() {
		k, err := dec.Token()
		if err != nil {
			return rolloutMeta{}, false
		}
		switch k {
		case "type":
			if !str(&typ) || typ != "session_meta" {
				return rolloutMeta{}, false
			}
		case "timestamp":
			if !str(&lineTS) {
				return rolloutMeta{}, false
			}
		case "payload":
			if t, err := dec.Token(); err != nil || t != json.Delim('{') {
				return rolloutMeta{}, false
			}
			for dec.More() {
				pk, err := dec.Token()
				if err != nil {
					return rolloutMeta{}, false
				}
				ok := true
				switch pk {
				case "id":
					ok = str(&m.id)
				case "cwd":
					ok = str(&m.cwd)
				case "timestamp":
					ok = str(&ts)
				default:
					ok = skip()
				}
				if !ok {
					return rolloutMeta{}, false
				}
				if done() {
					return finish()
				}
			}
			if _, err := dec.Token(); err != nil {
				return rolloutMeta{}, false
			}
			if ts == "" {
				ts = lineTS
			}
		default:
			if !skip() {
				return rolloutMeta{}, false
			}
		}
		if done() {
			return finish()
		}
	}
	return rolloutMeta{}, false
}

// codexStamp writes what Resolve reads for Codex to b: for each dated
// directory, the newest rollout's name (names start with the time they
// were made) and how many there are; while the answer is a guess, the
// newest one's mtime too.
func (r *Resolver) codexStamp(b *strings.Builder, p Proc, last Found) {
	start, ok := r.startOf(p.PID)
	now := r.clock()
	if !ok {
		start = now
	}
	for _, h := range r.codexHomesOf(p.PID, p.Cwd) {
		for _, d := range codexDays(start, now) {
			dir := path.Join(h, "sessions", d)
			newest, n := "", 0
			for _, e := range readDir(dir, maxEntries) {
				if _, ok := rolloutID(e.Name()); ok {
					n++
					newest = max(newest, e.Name())
				}
			}
			b.WriteString(dir + "\x00" + newest + "\x00" + strconv.Itoa(n) + "\n")
			if newest != "" && last.Source == agentproto.SessionFromGuess {
				stampFile(b, path.Join(dir, newest))
			}
		}
	}
}
