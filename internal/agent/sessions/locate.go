//go:build unix

package sessions

import (
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"herdr-ide/internal/agentkinds"
)

// location is a transcript Locate found and the session root it lies in,
// both resolved through symlinks, and the file it found there.
type location struct {
	file, root string
	id         fileID
}

// miss is a search that found no transcript: err (ErrNotFound or
// ErrCompressed), when every place was last searched (at) and when the
// places a new transcript appears in were (checked).
type miss struct {
	err         error
	at, checked time.Time
}

// Locate returns the transcript file of a session: an absolute path inside
// the kind's own session root (Claude Code: <claude dir>/projects/*/<id>.jsonl
// of $CLAUDE_CONFIG_DIR, ~/.claude and ~/.config/claude; Codex:
// <home>/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl and archived_sessions of
// $CODEX_HOME and ~/.codex), resolved through symlinks and still inside it,
// naming a regular file of the user's own with one name; the most recently
// modified one when there are several. The id is checked (ErrBadID) before
// it reaches any path. A miss is remembered (missTTL, missRecheck): a
// transcript made meanwhile is found within missRecheck of a caller asking
// again, one that existed before only after missTTL.
func (r *Resolver) Locate(kind, id string) (File, error) {
	if !agentkinds.ValidSessionID(id) {
		return File{}, ErrBadID
	}
	f := format(kind)
	if f == "" {
		return File{}, ErrUnknownKind
	}
	loc, err := r.locate(f, id)
	if err != nil {
		return File{}, err
	}
	return fileOf(f, loc), nil
}

// OpenLocated is Locate and File.Open in one: the session's transcript,
// open so that no symbolic link on its path was followed, as the file
// Locate saw. A transcript replaced since it was located (another file at
// the name, a link on the way) is located again once.
func (r *Resolver) OpenLocated(kind, id string) (*os.File, File, error) {
	if !agentkinds.ValidSessionID(id) {
		return nil, File{}, ErrBadID
	}
	f := format(kind)
	if f == "" {
		return nil, File{}, ErrUnknownKind
	}
	fh, loc, err := r.open(f, id)
	if err != nil {
		return nil, File{}, err
	}
	return fh, fileOf(f, loc), nil
}

// fileOf is the File of a location of format f.
func fileOf(f string, loc location) File {
	out := File{Path: loc.file, id: loc.id}
	if f == formatClaude {
		out.Subagents, out.subs = claudeSubagents(loc)
	}
	return out
}

// open locates a transcript of format f and opens it (openAs), locating it
// once more when it is not the file located.
func (r *Resolver) open(f, id string) (*os.File, location, error) {
	for try := 0; ; try++ {
		loc, err := r.locate(f, id)
		if err != nil {
			return nil, location{}, err
		}
		fh, err := openAs(loc.file, loc.id)
		if err == nil {
			return fh, loc, nil
		}
		if !errors.Is(err, ErrNotFound) || try > 0 {
			return nil, location{}, err
		}
		r.forget(f + "/" + id)
	}
}

// Describe reads what a transcript says of itself without parsing the
// conversation: Claude Code's first conversation line, Codex's
// session_meta. The Info is zero when the transcript does not say yet.
func (r *Resolver) Describe(kind, id string) (Info, error) {
	if !agentkinds.ValidSessionID(id) {
		return Info{}, ErrBadID
	}
	f := format(kind)
	if f == "" {
		return Info{}, ErrUnknownKind
	}
	fh, _, err := r.open(f, id)
	if err != nil {
		return Info{}, err
	}
	defer fh.Close()
	if f == formatClaude {
		return claudeInfoOf(fh), nil
	}
	m, ok := decodeSessionMeta(io.LimitReader(fh, maxMetaLine))
	if !ok {
		return Info{}, nil
	}
	return Info{Cwd: m.cwd, Started: m.started}, nil
}

