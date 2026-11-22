//go:build unix

// Package sessions finds, on the machine the agent runs on, the session a
// coding agent's process uses and the transcript file of a session.
//
// Resolve maps the foreground program of a terminal (its pid, command line
// and working directory, as the terminal core reports them) to the id of the
// agent's session, trying in order: the command line (claude --session-id
// and --resume, codex resume), Claude Code's record of its process
// (<claude dir>/sessions/<pid>.json), the rollout a Codex process holds open
// (Linux), the only Codex rollout of the directory made since the process
// started, and, as a guess, the newest transcript of the directory written
// since then. Stamp is a cheap fingerprint of what Resolve reads, so a caller
// polls with a few stats and resolves again only on a change (Claude Code's
// /clear rewrites its record with a new id).
//
// Locate maps a session id to its transcript file. The id is the only thing
// a browser names: it must be a lower-case UUID before it reaches a path,
// and the file found must be a regular file of the user's own with one name
// inside the kind's own session root once symlinks are resolved. OpenLocated
// (and File.Open, File.OpenSubagent) open such a file so that the claim
// still holds at open time: no symbolic link anywhere on its path is
// followed, and the descriptor is the very file Locate saw. A miss is
// remembered for a few seconds, so that asking for unknown ids again and
// again does not search the session roots each time.
// Only the agents with a transcript parser (agentkinds.Kind.Transcript
// "claude" or "codex") have sessions here.
package sessions

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"herdr-ide/internal/agentkinds"
)

// Proc is the foreground program of a terminal as the terminal core reports it.
type Proc struct {
	PID  int
	Argv []string
	Cwd  string
}

// Found is a session and how it was found (agentproto's source constants:
// SessionFromArgv, SessionFromPID, SessionFromFD, SessionFromStart,
// SessionFromGuess).
type Found struct{ ID, Source string }

// File is the transcript of a session: Path, absolute and resolved through
// symlinks, and for Claude Code the transcripts of its subagents
// (<session>/subagents/*.jsonl), each checked like Path. Open and
// OpenSubagent open them as the files Locate saw; a File made otherwise
// opens nothing.
type File struct {
	Path      string
	Subagents []string

	// id and subs are the files Locate saw at Path and at Subagents.
	id   fileID
	subs []fileID
}

// Open opens the session's transcript (Path) so that no symbolic link on
// its path is followed, as the file Locate saw there: ErrNotFound when it
// is not (any more).
func (f File) Open() (*os.File, error) { return openAs(f.Path, f.id) }

// OpenSubagent opens Subagents[i] the way Open opens Path: ErrNotFound
// when it is not the file Locate saw there (any more) or i is out of
// range.
func (f File) OpenSubagent(i int) (*os.File, error) {
	if i < 0 || i >= len(f.Subagents) || i >= len(f.subs) {
		return nil, ErrNotFound
	}
	return openAs(f.Subagents[i], f.subs[i])
}

// Info is what a transcript says of itself: the directory the session was
// started in and when; zero values when it does not say.
type Info struct {
	Cwd     string
	Started time.Time
}

var (
	// ErrBadID: the id is not a session id (agentkinds.ValidSessionID).
	ErrBadID = errors.New("sessions: not a session id")
	// ErrUnknownKind: the kind has no transcripts this package can find.
	ErrUnknownKind = errors.New("sessions: unknown kind")
	// ErrNotFound: no regular transcript file of the session lies inside
	// the kind's session roots.
	ErrNotFound = errors.New("sessions: transcript not found")
	// ErrCompressed: the session's transcript exists only compressed
	// (.jsonl.zst).
	ErrCompressed = errors.New("sessions: transcript is compressed")

	errNotRegular = errors.New("sessions: not a regular file")
	errTooLarge   = errors.New("sessions: file too large")
)

// The transcript formats with sessions (agentkinds.Kind.Transcript).
const (
	formatClaude = "claude"
	formatCodex  = "codex"
)

