//go:build unix

package sessions

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"slices"
	"strconv"
	"strings"
	"time"

	"herdr-ide/internal/agentkinds"
	"herdr-ide/internal/agentproto"
)

// claudeMaxName is the longest project directory name Claude Code makes
// from a directory as it is; a longer one is cut there and followed by a
// hash of the directory.
const claudeMaxName = 200

// resolveClaude tries the command line, then Claude Code's record of the
// program or of a descendant (which wins when it names another session than
// the command line: /clear starts a new one), then a guess.
func (r *Resolver) resolveClaude(ctx context.Context, kind string, p Proc) (Found, bool) {
	initial, fromArgv := claudeArgv(p.Argv)
	if p.PID <= 0 {
		if fromArgv {
			return Found{ID: initial, Source: agentproto.SessionFromArgv}, true
		}
		return Found{}, false
	}
	rec, cands, child := r.claudeRecord(ctx, p)
	if rec.id != "" {
		r.remember(p.PID, rec.file)
		if fromArgv && rec.id == initial {
			return Found{ID: initial, Source: agentproto.SessionFromArgv}, true
		}
		return Found{ID: rec.id, Source: agentproto.SessionFromPID}, true
	}
	r.remember(p.PID, "")
	if fromArgv {
		return Found{ID: initial, Source: agentproto.SessionFromArgv}, true
	}
	if child || ctx.Err() != nil {
		return Found{}, false
	}
	return r.claudeGuess(ctx, kind, p, cands)
}

// claudeArgv is the session Claude Code's command line names:
// --session-id <id> (or --session-id=<id>), else --resume <id> (-r <id>,
// --resume=<id>) unless --fork-session makes a new one. Only a session id
// (agentkinds.ValidSessionID) counts; the arguments after "--" are not
// options.
func claudeArgv(argv []string) (string, bool) {
	var sid, resumed string
	fork := false
	for i, a := range argv {
		if a == "--" {
			break
		}
		next := ""
		if i+1 < len(argv) {
			next = argv[i+1]
		}
		switch {
		case a == "--session-id":
			sid = next
		case strings.HasPrefix(a, "--session-id="):
			sid = strings.TrimPrefix(a, "--session-id=")
		case a == "--resume" || a == "-r":
			resumed = next
		case strings.HasPrefix(a, "--resume="):
			resumed = strings.TrimPrefix(a, "--resume=")
		case a == "--fork-session":
			fork = true
		}
	}
	if agentkinds.ValidSessionID(sid) {
		return sid, true
	}
	if !fork && agentkinds.ValidSessionID(resumed) {
		return resumed, true
	}
	return "", false
}

// claudeRec is a session a Claude Code record names, and the record.
type claudeRec struct{ id, file string }

// claudeRecord looks for Claude Code's record of the terminal's program and,
// when it has none, of its descendants (cands, returned for the guess).
// child is true when a candidate's environment says it is the child session
// of another Claude Code, which keeps neither a record nor a transcript.
func (r *Resolver) claudeRecord(ctx context.Context, p Proc) (rec claudeRec, cands []int, child bool) {
	try := func(pid int) bool {
		dirs, c := r.claudeDirsOf(pid, p.Cwd)
		child = child || c
		for _, d := range dirs {
			file := path.Join(d, "sessions", strconv.Itoa(pid)+".json")
			if id, ok := r.readRecord(file, pid); ok {
				rec = claudeRec{id: id, file: file}
				return true
			}
		}
		return false
	}
	if try(p.PID) {
		return rec, []int{p.PID}, child
	}
	cands = r.candidates(p.PID)
	for _, c := range cands[1:] {
		if ctx.Err() != nil {
			break
		}
		if try(c) {
			return rec, cands, child
		}
	}
	return claudeRec{}, cands, child
}

// claudeDirsOf are the configuration directories a process of Claude Code
// may keep its record in: its own $CLAUDE_CONFIG_DIR when its environment
// can be read (Linux), else the agent's user's (claudeDirs). A process's
// own directory counts only when it is trusted (trustedDir): none does
// otherwise, as no record there is believed. child is true when the
// environment has CLAUDE_CODE_CHILD_SESSION.
func (r *Resolver) claudeDirsOf(pid int, cwd string) (dirs []string, child bool) {
	if env, ok := r.environ(pid); ok {
		child = env["CLAUDE_CODE_CHILD_SESSION"] != ""
		if d := r.expand(env["CLAUDE_CONFIG_DIR"], cwd); d != "" {
			if r.trustedDir(d, r.claudeDirs()) {
				return []string{d}, child
			}
			return nil, child
		}
	}
	return r.claudeDirs(), child
}

