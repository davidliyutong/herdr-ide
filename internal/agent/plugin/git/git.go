//go:build unix

// Package git is the machine side of the Git plugin (internal/plugins/git,
// docs/features/31-git.md): the state of a repository (its branch, status,
// history, refs, the contents of files at a revision) and the changes the
// panel and the graph make (staging, commits, branches, merges, stashes,
// fetch, pull and push).
//
// Every action runs the git executable with an argument vector built here:
// no shell, no option or flag from the request. Paths are relative to the
// repository's top level, come after "--" and are literal pathspecs (each
// with the ":(literal)" magic, so hooks do not inherit a literal setting);
// revisions and ref names never start with "-" and are checked before use. git never asks for credentials or an editor
// (no terminal, GIT_TERMINAL_PROMPT=0, no askpass programs, GIT_EDITOR
// true); a fetch, pull or push that would need a password fails with
// auth_required. Each run has a timeout (reads 15 s, network and
// committing 120 s) after which its process group is killed, and its
// output is bounded; at most MaxRuns run at once. Reads run no file system
// monitor and start no maintenance.
package git

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"herdr-ide/internal/agent/plugin"
)

const (
	// ReadTimeout bounds a read; NetTimeout a fetch, pull, push, commit
	// (hooks run) and the other changes.
	ReadTimeout = 15 * time.Second
	NetTimeout  = 120 * time.Second
	// MaxOutput bounds what a run of git may print.
	MaxOutput = 32 << 20
	// MaxBlob bounds a file's contents the diff pane gets.
	MaxBlob = 8 << 20
	// MaxPatch bounds a patch or a commit message.
	MaxPatch = 4 << 20
	// PageSize is the default number of commits of a page of the log;
	// MaxPage the largest.
	PageSize = 300
	MaxPage  = 1000
	// maxStatus bounds the entries of a status; maxIgnored the paths git
	// ignores it lists besides them; maxPaths the paths of one change (as
	// many as a status lists).
	maxStatus  = 20000
	maxIgnored = maxStatus
	maxPaths   = maxStatus
	// maxArgBytes bounds the paths of one run of git: a change with more
	// runs git several times (the system limits a command line's length).
	maxArgBytes = 96 << 10
)

func init() { plugin.Register("git", handle) }

// Params are the parameters of every action; each reads its own fields.
type Params struct {
	// Repo is the repository's top level (from the action repo); Path a
	// directory for repo, a file of the repository (relative to the top
	// level) for blob.
	Repo  string   `json:"repo,omitempty"`
	Path  string   `json:"path,omitempty"`
	Paths []string `json:"paths,omitempty"`
	// Untracked are paths a discard removes.
	Untracked []string `json:"untracked,omitempty"`
	// Tracked: a stage of all changes leaves untracked files out.
	Tracked bool `json:"tracked,omitempty"`
	// Rev is a commit or ref; Rev2 the other side of a compare. Parent
	// is the parent (1-based) a commit is shown against or a merge is
	// cherry-picked or reverted against.
	Rev    string `json:"rev,omitempty"`
	Rev2   string `json:"rev2,omitempty"`
	Parent int    `json:"parent,omitempty"`
	// Source of a blob: "worktree", "index", "head" or a revision.
	Source string `json:"source,omitempty"`
	// Log: the page, the branches (all when empty) and whether remote
	// branches are included.
	Skip     int      `json:"skip,omitempty"`
	Limit    int      `json:"limit,omitempty"`
	Branches []string `json:"branches,omitempty"`
	Remotes  bool     `json:"remotes,omitempty"`
	// applyPatch
	Patch   string `json:"patch,omitempty"`
	Cached  bool   `json:"cached,omitempty"`
	Reverse bool   `json:"reverse,omitempty"`
	// commit, tagCreate, stashPush
	Message string `json:"message,omitempty"`
	Amend   bool   `json:"amend,omitempty"`
	Signoff bool   `json:"signoff,omitempty"`
	// Branches and tags: Name, its new name To, the commit At.
	Name     string `json:"name,omitempty"`
	To       string `json:"to,omitempty"`
	At       string `json:"at,omitempty"`
	Checkout bool   `json:"checkout,omitempty"`
	Force    bool   `json:"force,omitempty"`
	// merge, rebase, abort, continue, reset
	Ref  string `json:"ref,omitempty"`
	NoFF bool   `json:"noFF,omitempty"`
	Onto string `json:"onto,omitempty"`
	// Op is the operation in progress an abort or continue acts on:
	// merge, rebase, cherryPick or revert.
	Op   string `json:"op,omitempty"`
	Mode string `json:"mode,omitempty"`
	// Stashes: the entry's index and its commit, which stash@{Index} must
	// still name.
	Index            int    `json:"index,omitempty"`
	Hash             string `json:"hash,omitempty"`
	IncludeUntracked bool   `json:"includeUntracked,omitempty"`
	// fetch, pull, push
	Remote         string `json:"remote,omitempty"`
	Branch         string `json:"branch,omitempty"`
	Tag            string `json:"tag,omitempty"`
	Prune          bool   `json:"prune,omitempty"`
	Rebase         bool   `json:"rebase,omitempty"`
	SetUpstream    bool   `json:"setUpstream,omitempty"`
	ForceWithLease bool   `json:"forceWithLease,omitempty"`
	All            bool   `json:"all,omitempty"`
}

