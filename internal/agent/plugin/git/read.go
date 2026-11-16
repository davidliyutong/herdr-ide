//go:build unix

package git

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf8"

	"herdr-ide/internal/agent/plugin"
)

// Repo is a repository as the panel shows it.
type Repo struct {
	// Root is the top level; GitDir and CommonDir its git directories
	// (they differ in a linked worktree).
	Root      string `json:"root"`
	GitDir    string `json:"gitDir"`
	CommonDir string `json:"commonDir"`
	// Branch is HEAD's branch ("" when detached), Head its commit (""
	// before the first commit).
	Branch   string `json:"branch,omitempty"`
	Head     string `json:"head,omitempty"`
	Detached bool   `json:"detached,omitempty"`
	Upstream string `json:"upstream,omitempty"`
	Ahead    int    `json:"ahead"`
	Behind   int    `json:"behind"`
	// State is an operation in progress: merge, rebase, cherryPick or
	// revert.
	State   string   `json:"state,omitempty"`
	Remotes []string `json:"remotes"`
	// RemoteURLs are the remotes' fetch URLs without what could be a
	// credential (a URL's user and password).
	RemoteURLs map[string]string `json:"remoteUrls,omitempty"`
	// Parents are the top levels of the repositories this one is nested
	// in, innermost first.
	Parents []string `json:"parents,omitempty"`
}

// repoInfo answers the repository dir is in.
func repoInfo(ctx context.Context, env *plugin.Env, dir string) (*Repo, error) {
	if dir == "" || strings.ContainsRune(dir, 0) {
		return nil, plugin.Errorf("bad_params", "no directory")
	}
	abs, err := env.Expand(dir)
	if err != nil {
		return nil, plugin.Errorf("bad_params", "%v", err)
	}
	if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
		return nil, plugin.Errorf("not_found", "%s is not a directory", abs)
	}
	root, err := toplevel(ctx, env, abs)
	if err != nil {
		return nil, err
	}
	if root == "" {
		return nil, plugin.Errorf("not_a_repo", "%s is not in a repository", abs)
	}
	r := &repo{env: env, root: root, read: true}
	info, err := r.info(ctx)
	if err != nil {
		return nil, err
	}
	for up, i := filepath.Dir(root), 0; up != root && i < 8; i++ {
		outer, err := toplevel(ctx, env, up)
		if err != nil || outer == "" {
			break
		}
		info.Parents = append(info.Parents, outer)
		root, up = outer, filepath.Dir(outer)
	}
	return info, nil
}

// toplevel is the top level of the repository dir is in, "" when none, as
// dir spells it: git answers the physical path, the explorer and editors
// show the path through a link to a directory (logical).
func toplevel(ctx context.Context, env *plugin.Env, dir string) (string, error) {
	res, err := execGit(ctx, env, dir, true, run{args: []string{"rev-parse", "--show-toplevel", "--show-prefix"}, ok: []int{128}})
	if err != nil {
		return "", err
	}
	if res.code != 0 {
		return "", nil
	}
	lines := strings.Split(string(res.out), "\n")
	prefix := ""
	if len(lines) > 1 {
		prefix = lines[1]
	}
	return logical(dir, lines[0], prefix), nil
}

// logical is the top level top as dir spells it: dir without prefix (its
// path below the top level, as git gave it) when that is the same
// directory as top; else top.
func logical(dir, top, prefix string) string {
	cand := filepath.Clean(dir)
	if prefix = strings.TrimSuffix(prefix, "/"); prefix != "" {
		below := string(filepath.Separator) + filepath.FromSlash(prefix)
		if !strings.HasSuffix(cand, below) {
			return top
		}
		if cand = strings.TrimSuffix(cand, below); cand == "" {
			cand = string(filepath.Separator)
		}
	}
	if cand == top {
		return top
	}
	a, err := filepath.EvalSymlinks(cand)
	if err != nil {
		return top
	}
	b, err := filepath.EvalSymlinks(top)
	if err != nil || a != b {
		return top
	}
	return cand
}