// locate finds a session's transcript of format f; an earlier answer is
// used again while it still names, through no symlink, the file found, and
// an earlier miss while it is remembered (missTTL, missRecheck).
func (r *Resolver) locate(f, id string) (location, error) {
	key := f + "/" + id
	r.mu.Lock()
	loc, ok := r.located[key]
	r.mu.Unlock()
	if ok {
		if real, err := filepath.EvalSymlinks(loc.file); err == nil && real == loc.file {
			if st, ok := lstatOwn(loc.file); ok && st.id == loc.id {
				return loc, nil
			}
		}
		r.forget(key)
	}
	now := r.clock()
	r.mu.Lock()
	m, missed := r.misses[key]
	r.mu.Unlock()
	if missed && (now.Sub(m.at) >= missTTL || now.Before(m.at)) {
		missed = false
	}
	if missed && now.Sub(m.checked) < missRecheck && !now.Before(m.checked) {
		return location{}, m.err
	}
	var s search
	switch f {
	case formatClaude:
		r.searchClaude(&s, id)
	case formatCodex:
		// While a miss is remembered, only where a new rollout is made.
		r.searchCodex(&s, id, now, !missed)
	}
	if s.best.file == "" {
		err := ErrNotFound
		if s.compressed {
			err = ErrCompressed
		}
		if !missed || f == formatClaude {
			m.at = now
		}
		m.err, m.checked = err, now
		r.rememberMiss(key, m, now)
		return location{}, err
	}
	r.mu.Lock()
	delete(r.misses, key)
	if r.located == nil || len(r.located) >= maxRemembered {
		r.located = map[string]location{}
	}
	r.located[key] = s.best
	r.mu.Unlock()
	return s.best, nil
}

// forget drops the answer Locate keeps for key.
func (r *Resolver) forget(key string) {
	r.mu.Lock()
	delete(r.located, key)
	r.mu.Unlock()
}

// rememberMiss keeps a miss, at most maxMisses of them: the expired ones
// go first, then the oldest.
func (r *Resolver) rememberMiss(key string, m miss, now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.misses == nil {
		r.misses = map[string]miss{}
	}
	if _, ok := r.misses[key]; !ok && len(r.misses) >= maxMisses {
		oldest := ""
		for k, v := range r.misses {
			if now.Sub(v.at) >= missTTL || now.Before(v.at) {
				delete(r.misses, k)
				continue
			}
			if oldest == "" || v.at.Before(r.misses[oldest].at) {
				oldest = k
			}
		}
		if len(r.misses) >= maxMisses {
			delete(r.misses, oldest)
		}
	}
	r.misses[key] = m
}

// search collects the matches of a Locate.
type search struct {
	best       location
	mod        time.Time
	compressed bool
}