// Reads are the actions that change nothing; the others are changes.
var Reads = map[string]bool{
	"repo": true, "status": true, "log": true, "show": true, "blob": true,
	"branches": true, "tags": true, "stashes": true, "diffStat": true, "watch": true,
}

// Writes are the changes.
var Writes = map[string]bool{
	"stage": true, "unstage": true, "applyPatch": true, "discard": true, "commit": true,
	"checkout": true, "branchCreate": true, "branchDelete": true, "branchRename": true,
	"merge": true, "rebase": true, "abort": true, "continue": true, "cherryPick": true,
	"revert": true, "reset": true, "tagCreate": true, "tagDelete": true,
	"stashPush": true, "stashApply": true, "stashPop": true, "stashDrop": true,
	"fetch": true, "pull": true, "push": true,
}

func handle(ctx context.Context, st net.Conn, action string, raw json.RawMessage, env *plugin.Env) error {
	// The request ends when the core closes the stream: git's process
	// group is killed with it.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		var b [1]byte
		st.Read(b[:])
		cancel()
	}()
	var p Params
	if err := plugin.Decode(raw, &p); err != nil {
		return plugin.Reply(st, nil, err)
	}
	v, err := dispatch(ctx, action, p, env)
	return plugin.Reply(st, v, err)
}

func dispatch(ctx context.Context, action string, p Params, env *plugin.Env) (any, error) {
	if !Reads[action] && !Writes[action] {
		return nil, plugin.Errorf("bad_params", "unknown action %q", action)
	}
	if action == "repo" {
		return repoInfo(ctx, env, p.Path)
	}
	r, err := open(env, p.Repo, Reads[action])
	if err != nil {
		return nil, err
	}
	switch action {
	case "status":
		return r.status(ctx)
	case "log":
		return r.log(ctx, p)
	case "show":
		return r.show(ctx, p)
	case "blob":
		return r.blob(ctx, p)
	case "branches":
		return r.branches(ctx)
	case "tags":
		return r.tags(ctx)
	case "stashes":
		return r.stashes(ctx)
	case "diffStat":
		return r.diffStat(ctx)
	case "watch":
		return r.watch()
	}
	return r.change(ctx, action, p)
}

// repo is a repository the actions run in.
type repo struct {
	env  *plugin.Env
	root string
	read bool
}