func (r *repo) info(ctx context.Context) (*Repo, error) {
	info := &Repo{Root: r.root, Remotes: []string{}}
	res, err := r.git(ctx, run{args: []string{"rev-parse", "--absolute-git-dir", "--git-common-dir"}})
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(string(res.out)), "\n")
	if len(lines) >= 2 {
		info.GitDir = lines[0]
		info.CommonDir = lines[1]
		if !filepath.IsAbs(info.CommonDir) {
			info.CommonDir = filepath.Join(r.root, info.CommonDir)
		}
	}
	if res, err := r.git(ctx, run{args: []string{"symbolic-ref", "-q", "HEAD"}, ok: []int{1}}); err == nil && res.code == 0 {
		info.Branch = strings.TrimPrefix(strings.TrimSpace(string(res.out)), "refs/heads/")
	} else {
		info.Detached = true
	}
	if res, err := r.git(ctx, run{args: []string{"rev-parse", "-q", "--verify", "HEAD"}, ok: []int{1, 128}}); err == nil && res.code == 0 {
		info.Head = strings.TrimSpace(string(res.out))
	}
	if info.Branch != "" && info.Head != "" {
		if res, err := r.git(ctx, run{args: []string{"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"}, ok: []int{128}}); err == nil && res.code == 0 {
			info.Upstream = strings.TrimSpace(string(res.out))
		}
	}
	if info.Upstream != "" {
		if res, err := r.git(ctx, run{args: []string{"rev-list", "--left-right", "--count", "HEAD...@{upstream}"}, ok: []int{128}}); err == nil && res.code == 0 {
			fmt.Sscanf(string(res.out), "%d %d", &info.Ahead, &info.Behind)
		}
	}
	info.State = progress(info.GitDir)
	if res, err := r.git(ctx, run{args: []string{"remote"}}); err == nil {
		for _, l := range strings.Split(string(res.out), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				info.Remotes = append(info.Remotes, l)
			}
		}
	}
	if len(info.Remotes) > 0 {
		if res, err := r.git(ctx, run{args: []string{"remote", "-v"}}); err == nil {
			info.RemoteURLs = remoteURLs(string(res.out))
		}
	}
	return info, nil
}

// remoteURLs reads `git remote -v`: each remote's fetch URL, redacted.
func remoteURLs(out string) map[string]string {
	urls := map[string]string{}
	for _, l := range strings.Split(out, "\n") {
		name, rest, ok := strings.Cut(l, "\t")
		u, kind, ok2 := strings.Cut(rest, " (")
		if !ok || !ok2 || kind != "fetch)" {
			continue
		}
		urls[name] = redactURL(u)
	}
	return urls
}

// redactURL drops what of a remote's URL may hold a token: a URL's user
// information (https://user:token@host/…), also one whose password holds
// a raw '/', '?' or '#' or '@', and its query and fragment
// (?access_token=…); of the scp-like form (user@host:path) a user with a
// password.
func redactURL(s string) string {
	if i := strings.Index(s, "://"); i > 0 {
		head, rest := s[:i+3], s[i+3:]
		if at := strings.IndexByte(rest, '@'); at >= 0 {
			// The authority as a URL parser reads it ends at the first of
			// "/?#"; an '@' past it is the path's only when what comes
			// before is a host. Otherwise the user information ends at
			// the last '@' before the end of the part the first '@' is in.
			auth := rest
			if j := strings.IndexAny(rest, "/?#"); j >= 0 {
				auth = rest[:j]
			}
			if at < len(auth) || !hostPort(auth) {
				end := len(rest)
				if j := strings.IndexAny(rest[at:], "/?#"); j >= 0 {
					end = at + j
				}
				rest = rest[strings.LastIndexByte(rest[:end], '@')+1:]
			}
		}
		if j := strings.IndexAny(rest, "?#"); j >= 0 {
			rest = rest[:j]
		}
		return head + rest
	}
	host := s
	if j := strings.IndexByte(s, '/'); j >= 0 {
		host = s[:j]
	}
	if at := strings.LastIndexByte(host, '@'); at > 0 && strings.Contains(s[:at], ":") {
		return s[at+1:]
	}
	return s
}

// hostPort reports whether s reads as a URL's host with an optional port
// (empty, as file:///, included): a name of letters, digits, '-', '.' and
// percent escapes, or a bracketed IPv6 literal.
func hostPort(s string) bool {
	if strings.HasPrefix(s, "[") {
		j := strings.IndexByte(s, ']')
		if j < 0 {
			return false
		}
		s = "h" + s[j+1:]
	}
	host, port, hasPort := strings.Cut(s, ":")
	if hasPort {
		for _, c := range port {
			if c < '0' || c > '9' {
				return false
			}
		}
	}
	for _, c := range host {
		if !(c == '-' || c == '.' || c == '%' || '0' <= c && c <= '9' || 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || c > 0x7f) {
			return false
		}
	}
	return true
}

// progress is the operation in progress in a git directory.
func progress(gitDir string) string {
	has := func(name string) bool {
		_, err := os.Stat(filepath.Join(gitDir, name))
		return err == nil
	}
	switch {
	case gitDir == "":
		return ""
	case has("rebase-merge"), has("rebase-apply"):
		return "rebase"
	case has("MERGE_HEAD"):
		return "merge"
	case has("CHERRY_PICK_HEAD"):
		return "cherryPick"
	case has("REVERT_HEAD"):
		return "revert"
	}
	return ""
}

// ---- status ----