// Bounds of what one call reads.
const (
	// maxRecord bounds Claude Code's <pid>.json.
	maxRecord = 64 << 10
	// maxMetaLine bounds what is read of a Codex rollout's first line
	// (session_meta, tens of KiB with the model's instructions).
	maxMetaLine = 1 << 20
	// maxHead and maxHeadLines bound what is read of a Claude transcript
	// to find its first conversation line.
	maxHead      = 4 << 20
	maxHeadLines = 256
	// maxEntries bounds the entries read of one directory.
	maxEntries = 4096
	// maxProjects bounds the entries read of a Claude projects directory.
	maxProjects = 10000
	// maxArchived bounds the entries read of a Codex session root
	// (archived_sessions holds every archived rollout in one directory).
	maxArchived = 1 << 16
	// maxMetaReads bounds the rollouts whose first line one Resolve reads.
	maxMetaReads = 256
	// maxClaims bounds the other processes' records read for a guess.
	maxClaims = 256
	// maxConfirm bounds the transcripts a guess reads to confirm the
	// directory.
	maxConfirm = 8
	// maxSubagents bounds the subagent transcripts listed.
	maxSubagents = 256
	// maxWalkDirs bounds the directories a search of Codex's dated
	// directories reads.
	maxWalkDirs = 5000
	// maxRemembered bounds the caches a Resolver keeps.
	maxRemembered = 1024
	// maxMisses bounds the misses a Resolver remembers.
	maxMisses = 1024
)

const (
	// startSlack: a session made this long before its process started
	// (clock granularity, the time a launcher takes) still counts as made
	// after it.
	startSlack = 2 * time.Second
	// recordSlack: Claude Code's record of a process is believed when its
	// startedAt is this close to the process's start time (a pid reused by
	// another process is not).
	recordSlack = 60 * time.Second
	// maxRecordMillis bounds a record's startedAt (milliseconds since the
	// epoch; this is the year 33658): beyond, it is no time.
	maxRecordMillis = 1e15
	// missTTL is how long Locate remembers that a session has no
	// transcript: the search that reads every dated directory of Codex's
	// is not made again meanwhile.
	missTTL = 3 * time.Second
	// missRecheck is how long a remembered miss is answered without
	// looking at all; after it the places a new transcript appears in are
	// looked at again (Codex: the dated directories of now and of the id's
	// time; Claude Code, which has no others: every project directory).
	missRecheck = time.Second
)

// Resolver finds sessions on this machine. The zero value works for the
// user's home; a Resolver may be used by several goroutines.
type Resolver struct {
	// Home is the user's home directory; "" is os.UserHomeDir.
	Home string
	// Getenv reads the agent's environment; nil is os.Getenv.
	Getenv func(string) string
	// Peers says how many other terminals run the same kind in the same
	// directory (a guess is refused when there are any); nil means none.
	// Resolve calls it, so it must not wait for Resolve's caller.
	Peers func(kind, cwd string) int

	// procRoot is the /proc processes are read from; "" is /proc on Linux
	// and the system's process table elsewhere. Tests set a fake one,
	// which runs the Linux code on any system.
	procRoot string
	// table, started and now replace the process table, the processes'
	// start times and the clock (tests).
	table   func(pid int) ([]procEntry, error)
	started func(pid int) (time.Time, bool)
	now     func() time.Time

	mu sync.Mutex
	// records maps a terminal's pid to the Claude Code record that last
	// named its session (Stamp watches it).
	records map[int]string
	// metas are Codex rollouts' first lines, by path; a first line never
	// changes once written.
	metas map[string]rolloutMeta
	// located are Locate's answers, checked again on use.
	located map[string]location
	// misses are Locate's misses, by format and id (missTTL).
	misses map[string]miss
}

// format is the transcript format of a kind with sessions; "" for any other
// kind.
func format(kind string) string {
	k, ok := agentkinds.ByID(kind)
	if !ok {
		return ""
	}
	switch k.Transcript {
	case formatClaude, formatCodex:
		return k.Transcript
	}
	return ""
}

// Resolve finds the session of the agent of kind that p runs; false when
// none is known (yet: Codex writes no file before the first prompt, and a
// caller tries again when Stamp changes).
func (r *Resolver) Resolve(ctx context.Context, kind string, p Proc) (Found, bool) {
	switch format(kind) {
	case formatClaude:
		return r.resolveClaude(ctx, kind, p)
	case formatCodex:
		return r.resolveCodex(ctx, kind, p)
	}
	return Found{}, false
}

// Stamp returns something cheap that changes when Resolve's answer may have
// changed (the mtime and size of Claude Code's <pid>.json and of its
// sessions directory; for Codex the newest rollout's name in the dated
// directories Resolve reads, and its mtime when last is a guess), so a
// caller can poll with a few stats and call Resolve only on a change. It is
// "" for a kind without sessions.
func (r *Resolver) Stamp(kind string, p Proc, last Found) string {
	var b strings.Builder
	switch format(kind) {
	case formatClaude:
		r.claudeStamp(&b, p, last)
	case formatCodex:
		r.codexStamp(&b, p, last)
	default:
		return ""
	}
	h := fnv.New64a()
	io.WriteString(h, b.String())
	return fmt.Sprintf("%016x", h.Sum64())
}