// open checks that dir is a repository's top level (not every directory
// of one: the actions' paths are relative to it).
func open(env *plugin.Env, dir string, read bool) (*repo, error) {
	if dir == "" || strings.ContainsRune(dir, 0) {
		return nil, plugin.Errorf("bad_params", "no repository")
	}
	abs, err := env.Expand(dir)
	if err != nil {
		return nil, plugin.Errorf("bad_params", "%v", err)
	}
	abs = filepath.Clean(abs)
	if fi, err := os.Stat(filepath.Join(abs, ".git")); err != nil || (!fi.IsDir() && !fi.Mode().IsRegular()) {
		return nil, plugin.Errorf("not_a_repo", "%s is not the top level of a repository", abs)
	}
	return &repo{env: env, root: abs, read: read}, nil
}

// lookGit finds the git executable; it is a variable for tests.
var lookGit = func() (string, error) { return exec.LookPath("git") }

// kept are the variables of git's own (GIT_*) a run of git keeps from the
// agent's environment: how ssh is run and who authors and commits. Every
// other GIT_* variable is dropped (GIT_DIR, GIT_CONFIG_*, GIT_ATTR_SOURCE,
// GIT_EXEC_PATH, GIT_TRACE*…: they would point git at another repository,
// configuration or program, or write files elsewhere), and so are the
// askpass programs and the locale; the run sets its own below.
var kept = map[string]bool{"GIT_SSH": true, "GIT_SSH_COMMAND": true, "GIT_SSH_VARIANT": true}

// keptPrefixes are the kept families: GIT_AUTHOR_NAME, _EMAIL, _DATE and
// the committer's.
var keptPrefixes = []string{"GIT_AUTHOR_", "GIT_COMMITTER_"}

// dropped are other variables a run of git does not get.
var dropped = map[string]bool{"SSH_ASKPASS": true, "LC_ALL": true, "LANG": true, "LANGUAGE": true}

// keepVar reports whether the variable k of the agent's environment is
// passed to git.
func keepVar(k string) bool {
	if dropped[k] {
		return false
	}
	if !strings.HasPrefix(k, "GIT_") || kept[k] {
		return true
	}
	for _, p := range keptPrefixes {
		if strings.HasPrefix(k, p) {
			return true
		}
	}
	return false
}

// environ is the environment of a run of git.
func environ(env *plugin.Env, read bool) []string {
	var base []string
	if env.Environ != nil {
		base = env.Environ()
	} else {
		base = os.Environ()
	}
	out := make([]string, 0, len(base)+12)
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		if keepVar(k) {
			out = append(out, kv)
		}
	}
	out = append(out,
		"LC_ALL=C",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_PAGER=cat",
		"GIT_EDITOR=true",
		"GIT_SEQUENCE_EDITOR=true",
		"GIT_MERGE_AUTOEDIT=no",
		// ssh has no terminal to ask on (setsid) and no askpass program.
		"SSH_ASKPASS_REQUIRE=never",
	)
	if read {
		out = append(out, "GIT_OPTIONAL_LOCKS=0")
	}
	return out
}

// run is one run of git.
type run struct {
	args    []string
	stdin   []byte
	timeout time.Duration
	// limit bounds the output; over it the run fails with too_large, or
	// with keep git is killed and what it printed so far is the result
	// (cut).
	limit int
	keep  bool
	// ok are exit codes that are not failures (diff's 1).
	ok []int
}

// result is what a run printed; cut: the output stopped at the run's
// limit (a run with keep).
type result struct {
	out, err []byte
	code     int
	cut      bool
}

// git runs git in the repository.
func (r *repo) git(ctx context.Context, rn run) (result, error) {
	return execGit(ctx, r.env, r.root, r.read, rn)
}

// MaxRuns bounds the runs of git at once on a machine; a run that finds
// no free slot within slotWait fails with busy.
const MaxRuns = 8

var (
	slots    = make(chan struct{}, MaxRuns)
	slotWait = 3 * time.Second
	// waitDelay is how long a run waits, after git exited, for its output
	// to close: a program a hook left in the background may hold it.
	waitDelay = 2 * time.Second
)