// File is a changed path.
type File struct {
	Path string `json:"path"`
	// Orig is a renamed or copied path's earlier name.
	Orig string `json:"orig,omitempty"`
	// X is the index's status letter, Y the working tree's ("." when
	// unchanged): M, T, A, D, R, C, U; "?" for an untracked file, "!"
	// for an ignored one.
	X string `json:"x"`
	Y string `json:"y"`
	// Kind: changed, renamed, unmerged, untracked or ignored.
	Kind      string `json:"kind"`
	Submodule bool   `json:"submodule,omitempty"`
	// MTime (unix milliseconds) and Size of the working tree's file when
	// it differs from the index (or is untracked or conflicted): they
	// move when the file is edited again while its letters stay.
	MTime int64 `json:"mtime,omitempty"`
	Size  int64 `json:"size,omitempty"`
}

// Status is the state of the index and the working tree.
type Status struct {
	Branch    string `json:"branch,omitempty"`
	Head      string `json:"head,omitempty"`
	Upstream  string `json:"upstream,omitempty"`
	Ahead     int    `json:"ahead"`
	Behind    int    `json:"behind"`
	State     string `json:"state,omitempty"`
	Files     []File `json:"files"`
	Truncated bool   `json:"truncated,omitempty"`
}

func (r *repo) status(ctx context.Context) (*Status, error) {
	res, err := r.git(ctx, run{args: []string{"status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"}})
	if err != nil {
		return nil, err
	}
	st := parseStatus(res.out)
	if gd, _ := gitDirs(r.root); gd != "" {
		st.State = progress(gd)
	}
	r.stamp(st.Files)
	return st, nil
}

// stamp gives the files whose working tree side differs from the index
// the modification time and size of that side (no contents are read).
func (r *repo) stamp(files []File) {
	for i := range files {
		f := &files[i]
		if f.Kind == "ignored" || f.Y == "." || f.Y == "D" {
			continue
		}
		fi, err := os.Lstat(filepath.Join(r.root, filepath.FromSlash(strings.TrimSuffix(f.Path, "/"))))
		if err != nil {
			continue
		}
		f.MTime, f.Size = fi.ModTime().UnixMilli(), fi.Size()
		if fi.IsDir() {
			f.Size = 0
		}
	}
}

// parseStatus reads git status --porcelain=v2 -z --branch.
func parseStatus(out []byte) *Status {
	st := &Status{Files: []File{}}
	recs := strings.Split(string(out), "\x00")
	for i := 0; i < len(recs); i++ {
		rec := recs[i]
		if rec == "" {
			continue
		}
		if len(st.Files) >= maxStatus {
			st.Truncated = true
			break
		}
		switch rec[0] {
		case '#':
			f := strings.Fields(rec)
			if len(f) < 3 {
				continue
			}
			switch f[1] {
			case "branch.oid":
				if f[2] != "(initial)" {
					st.Head = f[2]
				}
			case "branch.head":
				if f[2] != "(detached)" {
					st.Branch = f[2]
				}
			case "branch.upstream":
				st.Upstream = f[2]
			case "branch.ab":
				if len(f) >= 4 {
					st.Ahead, _ = strconv.Atoi(strings.TrimPrefix(f[2], "+"))
					st.Behind, _ = strconv.Atoi(strings.TrimPrefix(f[3], "-"))
				}
			}
		case '1':
			// 1 XY sub mH mI mW hH hI path
			f := strings.SplitN(rec, " ", 9)
			if len(f) == 9 {
				st.Files = append(st.Files, File{Path: f[8], X: f[1][:1], Y: f[1][1:], Kind: "changed", Submodule: f[2][0] == 'S'})
			}
		case '2':
			// 2 XY sub mH mI mW hH hI Xscore path, then the original path
			f := strings.SplitN(rec, " ", 10)
			if len(f) == 10 && i+1 < len(recs) {
				i++
				st.Files = append(st.Files, File{Path: f[9], Orig: recs[i], X: f[1][:1], Y: f[1][1:], Kind: "renamed", Submodule: f[2][0] == 'S'})
			}
		case 'u':
			// u XY sub m1 m2 m3 mW h1 h2 h3 path
			f := strings.SplitN(rec, " ", 11)
			if len(f) == 11 {
				st.Files = append(st.Files, File{Path: f[10], X: f[1][:1], Y: f[1][1:], Kind: "unmerged"})
			}
		case '?':
			st.Files = append(st.Files, File{Path: rec[2:], X: "?", Y: "?", Kind: "untracked"})
		case '!':
			st.Files = append(st.Files, File{Path: rec[2:], X: "!", Y: "!", Kind: "ignored"})
		}
	}
	return st
}

// ---- log ----

// Commit is a commit of the log.
type Commit struct {
	Hash    string   `json:"hash"`
	Parents []string `json:"parents"`
	Author  string   `json:"author"`
	Email   string   `json:"email"`
	// Date is the author's date, unix seconds.
	Date    int64  `json:"date"`
	Subject string `json:"subject"`
}

// Ref is a branch, remote branch or tag and the commit it names.
type Ref struct {
	// Name is the full name (refs/heads/main).
	Name string `json:"name"`
	Hash string `json:"hash"`
}