// consider takes p, a match under root (resolved), when it resolves through
// symlinks to a regular file of the user's own with one name still inside
// root, and keeps the most recently modified match.
func (s *search) consider(root, p string) bool {
	if _, err := os.Lstat(p); err != nil {
		return false
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil || !strings.HasPrefix(real, root+"/") {
		return false
	}
	fi, err := os.Lstat(real)
	if err != nil {
		return false
	}
	st, ok := statInfo(fi)
	if !ok || !st.own() {
		return false
	}
	if s.best.file == "" || fi.ModTime().After(s.mod) {
		s.best, s.mod = location{file: real, root: root, id: st.id}, fi.ModTime()
	}
	return true
}

// lstatOwn is what lstat says of p when it is a regular file of the user's
// own with one name.
func lstatOwn(p string) (fileStat, bool) {
	fi, err := os.Lstat(p)
	if err != nil {
		return fileStat{}, false
	}
	st, ok := statInfo(fi)
	return st, ok && st.own()
}

// resolvedRoot is a session root resolved through symlinks; false when it
// is not a directory.
func resolvedRoot(p string) (string, bool) {
	real, err := filepath.EvalSymlinks(p)
	if err != nil || !path.IsAbs(real) {
		return "", false
	}
	if st, err := os.Stat(real); err != nil || !st.IsDir() {
		return "", false
	}
	return real, true
}

// searchClaude looks for <id>.jsonl in every project directory of every
// Claude Code configuration directory.
func (r *Resolver) searchClaude(s *search, id string) {
	for _, d := range r.ClaudeDirs() {
		root, ok := resolvedRoot(path.Join(d, "projects"))
		if !ok {
			continue
		}
		for _, e := range readDir(root, maxProjects) {
			dir := path.Join(root, e.Name())
			s.consider(root, path.Join(dir, id+".jsonl"))
			if _, err := os.Lstat(path.Join(dir, id+".jsonl.zst")); err == nil {
				s.compressed = true
			}
		}
	}
}

// searchCodex looks for rollout-*-<id>.jsonl in every Codex home's sessions
// and archived_sessions, directly in them and in their dated directories.
// Where a rollout is made is read first: the dated directories of now and,
// for a time-ordered id (UUID version 7, which Codex makes), of the day the
// id names; with walk the others are read when those have no match.
func (r *Resolver) searchCodex(s *search, id string, now time.Time, walk bool) {
	suffix := "-" + id + ".jsonl"
	match := func(root, dir string) int {
		n := 0
		// archived_sessions keeps every archived rollout side by side.
		limit := maxEntries
		if dir == root {
			limit = maxArchived
		}
		for _, e := range readDir(dir, limit) {
			name := e.Name()
			if !strings.HasPrefix(name, "rollout-") {
				continue
			}
			switch {
			case strings.HasSuffix(name, suffix):
				if s.consider(root, path.Join(dir, name)) {
					n++
				}
			case strings.HasSuffix(name, suffix+".zst"):
				s.compressed = true
				n++
			}
		}
		return n
	}
	days := codexDays(now, now)
	if t, ok := uuidTime(id); ok {
		for _, d := range codexDays(t, t) {
			if !slices.Contains(days, d) {
				days = append(days, d)
			}
		}
	}
	for _, h := range r.codexHomes() {
		for _, sub := range []string{"sessions", "archived_sessions"} {
			root, ok := resolvedRoot(path.Join(h, sub))
			if !ok {
				continue
			}
			n := match(root, root)
			for _, d := range days {
				n += match(root, path.Join(root, d))
			}
			if n == 0 && walk {
				walkDated(root, func(dir string) { match(root, dir) })
			}
		}
	}
}

// uuidTime is when a UUID of version 7 was made (its first 48 bits, in
// milliseconds since the epoch).
func uuidTime(id string) (time.Time, bool) {
	if len(id) != 36 || id[14] != '7' {
		return time.Time{}, false
	}
	ms, err := strconv.ParseInt(id[0:8]+id[9:13], 16, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.UnixMilli(ms), true
}

// walkDated calls fn with each YYYY/MM/DD directory under root (names of
// digits only; symlinked directories are not followed), reading at most
// maxWalkDirs directories.
func walkDated(root string, fn func(dir string)) {
	n := 0
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		for _, e := range readDir(dir, maxEntries) {
			if n >= maxWalkDirs {
				return
			}
			if !e.IsDir() || !digits(e.Name()) {
				continue
			}
			n++
			sub := path.Join(dir, e.Name())
			if depth == 2 {
				fn(sub)
			} else {
				walk(sub, depth+1)
			}
		}
	}
	walk(root, 0)
}

func digits(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// claudeSubagents are the transcripts of a Claude Code session's subagents
// (<session>/subagents/*.jsonl beside its transcript), each a regular file
// of the user's own with one name inside the session root, in name order,
// at most maxSubagents, and the files found there.
func claudeSubagents(loc location) ([]string, []fileID) {
	dir := path.Join(strings.TrimSuffix(loc.file, ".jsonl"), "subagents")
	var names []string
	for _, e := range readDir(dir, maxEntries) {
		if strings.HasSuffix(e.Name(), ".jsonl") {
			names = append(names, e.Name())
		}
	}
	slices.Sort(names)
	var out []string
	var ids []fileID
	for _, n := range names {
		if len(out) >= maxSubagents {
			break
		}
		var s search
		if s.consider(loc.root, path.Join(dir, n)) {
			out = append(out, s.best.file)
			ids = append(ids, s.best.id)
		}
	}
	return out, ids
}