// Options of every run: no colors, pager or signatures; no maintenance
// detached into the background (an automatic gc a change starts runs in
// the run's process group, under its timeout).
var baseConfig = []string{
	"-c", "core.quotePath=false", "-c", "color.ui=false", "-c", "log.showSignature=false",
	"-c", "gc.autoDetach=false", "-c", "maintenance.autoDetach=false",
}

// readConfig are the options of reads: a read runs no file system monitor
// (a hook or daemon from the repository's configuration), uses no
// untracked cache and starts no maintenance.
var readConfig = []string{
	"-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
	"-c", "maintenance.auto=false", "-c", "gc.auto=0",
}

func execGit(ctx context.Context, env *plugin.Env, dir string, read bool, rn run) (result, error) {
	bin, err := lookGit()
	if err != nil {
		return result{}, plugin.Errorf("git_missing", "git is not installed: %v", err)
	}
	if rn.timeout == 0 {
		rn.timeout = ReadTimeout
	}
	if rn.limit == 0 {
		rn.limit = MaxOutput
	}
	ctx, cancel := context.WithTimeout(ctx, rn.timeout)
	defer cancel()
	wait := time.NewTimer(slotWait)
	select {
	case slots <- struct{}{}:
		wait.Stop()
	case <-wait.C:
		return result{}, plugin.Errorf("busy", "%d runs of git are in progress", MaxRuns)
	case <-ctx.Done():
		wait.Stop()
		return result{}, plugin.Errorf("cancelled", "git %s: %v", rn.args[0], ctx.Err())
	}
	defer func() { <-slots }()
	args := append([]string{"-C", dir}, baseConfig...)
	if read {
		args = append(args, readConfig...)
	}
	args = append(append(args, "--no-pager"), rn.args...)
	cmd := exec.Command(bin, args...)
	cmd.Env = environ(env, read)
	cmd.Dir = dir
	// A session of its own: no controlling terminal (nothing can prompt)
	// and a process group to kill.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	// git has exited when a program it left behind holds its output: Wait
	// closes the pipes after waitDelay. Those programs (a hook's
	// background jobs) are the user's and keep running.
	cmd.WaitDelay = waitDelay
	if rn.stdin != nil {
		cmd.Stdin = bytes.NewReader(rn.stdin)
	}
	out := newCapped(rn.limit)
	errb := newCapped(64 << 10)
	errb.drop = true
	cmd.Stdout, cmd.Stderr = out, errb
	if err := cmd.Start(); err != nil {
		return result{}, startError(bin, dir, err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var werr error
	select {
	case werr = <-done:
	case <-ctx.Done():
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return result{}, plugin.Errorf("timeout", "git %s took longer than %s", rn.args[0], rn.timeout)
		}
		return result{}, plugin.Errorf("cancelled", "git %s: %v", rn.args[0], ctx.Err())
	case <-out.over:
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		if rn.keep {
			return result{out: out.buf.Bytes(), cut: true}, nil
		}
		return result{}, plugin.Errorf("too_large", "git %s printed more than %d bytes", rn.args[0], rn.limit)
	}
	if errors.Is(werr, exec.ErrWaitDelay) {
		// git succeeded; what kept its output open is not git.
		werr = nil
	}
	res := result{out: out.buf.Bytes(), err: errb.buf.Bytes()}
	if werr != nil {
		var ee *exec.ExitError
		if !errors.As(werr, &ee) {
			return res, plugin.Errorf("failed", "git %s: %v", rn.args[0], werr)
		}
		res.code = ee.ExitCode()
		for _, c := range rn.ok {
			if c == res.code {
				return res, nil
			}
		}
		return res, classify(rn.args[0], res)
	}
	return res, nil
}

// startError is the failure of a run that did not start: git_missing when
// the executable is gone, not_found when the directory is, failed
// otherwise (an argument list over the system's limit, no memory).
func startError(bin, dir string, err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		if _, serr := os.Stat(bin); serr != nil {
			return plugin.Errorf("git_missing", "%v", err)
		}
		if _, serr := os.Stat(dir); serr != nil {
			return plugin.Errorf("not_found", "%s: %v", dir, serr)
		}
	}
	return plugin.Errorf("failed", "git did not start: %v", err)
}