// Stash is an entry of the stash.
type Stash struct {
	Index   int    `json:"index"`
	Hash    string `json:"hash"`
	Base    string `json:"base"`
	Date    int64  `json:"date"`
	Message string `json:"message"`
}

// Log is a page of the history.
type Log struct {
	Commits []Commit `json:"commits"`
	// More says that later pages exist.
	More bool `json:"more"`
	// Refs, Stashes and Head come with the first page.
	Refs    []Ref   `json:"refs,omitempty"`
	Stashes []Stash `json:"stashes,omitempty"`
	Head    string  `json:"head,omitempty"`
	Branch  string  `json:"branch,omitempty"`
}

const logFormat = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e"

func (r *repo) log(ctx context.Context, p Params) (*Log, error) {
	limit := p.Limit
	if limit <= 0 {
		limit = PageSize
	}
	limit = min(limit, MaxPage)
	if p.Skip < 0 {
		return nil, plugin.Errorf("bad_params", "negative skip")
	}
	head := ""
	if res, err := r.git(ctx, run{args: []string{"rev-parse", "-q", "--verify", "HEAD"}, ok: []int{1, 128}}); err == nil && res.code == 0 {
		head = strings.TrimSpace(string(res.out))
	}
	args := []string{"log", "--date-order", logFormat, "--skip=" + strconv.Itoa(p.Skip), "--max-count=" + strconv.Itoa(limit+1)}
	if len(p.Branches) > 0 {
		if len(p.Branches) > 100 {
			return nil, plugin.Errorf("bad_params", "at most 100 branches")
		}
		for _, b := range p.Branches {
			if _, err := r.rev(ctx, b); err != nil {
				return nil, err
			}
			args = append(args, b)
		}
	} else {
		args = append(args, "--branches", "--tags")
		if p.Remotes {
			args = append(args, "--remotes")
		}
		if head != "" {
			args = append(args, "HEAD")
		}
	}
	args = append(args, "--")
	// On a branch without commits yet (HEAD names none) the other
	// branches still have theirs; with no refs at all the log is empty.
	out := &Log{Commits: []Commit{}, Head: head}
	res, err := r.git(ctx, run{args: args})
	if err != nil {
		return nil, err
	}
	if cs := parseLog(res.out); cs != nil {
		out.Commits = cs
	}
	if len(out.Commits) > limit {
		out.Commits, out.More = out.Commits[:limit], true
	}
	if p.Skip == 0 {
		refs, err := r.refs(ctx)
		if err != nil {
			return nil, err
		}
		out.Refs = refs
		if out.Stashes, err = r.stashes(ctx); err != nil {
			return nil, err
		}
		if res, err := r.git(ctx, run{args: []string{"symbolic-ref", "-q", "--short", "HEAD"}, ok: []int{1}}); err == nil && res.code == 0 {
			out.Branch = strings.TrimSpace(string(res.out))
		}
	}
	return out, nil
}

func parseLog(out []byte) []Commit {
	var cs []Commit
	for _, rec := range strings.Split(string(out), "\x1e") {
		rec = strings.TrimLeft(rec, "\n")
		if rec == "" {
			continue
		}
		f := strings.SplitN(rec, "\x1f", 6)
		if len(f) < 6 {
			continue
		}
		date, _ := strconv.ParseInt(f[4], 10, 64)
		parents := strings.Fields(f[1])
		if parents == nil {
			parents = []string{}
		}
		cs = append(cs, Commit{Hash: f[0], Parents: parents, Author: f[2], Email: f[3], Date: date, Subject: f[5]})
	}
	return cs
}

// refs are the branches, remote branches and tags (peeled to their
// commits), without the remotes' symbolic HEADs.
func (r *repo) refs(ctx context.Context) ([]Ref, error) {
	res, err := r.git(ctx, run{args: []string{"for-each-ref", "--format=%(objectname)%00%(*objectname)%00%(refname)%00%(symref)", "refs/heads", "refs/remotes", "refs/tags"}})
	if err != nil {
		return nil, err
	}
	refs := []Ref{}
	for _, l := range strings.Split(string(res.out), "\n") {
		f := strings.Split(l, "\x00")
		if len(f) < 4 || f[3] != "" {
			continue
		}
		h := f[0]
		if f[1] != "" {
			h = f[1]
		}
		refs = append(refs, Ref{Name: f[2], Hash: h})
	}
	return refs, nil
}

func (r *repo) stashes(ctx context.Context) ([]Stash, error) {
	res, err := r.git(ctx, run{args: []string{"stash", "list", "--format=%H%x1f%P%x1f%at%x1f%gs%x1e"}})
	if err != nil {
		return nil, err
	}
	out := []Stash{}
	for _, rec := range strings.Split(string(res.out), "\x1e") {
		rec = strings.TrimLeft(rec, "\n")
		f := strings.SplitN(rec, "\x1f", 4)
		if len(f) < 4 {
			continue
		}
		parents := strings.Fields(f[1])
		base := ""
		if len(parents) > 0 {
			base = parents[0]
		}
		date, _ := strconv.ParseInt(f[2], 10, 64)
		out = append(out, Stash{Index: len(out), Hash: f[0], Base: base, Date: date, Message: f[3]})
	}
	return out, nil
}