// trustedDir reports whether a configuration directory a process's
// environment names ($CLAUDE_CONFIG_DIR, $CODEX_HOME) may hold the records
// and transcripts of the agent's user: one of the user's own that Locate
// searches too (own), or a directory owned by the user that no one else
// may write (private). One that does not exist (yet) holds nothing to
// read; it is judged again once it does.
func (r *Resolver) trustedDir(d string, own []string) bool {
	for _, own := range own {
		if samePath(own, d) {
			return true
		}
	}
	fi, err := os.Stat(d)
	if errors.Is(err, fs.ErrNotExist) {
		return true
	}
	if err != nil {
		return false
	}
	st, ok := statInfo(fi)
	return ok && st.uid == agentUID && st.private()
}

// readRecord reads Claude Code's record of process pid (<pid>.json; the
// <pid>.<hex>.key beside it is never read): the session it names, when the
// record is a file of the user's own in a directory no one else may write
// (readRecordFile), is of that pid, names a session id and, when the
// process's start time is known, has a numeric startedAt within
// recordSlack of it (a pid reused by another process has an old record,
// and a record without the time proves nothing).
func (r *Resolver) readRecord(file string, pid int) (string, bool) {
	b, err := readRecordFile(path.Dir(file), path.Base(file), maxRecord)
	if err != nil {
		return "", false
	}
	var rec struct {
		PID       int    `json:"pid"`
		SessionID string `json:"sessionId"`
		StartedAt any    `json:"startedAt"`
	}
	if json.Unmarshal(b, &rec) != nil || rec.PID != pid || !agentkinds.ValidSessionID(rec.SessionID) {
		return "", false
	}
	if st, ok := r.startOf(pid); ok {
		ms, num := rec.StartedAt.(float64)
		if !num || ms <= 0 || ms > maxRecordMillis || st.Sub(time.UnixMilli(int64(ms))).Abs() > recordSlack {
			return "", false
		}
	}
	return rec.SessionID, true
}

// claimed are the sessions the records of other running processes name: a
// guess never takes them (another Claude Code, maybe one outside the
// terminals, works in the same directory).
func (r *Resolver) claimed(ctx context.Context, dirs []string, cands []int) map[string]bool {
	out := map[string]bool{}
	n := 0
	for _, d := range dirs {
		sdir := path.Join(d, "sessions")
		for _, e := range readDir(sdir, maxEntries) {
			stem, ok := strings.CutSuffix(e.Name(), ".json")
			if !ok || !e.Type().IsRegular() {
				continue
			}
			pid, err := strconv.Atoi(stem)
			if err != nil || pid <= 0 || strconv.Itoa(pid) != stem || slices.Contains(cands, pid) {
				continue
			}
			if n >= maxClaims || ctx.Err() != nil {
				return out
			}
			n++
			if _, alive := r.startOf(pid); !alive {
				continue
			}
			if id, ok := r.readRecord(path.Join(sdir, e.Name()), pid); ok {
				out[id] = true
			}
		}
	}
	return out
}

// claudeGuess is the newest transcript of the program's directory written
// since the program started, which no other running process's record
// claims and whose first conversation line names the directory; only when
// no other terminal runs Claude Code there.
func (r *Resolver) claudeGuess(ctx context.Context, kind string, p Proc, cands []int) (Found, bool) {
	if p.Cwd == "" || r.peers(kind, p.Cwd) > 0 {
		return Found{}, false
	}
	start, ok := r.startOf(p.PID)
	if !ok {
		return Found{}, false
	}
	since := start.Add(-startSlack)
	own, _ := r.claudeDirsOf(p.PID, p.Cwd)
	dirs := uniq(append(own, r.claudeDirs()...)...)
	type cand struct {
		id, file string
		mod      time.Time
	}
	var cs []cand
	for _, d := range dirs {
		for _, dir := range claudeProjectDirs(path.Join(d, "projects"), p.Cwd) {
			for _, e := range readDir(dir, maxEntries) {
				id, ok := strings.CutSuffix(e.Name(), ".jsonl")
				if !ok || !agentkinds.ValidSessionID(id) || !e.Type().IsRegular() {
					continue
				}
				info, err := e.Info()
				if err != nil || info.ModTime().Before(since) {
					continue
				}
				cs = append(cs, cand{id: id, file: path.Join(dir, e.Name()), mod: info.ModTime()})
			}
		}
	}
	if len(cs) == 0 {
		return Found{}, false
	}
	claimed := r.claimed(ctx, dirs, cands)
	slices.SortFunc(cs, func(a, b cand) int { return b.mod.Compare(a.mod) })
	tried := 0
	for _, c := range cs {
		if claimed[c.id] {
			continue
		}
		if tried >= maxConfirm || ctx.Err() != nil {
			break
		}
		tried++
		if info, err := claudeInfo(c.file); err == nil && samePath(info.Cwd, p.Cwd) {
			return Found{ID: c.id, Source: agentproto.SessionFromGuess}, true
		}
	}
	return Found{}, false
}