// stampFile writes p's mtime and size, or that it is missing, to b.
func stampFile(b *strings.Builder, p string) {
	if st, err := os.Stat(p); err == nil {
		fmt.Fprintf(b, "%s\x00%d\x00%d\n", p, st.ModTime().UnixNano(), st.Size())
	} else {
		fmt.Fprintf(b, "%s\x00-\n", p)
	}
}

// Open opens a transcript file at p, an absolute path resolved through
// symlinks (File.Path), as a regular file of the user's own with one name,
// so that no symbolic link anywhere on p is followed (a directory swapped
// for a link after Locate looked at it does not redirect the open), and
// without blocking (a FIFO or device put at the name fails instead). Paths
// with a link on them, FIFOs, devices, directories and hard links fail.
// File.Open checks also that the file is the one Locate saw.
func Open(p string) (*os.File, error) {
	f, _, err := openStrict(p)
	return f, err
}

// readSmall reads a regular file of at most max bytes (openNoFollow).
func readSmall(p string, max int64) ([]byte, error) {
	f, err := openNoFollow(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		return nil, errNotRegular
	}
	return readMax(f, max)
}

// readMax reads all of f, at most max bytes (errTooLarge beyond).
func readMax(f *os.File, max int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, errTooLarge
	}
	return b, nil
}

// readDir reads at most max entries of a directory, in no particular order.
// It opens with O_DIRECTORY and O_NONBLOCK, so a FIFO at the name fails
// instead of blocking.
func readDir(dir string, max int) []os.DirEntry {
	traceOpen(dir)
	f, err := os.OpenFile(dir, os.O_RDONLY|unix.O_DIRECTORY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil
	}
	defer f.Close()
	ents, _ := f.ReadDir(max)
	return ents
}

func (r *Resolver) getenv(k string) string {
	if r.Getenv != nil {
		return r.Getenv(k)
	}
	return os.Getenv(k)
}

// home is the user's home directory, "" when it is not an absolute path
// (no path is then made from it).
func (r *Resolver) home() string {
	h := r.Home
	if h == "" {
		h, _ = os.UserHomeDir()
	}
	if !path.IsAbs(h) {
		return ""
	}
	return path.Clean(h)
}

// expand resolves ~ against the home directory and a relative path against
// base; "" when the result would not be absolute.
func (r *Resolver) expand(p, base string) string {
	if p == "" {
		return ""
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		h := r.home()
		if h == "" {
			return ""
		}
		return path.Join(h, strings.TrimPrefix(p[1:], "/"))
	}
	if path.IsAbs(p) {
		return path.Clean(p)
	}
	if path.IsAbs(base) {
		return path.Join(base, p)
	}
	return ""
}

// under is home/rel, "" without a home.
func under(home, rel string) string {
	if home == "" {
		return ""
	}
	return path.Join(home, rel)
}

// uniq is the non-empty strings of s, without duplicates, in order.
func uniq(s ...string) []string {
	var out []string
	for _, x := range s {
		if x == "" {
			continue
		}
		dup := false
		for _, y := range out {
			if y == x {
				dup = true
				break
			}
		}
		if !dup {
			out = append(out, x)
		}
	}
	return out
}

// claudeDirs are the agent's user's Claude Code configuration directories:
// $CLAUDE_CONFIG_DIR, ~/.claude and ~/.config/claude.
func (r *Resolver) claudeDirs() []string {
	h := r.home()
	return uniq(r.expand(r.getenv("CLAUDE_CONFIG_DIR"), h), under(h, ".claude"), under(h, ".config/claude"))
}

// codexHomes are the agent's user's Codex homes: $CODEX_HOME and ~/.codex.
func (r *Resolver) codexHomes() []string {
	h := r.home()
	return uniq(r.expand(r.getenv("CODEX_HOME"), h), under(h, ".codex"))
}

func (r *Resolver) peers(kind, cwd string) int {
	if r.Peers == nil {
		return 0
	}
	return r.Peers(kind, cwd)
}

func (r *Resolver) clock() time.Time {
	if r.now != nil {
		return r.now()
	}
	return time.Now()
}

// samePath says whether two directories are the same path once cleaned.
func samePath(a, b string) bool {
	return a != "" && b != "" && path.Clean(a) == path.Clean(b)
}

// remember keeps the Claude Code record that named the session of the
// terminal's program pid ("" forgets it).
func (r *Resolver) remember(pid int, record string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if record == "" {
		delete(r.records, pid)
		return
	}
	if r.records == nil || len(r.records) >= maxRemembered {
		r.records = map[int]string{}
	}
	r.records[pid] = record
}

func (r *Resolver) remembered(pid int) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.records[pid]
}