// ---- show ----

// Detail is a commit with its whole message and committer.
type Detail struct {
	Commit
	Committer      string `json:"committer"`
	CommitterEmail string `json:"committerEmail"`
	CommitDate     int64  `json:"commitDate"`
	Message        string `json:"message"`
}

// Change is a file a commit or compare changed.
type Change struct {
	Path string `json:"path"`
	Orig string `json:"orig,omitempty"`
	// Status: A, M, D, R, C, T.
	Status  string `json:"status"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
	Binary  bool   `json:"binary,omitempty"`
}

// Shown is a commit's changes against one of its parents, or the changes
// between two commits.
type Shown struct {
	Commit *Detail  `json:"commit,omitempty"`
	Base   string   `json:"base"`
	Target string   `json:"target"`
	Files  []Change `json:"files"`
}

func (r *repo) show(ctx context.Context, p Params) (*Shown, error) {
	rev, err := r.rev(ctx, p.Rev)
	if err != nil {
		return nil, err
	}
	out := &Shown{Target: rev, Files: []Change{}}
	if p.Rev2 != "" {
		target, err := r.rev(ctx, p.Rev2)
		if err != nil {
			return nil, err
		}
		out.Base, out.Target = rev, target
	} else {
		res, err := r.git(ctx, run{args: []string{"show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B", rev, "--"}})
		if err != nil {
			return nil, err
		}
		f := strings.SplitN(string(res.out), "\x1f", 9)
		if len(f) < 9 {
			return nil, plugin.Errorf("failed", "unexpected output of git show")
		}
		d := &Detail{Committer: f[5], CommitterEmail: f[6], Message: strings.TrimRight(f[8], "\n")}
		d.Hash, d.Author, d.Email = f[0], f[2], f[3]
		d.Parents = strings.Fields(f[1])
		if d.Parents == nil {
			d.Parents = []string{}
		}
		d.Date, _ = strconv.ParseInt(f[4], 10, 64)
		d.CommitDate, _ = strconv.ParseInt(f[7], 10, 64)
		d.Subject, _, _ = strings.Cut(d.Message, "\n")
		out.Commit, out.Target = d, d.Hash
		n := max(p.Parent, 1)
		switch {
		case len(d.Parents) == 0:
			if out.Base, err = r.emptyTree(ctx); err != nil {
				return nil, err
			}
		case n > len(d.Parents):
			return nil, plugin.Errorf("bad_params", "no parent %d", n)
		default:
			out.Base = d.Parents[n-1]
		}
	}
	files, err := r.changes(ctx, out.Base, out.Target)
	if err != nil {
		return nil, err
	}
	out.Files = files
	return out, nil
}

// emptyTree is the hash of the empty tree in the repository's format.
func (r *repo) emptyTree(ctx context.Context) (string, error) {
	res, err := r.git(ctx, run{args: []string{"hash-object", "-t", "tree", "/dev/null"}})
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(res.out)), nil
}

// changes are the files that differ between two commits (or trees).
func (r *repo) changes(ctx context.Context, base, target string) ([]Change, error) {
	ns, err := r.git(ctx, run{args: []string{"diff", "--no-ext-diff", "--no-textconv", "-z", "-M", "--name-status", base, target, "--"}})
	if err != nil {
		return nil, err
	}
	num, err := r.git(ctx, run{args: []string{"diff", "--no-ext-diff", "--no-textconv", "-z", "-M", "--numstat", base, target, "--"}})
	if err != nil {
		return nil, err
	}
	files := parseNameStatus(ns.out)
	counts := parseNumstat(num.out)
	for i := range files {
		if c, ok := counts[files[i].Path]; ok {
			files[i].Added, files[i].Deleted, files[i].Binary = c.Added, c.Deleted, c.Binary
		}
	}
	return files, nil
}

// parseNameStatus reads diff --name-status -z: "M\0path\0" and
// "R100\0orig\0path\0".
func parseNameStatus(out []byte) []Change {
	f := strings.Split(string(out), "\x00")
	files := []Change{}
	for i := 0; i+1 < len(f); i++ {
		st := f[i]
		if st == "" {
			continue
		}
		c := Change{Status: st[:1]}
		if (c.Status == "R" || c.Status == "C") && i+2 < len(f) {
			c.Orig, c.Path = f[i+1], f[i+2]
			i += 2
		} else {
			c.Path = f[i+1]
			i++
		}
		files = append(files, c)
	}
	return files
}

// parseNumstat reads diff --numstat -z: "a\td\tpath\0" and
// "a\td\t\0orig\0path\0", "-\t-\t" for binary files.
func parseNumstat(out []byte) map[string]Change {
	f := strings.Split(string(out), "\x00")
	m := map[string]Change{}
	for i := 0; i < len(f); i++ {
		rec := f[i]
		if rec == "" {
			continue
		}
		parts := strings.SplitN(rec, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		p := parts[2]
		if p == "" && i+2 < len(f) {
			p = f[i+2]
			i += 2
		}
		c := Change{Path: p}
		if parts[0] == "-" {
			c.Binary = true
		} else {
			c.Added, _ = strconv.Atoi(parts[0])
			c.Deleted, _ = strconv.Atoi(parts[1])
		}
		m[p] = c
	}
	return m
}

// ---- blob ----

// Blob is a file's contents in the working tree, the index or a commit.
type Blob struct {
	Exists   bool   `json:"exists"`
	Binary   bool   `json:"binary,omitempty"`
	TooLarge bool   `json:"tooLarge,omitempty"`
	Text     string `json:"text"`
	Size     int64  `json:"size"`
	// MTime (unix milliseconds) of a file of the working tree: the
	// version an editor saves against.
	MTime int64 `json:"mtime,omitempty"`
}

func (r *repo) blob(ctx context.Context, p Params) (*Blob, error) {
	rel, err := cleanPath(p.Path)
	if err != nil {
		return nil, err
	}
	if strings.HasSuffix(rel, "/") {
		// A directory (an untracked repository inside this one).
		return &Blob{}, nil
	}
	var obj string
	switch p.Source {
	case "worktree":
		return r.worktreeBlob(rel)
	case "index":
		obj = ":0:" + rel
	case "head", "":
		obj = "HEAD:" + rel
	default:
		rev, err := r.rev(ctx, p.Source)
		if err != nil {
			return nil, err
		}
		if p.Parent > 0 {
			rev += "^" + strconv.Itoa(p.Parent)
		}
		obj = rev + ":" + rel
	}
	res, err := r.git(ctx, run{args: []string{"cat-file", "-s", obj}, ok: []int{128}})
	if err != nil {
		return nil, err
	}
	if res.code != 0 {
		return &Blob{}, nil
	}
	size, _ := strconv.ParseInt(strings.TrimSpace(string(res.out)), 10, 64)
	if size > MaxBlob {
		return &Blob{Exists: true, TooLarge: true, Size: size}, nil
	}
	res, err = r.git(ctx, run{args: []string{"cat-file", "blob", obj}, limit: MaxBlob + 1, ok: []int{128}})
	if err != nil {
		return nil, err
	}
	if res.code != 0 {
		return &Blob{}, nil
	}
	return blobOf(res.out, size, 0), nil
}

// worktreeBlob reads a file of the working tree. A link is shown as its
// target; a directory on the way that is a link must lead into the
// repository, so a link to "/" does not make the rest of the machine a
// part of it. The file is opened without following a link put there
// meanwhile, without blocking on a FIFO, and read up to MaxBlob.
func (r *repo) worktreeBlob(rel string) (*Blob, error) {
	root, err := filepath.EvalSymlinks(r.root)
	if err != nil {
		return &Blob{}, nil
	}
	full := filepath.Join(r.root, filepath.FromSlash(rel))
	dir, err := filepath.EvalSymlinks(filepath.Dir(full))
	if err != nil || (dir != root && !strings.HasPrefix(dir, root+string(filepath.Separator))) {
		return &Blob{}, nil
	}
	full = filepath.Join(dir, filepath.Base(full))
	fi, err := os.Lstat(full)
	if err != nil || fi.IsDir() {
		return &Blob{}, nil
	}
	mtime := fi.ModTime().UnixMilli()
	if fi.Mode()&fs.ModeSymlink != 0 {
		target, err := os.Readlink(full)
		if err != nil {
			return &Blob{}, nil
		}
		return blobOf([]byte(target), int64(len(target)), mtime), nil
	}
	if !fi.Mode().IsRegular() {
		return &Blob{}, nil
	}
	f, err := os.OpenFile(full, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ELOOP) {
			return &Blob{}, nil
		}
		return nil, plugin.Errorf("denied", "%v", err)
	}
	defer f.Close()
	if fi, err = f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return &Blob{}, nil
	}
	mtime = fi.ModTime().UnixMilli()
	if fi.Size() > MaxBlob {
		return &Blob{Exists: true, TooLarge: true, Size: fi.Size(), MTime: mtime}, nil
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxBlob+1))
	if err != nil {
		return nil, plugin.Errorf("denied", "%v", err)
	}
	if len(b) > MaxBlob {
		return &Blob{Exists: true, TooLarge: true, Size: int64(len(b)), MTime: mtime}, nil
	}
	return blobOf(b, int64(len(b)), mtime), nil
}

func blobOf(b []byte, size, mtime int64) *Blob {
	bl := &Blob{Exists: true, Size: size, MTime: mtime}
	if bytes.IndexByte(b[:min(len(b), 8000)], 0) >= 0 || !utf8.Valid(b) {
		bl.Binary = true
		return bl
	}
	bl.Text = string(b)
	return bl
}

// ---- refs ----

// Branch is a local or remote branch.
type Branch struct {
	// Name is the short name (main, origin/main), Full the ref.
	Name     string `json:"name"`
	Full     string `json:"full"`
	Hash     string `json:"hash"`
	Remote   bool   `json:"remote,omitempty"`
	Current  bool   `json:"current,omitempty"`
	Upstream string `json:"upstream,omitempty"`
	Ahead    int    `json:"ahead,omitempty"`
	Behind   int    `json:"behind,omitempty"`
	// Gone says that the upstream branch no longer exists.
	Gone    bool   `json:"gone,omitempty"`
	Date    int64  `json:"date"`
	Subject string `json:"subject"`
}

// MaxTracked bounds the branches with an upstream whose ahead and behind
// branches reads: each takes a walk of history, and repositories with
// thousands of branches would wait for them all.
const MaxTracked = 300

func (r *repo) branches(ctx context.Context) ([]Branch, error) {
	res, err := r.git(ctx, run{args: []string{"for-each-ref",
		"--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(committerdate:raw)%00%(symref)%00%(contents:subject)",
		"refs/heads", "refs/remotes"}})
	if err != nil {
		return nil, err
	}
	out := []Branch{}
	tracked := 0
	for _, l := range strings.Split(string(res.out), "\n") {
		f := strings.Split(l, "\x00")
		if len(f) < 7 || f[5] != "" {
			continue
		}
		b := Branch{Full: f[0], Hash: f[1], Upstream: f[2], Current: f[3] == "*", Subject: f[6]}
		b.Date, _ = strconv.ParseInt(strings.Fields(f[4] + " 0")[0], 10, 64)
		if strings.HasPrefix(f[0], "refs/remotes/") {
			b.Remote, b.Name = true, strings.TrimPrefix(f[0], "refs/remotes/")
		} else {
			b.Name = strings.TrimPrefix(f[0], "refs/heads/")
			if b.Upstream != "" {
				tracked++
			}
		}
		out = append(out, b)
	}
	if tracked == 0 || tracked > MaxTracked {
		return out, nil
	}
	// Ahead, behind and gone upstreams of the local branches.
	res, err = r.git(ctx, run{args: []string{"for-each-ref", "--format=%(refname)%00%(upstream:track,nobracket)", "refs/heads"}})
	if err != nil {
		return nil, err
	}
	track := map[string]string{}
	for _, l := range strings.Split(string(res.out), "\n") {
		if name, t, ok := strings.Cut(l, "\x00"); ok {
			track[name] = t
		}
	}
	for i := range out {
		b := &out[i]
		if b.Remote || b.Upstream == "" {
			continue
		}
		for _, part := range strings.Split(track[b.Full], ",") {
			part = strings.TrimSpace(part)
			switch {
			case part == "gone":
				b.Gone = true
			case strings.HasPrefix(part, "ahead "):
				b.Ahead, _ = strconv.Atoi(strings.TrimPrefix(part, "ahead "))
			case strings.HasPrefix(part, "behind "):
				b.Behind, _ = strconv.Atoi(strings.TrimPrefix(part, "behind "))
			}
		}
	}
	return out, nil
}

// Tag is a tag and the commit it names.
type Tag struct {
	Name      string `json:"name"`
	Hash      string `json:"hash"`
	Annotated bool   `json:"annotated,omitempty"`
	Date      int64  `json:"date"`
	Subject   string `json:"subject,omitempty"`
}

func (r *repo) tags(ctx context.Context) ([]Tag, error) {
	res, err := r.git(ctx, run{args: []string{"for-each-ref",
		"--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(creatordate:raw)%00%(contents:subject)",
		"refs/tags"}})
	if err != nil {
		return nil, err
	}
	out := []Tag{}
	for _, l := range strings.Split(string(res.out), "\n") {
		f := strings.Split(l, "\x00")
		if len(f) < 6 {
			continue
		}
		t := Tag{Name: strings.TrimPrefix(f[0], "refs/tags/"), Hash: f[1], Annotated: f[3] == "tag"}
		if f[2] != "" {
			t.Hash = f[2]
		}
		if t.Annotated {
			t.Subject = f[5]
		}
		t.Date, _ = strconv.ParseInt(strings.Fields(f[4] + " 0")[0], 10, 64)
		out = append(out, t)
	}
	return out, nil
}

// DiffStat are the lines added and deleted per path in the working tree
// (against the index) and in the index (against HEAD).
type DiffStat struct {
	Worktree map[string][2]int `json:"worktree"`
	Staged   map[string][2]int `json:"staged"`
}

func (r *repo) diffStat(ctx context.Context) (*DiffStat, error) {
	out := &DiffStat{Worktree: map[string][2]int{}, Staged: map[string][2]int{}}
	for _, side := range []struct {
		args []string
		into map[string][2]int
	}{
		{[]string{"diff", "--no-ext-diff", "--no-textconv", "-z", "--numstat", "--"}, out.Worktree},
		{[]string{"diff", "--no-ext-diff", "--no-textconv", "-z", "--numstat", "--cached", "--"}, out.Staged},
	} {
		res, err := r.git(ctx, run{args: side.args})
		if err != nil {
			return nil, err
		}
		for p, c := range parseNumstat(res.out) {
			side.into[p] = [2]int{c.Added, c.Deleted}
		}
	}
	return out, nil
}

// ---- watch ----

// Watch is a token that changes when the repository's index, HEAD, refs,
// configuration or an operation in progress change; the panel polls it
// and reads the status again when it changed. Refs changes only with
// HEAD, the refs (also in reftable) and the stashes: what the history
// shows. Config changes with the configuration (remotes).
type Watch struct {
	Token  string `json:"token"`
	Refs   string `json:"refs"`
	Config string `json:"config"`
}

// gitDirs finds a repository's git directory and common directory
// without running git: .git is the directory, or a file "gitdir: <dir>"
// (a linked worktree, a submodule) whose directory may name the common
// one in its file commondir.
func gitDirs(root string) (gitDir, common string) {
	dot := filepath.Join(root, ".git")
	fi, err := os.Stat(dot)
	if err != nil {
		return "", ""
	}
	gitDir = dot
	if !fi.IsDir() {
		b, err := os.ReadFile(dot)
		if err != nil {
			return "", ""
		}
		line, _, _ := strings.Cut(string(b), "\n")
		d, ok := strings.CutPrefix(strings.TrimSpace(line), "gitdir:")
		if !ok {
			return "", ""
		}
		d = strings.TrimSpace(d)
		if !filepath.IsAbs(d) {
			d = filepath.Join(root, d)
		}
		gitDir = filepath.Clean(d)
	}
	common = gitDir
	if b, err := os.ReadFile(filepath.Join(gitDir, "commondir")); err == nil {
		c := strings.TrimSpace(string(b))
		if !filepath.IsAbs(c) {
			c = filepath.Join(gitDir, c)
		}
		common = filepath.Clean(c)
	}
	return gitDir, common
}

// maxWatched bounds the entries of refs/ a watch looks at.
const maxWatched = 4000

func (r *repo) watch() (*Watch, error) {
	gitDir, common := gitDirs(r.root)
	if gitDir == "" {
		return nil, plugin.Errorf("not_a_repo", "%s has no git directory", r.root)
	}
	add := func(h io.Writer, p string) {
		fi, err := os.Stat(p)
		if err != nil {
			fmt.Fprintf(h, "%s -\n", p)
			return
		}
		fmt.Fprintf(h, "%s %d %d\n", p, fi.ModTime().UnixNano(), fi.Size())
	}
	refs := sha256.New()
	for _, name := range []string{"HEAD", "logs/HEAD"} {
		add(refs, filepath.Join(gitDir, name))
	}
	for _, name := range []string{"packed-refs", "logs/refs/stash"} {
		add(refs, filepath.Join(common, name))
	}
	// Refs in reftable: every update writes a table and names it in
	// tables.list.
	for _, d := range []string{gitDir, common} {
		if b, err := readSmall(filepath.Join(d, "reftable", "tables.list"), 64<<10); err == nil {
			fmt.Fprintf(refs, "%s %x\n", d, sha256.Sum256(b))
		}
		if d == common {
			break
		}
	}
	n := 0
	filepath.WalkDir(filepath.Join(common, "refs"), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if n++; n > maxWatched {
			return fs.SkipAll
		}
		add(refs, p)
		return nil
	})
	refsSum := refs.Sum(nil)
	config := sha256.New()
	add(config, filepath.Join(common, "config"))
	add(config, filepath.Join(gitDir, "config.worktree"))
	configSum := config.Sum(nil)
	all := sha256.New()
	all.Write(refsSum)
	all.Write(configSum)
	for _, name := range []string{"index", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"} {
		add(all, filepath.Join(gitDir, name))
	}
	add(all, filepath.Join(common, "FETCH_HEAD"))
	return &Watch{
		Token:  hex.EncodeToString(all.Sum(nil)[:12]),
		Refs:   hex.EncodeToString(refsSum[:12]),
		Config: hex.EncodeToString(configSum[:12]),
	}, nil
}

// readSmall reads a regular file, at most limit bytes of it.
func readSmall(p string, limit int64) ([]byte, error) {
	f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil || !fi.Mode().IsRegular() {
		return nil, fs.ErrInvalid
	}
	return io.ReadAll(io.LimitReader(f, limit))
}