// capped is a buffer that stops at limit and says so on over.
type capped struct {
	buf   bytes.Buffer
	limit int
	over  chan struct{}
	// drop keeps the first limit bytes and drops the rest (the errors).
	drop bool
}

func newCapped(limit int) *capped { return &capped{limit: limit, over: make(chan struct{})} }

func (c *capped) Write(p []byte) (int, error) {
	if c.buf.Len()+len(p) > c.limit {
		if c.drop {
			c.buf.Write(p[:max(0, c.limit-c.buf.Len())])
			return len(p), nil
		}
		select {
		case <-c.over:
		default:
			close(c.over)
		}
		return 0, io.ErrShortWrite
	}
	return c.buf.Write(p)
}

// diverged is git's refusal to pull into a branch that diverged from its
// upstream when no pull.rebase or pull.ff says how.
var diverged = regexp.MustCompile(`(?i)reconcile divergent branches`)

var authFailure = regexp.MustCompile(`(?i)terminal prompts disabled|could not read (username|password)|authentication failed|permission denied \(publickey|host key verification failed|askpass|invalid username or password|access denied|HTTP Basic: Access denied`)

// classify gives a failed run of git its code: not_a_repo, auth_required,
// conflicts, diverged, or git_failed with what git said.
func classify(sub string, res result) error {
	msg := strings.TrimSpace(string(res.err))
	if msg == "" {
		msg = strings.TrimSpace(string(res.out))
	}
	if len(msg) > 4000 {
		msg = msg[:4000] + "…"
	}
	switch {
	case strings.Contains(msg, "not a git repository"):
		return &plugin.Error{Code: "not_a_repo", Err: errors.New(msg)}
	case authFailure.MatchString(msg):
		return &plugin.Error{Code: "auth_required", Err: errors.New(msg)}
	case bytes.Contains(res.out, []byte("CONFLICT")) || strings.Contains(msg, "CONFLICT") || strings.Contains(msg, "could not apply"):
		return &plugin.Error{Code: "conflicts", Err: errors.New(strings.TrimSpace(string(res.out) + "\n" + msg))}
	case diverged.MatchString(msg):
		return &plugin.Error{Code: "diverged", Err: errors.New(msg)}
	}
	return &plugin.Error{Code: "git_failed", Err: fmt.Errorf("git %s: %s", sub, msg)}
}

// ---- validation ----

var hexRev = regexp.MustCompile(`^[0-9a-fA-F]{4,64}$`)

// fullHash is an object's whole name (SHA-1 or SHA-256).
var fullHash = regexp.MustCompile(`^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$`)

// badRefChars are characters no ref name or revision the UI sends has.
const badRefChars = " \t\n\r\x00\x7f~^:?*[\\"

// plainName checks the shape of a ref name or revision: not empty, no
// leading "-", no characters git gives a meaning, no "..", "@{" or "//".
func plainName(s string) error {
	switch {
	case s == "", len(s) > 255:
		return plugin.Errorf("bad_ref", "bad name %q", s)
	case strings.HasPrefix(s, "-"):
		return plugin.Errorf("bad_ref", "%q starts with -", s)
	case strings.ContainsAny(s, badRefChars), strings.Contains(s, ".."), strings.Contains(s, "@{"), strings.Contains(s, "//"):
		return plugin.Errorf("bad_ref", "bad name %q", s)
	case strings.HasPrefix(s, "/"), strings.HasSuffix(s, "/"), strings.HasSuffix(s, "."), strings.HasSuffix(s, ".lock"):
		return plugin.Errorf("bad_ref", "bad name %q", s)
	}
	for _, c := range s {
		if c < 0x20 {
			return plugin.Errorf("bad_ref", "bad name %q", s)
		}
	}
	return nil
}