// claudeEscape is the name Claude Code gives a directory's projects
// directory: every character but an ASCII letter or digit becomes "-", one
// per UTF-16 code unit as JavaScript counts them.
func claudeEscape(cwd string) string {
	var b strings.Builder
	for _, c := range cwd {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
			b.WriteRune(c)
		case c > 0xFFFF:
			b.WriteString("--")
		default:
			b.WriteByte('-')
		}
	}
	return b.String()
}

// claudeProjectDirs are the directories of projects that may hold cwd's
// transcripts: the escaped name, or for a long one every directory that
// starts with its first claudeMaxName characters and a "-" (the hash after
// it is not reproduced; the transcripts' own cwd tells them apart).
func claudeProjectDirs(projects, cwd string) []string {
	esc := claudeEscape(cwd)
	if len(esc) <= claudeMaxName {
		return []string{path.Join(projects, esc)}
	}
	prefix := esc[:claudeMaxName] + "-"
	var out []string
	for _, e := range readDir(projects, maxProjects) {
		if e.IsDir() && strings.HasPrefix(e.Name(), prefix) {
			out = append(out, path.Join(projects, e.Name()))
		}
	}
	slices.Sort(out)
	return out
}

// claudeInfo is claudeInfoOf the transcript file (openNoFollow).
func claudeInfo(file string) (Info, error) {
	f, err := openNoFollow(file)
	if err != nil {
		return Info{}, err
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		return Info{}, errNotRegular
	}
	return claudeInfoOf(f), nil
}

// claudeInfoOf reads the directory and time of a Claude Code transcript's
// first conversation line (user, assistant or system with a cwd), reading
// at most maxHeadLines lines and maxHead bytes; lines longer than the
// reader's buffer (attachments) are skipped unread.
func claudeInfoOf(f io.Reader) Info {
	br := bufio.NewReaderSize(f, 256<<10)
	read := 0
	for n := 0; n < maxHeadLines && read < maxHead; n++ {
		line, err := br.ReadSlice('\n')
		read += len(line)
		if err == bufio.ErrBufferFull {
			for err == bufio.ErrBufferFull && read < maxHead {
				line, err = br.ReadSlice('\n')
				read += len(line)
			}
			if err != nil {
				break
			}
			continue
		}
		if bytes.Contains(line, []byte(`"cwd"`)) {
			var v struct {
				Type      string `json:"type"`
				Cwd       string `json:"cwd"`
				Timestamp string `json:"timestamp"`
			}
			if json.Unmarshal(line, &v) == nil && v.Cwd != "" && (v.Type == "user" || v.Type == "assistant" || v.Type == "system") {
				info := Info{Cwd: v.Cwd}
				if t, err := time.Parse(time.RFC3339Nano, v.Timestamp); err == nil {
					info.Started = t
				}
				return info
			}
		}
		if err != nil {
			break
		}
	}
	return Info{}
}

// claudeStamp writes what Resolve reads for Claude Code to b: the records
// of the program (its own, the one that last named its session) and their
// directories (a record made or removed); while no session or only a guess
// is known, the projects directories of the program's directory too (a
// transcript made).
func (r *Resolver) claudeStamp(b *strings.Builder, p Proc, last Found) {
	dirs, _ := r.claudeDirsOf(p.PID, p.Cwd)
	if p.PID > 0 {
		for _, d := range dirs {
			stampFile(b, path.Join(d, "sessions"))
			stampFile(b, path.Join(d, "sessions", strconv.Itoa(p.PID)+".json"))
		}
		if rec := r.remembered(p.PID); rec != "" {
			stampFile(b, rec)
		}
	}
	if (last.ID == "" || last.Source == agentproto.SessionFromGuess) && p.Cwd != "" {
		for _, d := range uniq(append(dirs, r.claudeDirs()...)...) {
			projects := path.Join(d, "projects")
			stampFile(b, projects)
			for _, dir := range claudeProjectDirs(projects, p.Cwd) {
				stampFile(b, dir)
			}
		}
	}
}