// rev checks a revision: a commit's hash, or a name git resolves to a
// commit (a branch, a remote branch, a tag, HEAD). It returns the name as
// given.
func (r *repo) rev(ctx context.Context, s string) (string, error) {
	if err := plainName(s); err != nil {
		return "", err
	}
	if hexRev.MatchString(s) {
		return s, nil
	}
	if _, err := r.git(ctx, run{args: []string{"rev-parse", "--verify", "--quiet", s + "^{commit}"}}); err != nil {
		return "", plugin.Errorf("bad_ref", "%q is not a commit", s)
	}
	return s, nil
}

// refExists checks that full (refs/heads/<name>, refs/tags/<name>) exists.
func (r *repo) refExists(ctx context.Context, full string) error {
	if _, err := r.git(ctx, run{args: []string{"show-ref", "--verify", "--quiet", full}}); err != nil {
		return plugin.Errorf("not_found", "no %s", full)
	}
	return nil
}

// newName checks the name of a new branch or tag (kind "heads" or
// "tags") with git's rules.
func (r *repo) newName(ctx context.Context, kind, name string) error {
	if err := plainName(name); err != nil {
		return err
	}
	if _, err := r.git(ctx, run{args: []string{"check-ref-format", "--allow-onelevel", "refs/" + kind + "/" + name}}); err != nil {
		return plugin.Errorf("bad_ref", "%q is not a valid name", name)
	}
	return nil
}

var remoteName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._/-]*$`)

// remote checks that name is one of the repository's remotes.
func (r *repo) remote(ctx context.Context, name string) error {
	if !remoteName.MatchString(name) || strings.Contains(name, "..") {
		return plugin.Errorf("bad_ref", "bad remote %q", name)
	}
	res, err := r.git(ctx, run{args: []string{"remote"}})
	if err != nil {
		return err
	}
	for _, l := range strings.Split(string(res.out), "\n") {
		if strings.TrimSpace(l) == name {
			return nil
		}
	}
	return plugin.Errorf("not_found", "no remote %q", name)
}

// cleanPath checks a path relative to the top level: not empty, not
// absolute, no "." or ".." elements, no NUL. A trailing "/" (a directory,
// as the status lists an untracked repository inside this one) is kept.
func cleanPath(p string) (string, error) {
	rel, dir := strings.CutSuffix(p, "/")
	if rel == "" || strings.ContainsRune(rel, 0) || strings.HasPrefix(rel, "/") {
		return "", plugin.Errorf("bad_params", "bad path %q", p)
	}
	for _, el := range strings.Split(rel, "/") {
		if el == "" || el == "." || el == ".." {
			return "", plugin.Errorf("bad_params", "bad path %q", p)
		}
	}
	rel = path.Clean(rel)
	if dir {
		rel += "/"
	}
	return rel, nil
}

// literal is a path as a pathspec that matches it only: no wildcards, no
// other magic.
func literal(p string) string { return ":(literal)" + p }

// pathRuns are runs of git with args, "--" and paths as literal
// pathspecs, as many paths per run as fit maxArgBytes.
func pathRuns(args []string, paths []string) []run {
	var runs []run
	var cur []string
	size := 0
	flush := func() {
		a := append(append(append([]string{}, args...), "--"), cur...)
		runs = append(runs, run{args: a})
		cur, size = nil, 0
	}
	for _, p := range paths {
		lp := literal(p)
		if len(cur) > 0 && size+len(lp)+1 > maxArgBytes {
			flush()
		}
		cur = append(cur, lp)
		size += len(lp) + 1
	}
	if len(cur) > 0 {
		flush()
	}
	return runs
}

func cleanPaths(ps []string) ([]string, error) {
	if len(ps) > maxPaths {
		return nil, plugin.Errorf("bad_params", "at most %d paths", maxPaths)
	}
	out := make([]string, 0, len(ps))
	for _, p := range ps {
		c, err := cleanPath(p)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, nil
}
