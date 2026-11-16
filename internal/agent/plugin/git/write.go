//go:build unix

package git

import (
	"context"
	"strconv"
	"strings"

	"herdr-ide/internal/agent/plugin"
)

// Done answers a change: what git printed.
type Done struct {
	Output string `json:"output,omitempty"`
}

// change runs a change: its runs of git, in order, each an argument
// vector built from checked values; the first that fails ends it.
func (r *repo) change(ctx context.Context, action string, p Params) (*Done, error) {
	runs, err := r.runs(ctx, action, p)
	if err != nil {
		return nil, err
	}
	var out strings.Builder
	for _, rn := range runs {
		if rn.timeout == 0 {
			rn.timeout = NetTimeout
		}
		res, err := r.git(ctx, rn)
		if err != nil {
			return nil, err
		}
		if out.Len() < 4000 {
			out.WriteString(strings.TrimSpace(string(res.out) + "\n" + string(res.err)))
			out.WriteString("\n")
		}
	}
	s := strings.TrimSpace(out.String())
	if len(s) > 4000 {
		s = s[:4000] + "…"
	}
	return &Done{Output: s}, nil
}

// runs builds the runs of a change: the paths of stage, unstage and
// discard as literal pathspecs, over several runs when there are many
// (pathRuns); every other change is one run (argv).
func (r *repo) runs(ctx context.Context, action string, p Params) ([]run, error) {
	paths := func(ps []string) ([]string, error) {
		c, err := cleanPaths(ps)
		if err == nil && len(c) == 0 {
			err = plugin.Errorf("bad_params", "no paths")
		}
		return c, err
	}
	switch action {
	case "stage":
		if p.All {
			return []run{{args: []string{"add", "--all"}}}, nil
		}
		ps, err := paths(p.Paths)
		if err != nil {
			return nil, err
		}
		return pathRuns([]string{"add", "--all"}, ps), nil

	case "unstage":
		var ps []string
		if !p.All {
			var err error
			if ps, err = paths(p.Paths); err != nil {
				return nil, err
			}
		}
		if !r.hasHead(ctx) {
			// Before the first commit nothing is in HEAD to restore: the
			// index loses the paths (-f also those changed since they
			// were staged; the working tree keeps them).
			if p.All {
				return []run{{args: []string{"rm", "--cached", "-r", "-f", "-q", "--", "."}}}, nil
			}
			return pathRuns([]string{"rm", "--cached", "-r", "-f", "-q"}, ps), nil
		}
		if p.All {
			return []run{{args: []string{"reset", "-q", "HEAD", "--"}}}, nil
		}
		return pathRuns([]string{"restore", "--staged"}, ps), nil

	case "discard":
		tracked, err := cleanPaths(p.Paths)
		if err != nil {
			return nil, err
		}
		untracked, err := cleanPaths(p.Untracked)
		if err != nil {
			return nil, err
		}
		if len(tracked)+len(untracked) == 0 {
			return nil, plugin.Errorf("bad_params", "no paths")
		}
		if len(tracked)+len(untracked) > maxPaths {
			return nil, plugin.Errorf("bad_params", "at most %d paths", maxPaths)
		}
		// clean removes untracked files only, never a tracked one (nor an
		// untracked repository: that needs a second -f).
		return append(pathRuns([]string{"clean", "-f", "-q"}, untracked), pathRuns([]string{"restore", "--worktree"}, tracked)...), nil
	}
	rn, err := r.argv(ctx, action, p)
	if err != nil {
		return nil, err
	}
	return []run{rn}, nil
}

// argv builds the run of a change without paths. Values from the request
// are checked: revisions and names never start with "-", and no option is
// taken from the request.
func (r *repo) argv(ctx context.Context, action string, p Params) (run, error) {
	switch action {
	case "applyPatch":
		if p.Patch == "" || len(p.Patch) > MaxPatch {
			return run{}, plugin.Errorf("bad_params", "no patch or a patch over %d bytes", MaxPatch)
		}
		args := []string{"apply", "--whitespace=nowarn"}
		if p.Cached {
			args = append(args, "--cached")
		}
		if p.Reverse {
			args = append(args, "--reverse")
		}
		return run{args: append(args, "-"), stdin: []byte(p.Patch)}, nil

	case "commit":
		if len(p.Message) > MaxPatch {
			return run{}, plugin.Errorf("bad_params", "message too long")
		}
		// The message is the user's as typed: whitespace is tidied, lines
		// starting with "#" are kept (no editor added comments).
		args := []string{"commit", "--cleanup=whitespace"}
		if p.Amend {
			args = append(args, "--amend")
		}
		if p.Signoff {
			args = append(args, "--signoff")
		}
		if strings.TrimSpace(p.Message) == "" {
			if !p.Amend {
				return run{}, plugin.Errorf("empty_message", "no commit message")
			}
			return run{args: append(args, "--no-edit")}, nil
		}
		return run{args: append(args, "--file=-"), stdin: []byte(p.Message)}, nil

	case "checkout":
		if p.Rev != "" {
			// A commit, detached.
			rev, err := r.rev(ctx, p.Rev)
			if err != nil {
				return run{}, err
			}
			return run{args: []string{"checkout", "--detach", rev, "--"}}, nil
		}
		if err := plainName(p.Name); err != nil {
			return run{}, err
		}
		if err := r.refExists(ctx, "refs/heads/"+p.Name); err != nil {
			return run{}, err
		}
		return run{args: []string{"checkout", p.Name, "--"}}, nil

	case "branchCreate":
		if err := r.newName(ctx, "heads", p.Name); err != nil {
			return run{}, err
		}
		at := "HEAD"
		if p.At != "" {
			var err error
			if at, err = r.rev(ctx, p.At); err != nil {
				return run{}, err
			}
		}
		if p.Checkout {
			return run{args: []string{"checkout", "-b", p.Name, at, "--"}}, nil
		}
		return run{args: []string{"branch", p.Name, at}}, nil

	case "branchDelete":
		if err := plainName(p.Name); err != nil {
			return run{}, err
		}
		if p.Remote != "" {
			if err := r.remote(ctx, p.Remote); err != nil {
				return run{}, err
			}
			return run{args: []string{"push", p.Remote, "--delete", "refs/heads/" + p.Name}}, nil
		}
		if err := r.refExists(ctx, "refs/heads/"+p.Name); err != nil {
			return run{}, err
		}
		flag := "-d"
		if p.Force {
			flag = "-D"
		}
		return run{args: []string{"branch", flag, p.Name}}, nil

	case "branchRename":
		if err := plainName(p.Name); err != nil {
			return run{}, err
		}
		if err := r.refExists(ctx, "refs/heads/"+p.Name); err != nil {
			return run{}, err
		}
		if err := r.newName(ctx, "heads", p.To); err != nil {
			return run{}, err
		}
		return run{args: []string{"branch", "-m", p.Name, p.To}}, nil

	case "merge":
		ref, err := r.rev(ctx, p.Ref)
		if err != nil {
			return run{}, err
		}
		args := []string{"merge", "--no-edit"}
		if p.NoFF {
			args = append(args, "--no-ff")
		}
		return run{args: append(args, ref)}, nil

	case "rebase":
		onto, err := r.rev(ctx, p.Onto)
		if err != nil {
			return run{}, err
		}
		return run{args: []string{"rebase", onto}}, nil

	case "abort", "continue":
		sub := map[string]string{"merge": "merge", "rebase": "rebase", "cherryPick": "cherry-pick", "revert": "revert"}[p.Op]
		if sub == "" {
			return run{}, plugin.Errorf("bad_params", "unknown operation %q", p.Op)
		}
		return run{args: []string{sub, "--" + action}}, nil

	case "cherryPick", "revert":
		rev, err := r.rev(ctx, p.Rev)
		if err != nil {
			return run{}, err
		}
		args := []string{"cherry-pick"}
		if action == "revert" {
			args = []string{"revert", "--no-edit"}
		}
		if p.Parent > 0 {
			args = append(args, "--mainline", strconv.Itoa(p.Parent))
		}
		return run{args: append(args, rev)}, nil

	case "reset":
		mode := map[string]string{"soft": "--soft", "mixed": "--mixed", "hard": "--hard"}[p.Mode]
		if mode == "" {
			return run{}, plugin.Errorf("bad_params", "unknown mode %q", p.Mode)
		}
		rev, err := r.rev(ctx, p.Rev)
		if err != nil {
			return run{}, err
		}
		return run{args: []string{"reset", "-q", mode, rev, "--"}}, nil

	case "tagCreate":
		if err := r.newName(ctx, "tags", p.Name); err != nil {
			return run{}, err
		}
		at := "HEAD"
		if p.At != "" {
			var err error
			if at, err = r.rev(ctx, p.At); err != nil {
				return run{}, err
			}
		}
		if strings.TrimSpace(p.Message) != "" {
			if len(p.Message) > MaxPatch {
				return run{}, plugin.Errorf("bad_params", "message too long")
			}
			return run{args: []string{"tag", "--annotate", "--file=-", p.Name, at}, stdin: []byte(p.Message)}, nil
		}
		return run{args: []string{"tag", p.Name, at}}, nil

	case "tagDelete":
		if err := plainName(p.Name); err != nil {
			return run{}, err
		}
		if p.Remote != "" {
			if err := r.remote(ctx, p.Remote); err != nil {
				return run{}, err
			}
			return run{args: []string{"push", p.Remote, "--delete", "refs/tags/" + p.Name}}, nil
		}
		if err := r.refExists(ctx, "refs/tags/"+p.Name); err != nil {
			return run{}, err
		}
		return run{args: []string{"tag", "-d", p.Name}}, nil

	case "stashPush":
		args := []string{"stash", "push"}
		if p.IncludeUntracked {
			args = append(args, "--include-untracked")
		}
		if m := strings.TrimSpace(p.Message); m != "" {
			if strings.ContainsAny(m, "\x00") || len(m) > 4096 {
				return run{}, plugin.Errorf("bad_params", "bad message")
			}
			args = append(args, "--message="+m)
		}
		return run{args: args}, nil

	case "stashApply", "stashPop", "stashDrop":
		if p.Index < 0 || p.Index > 100000 {
			return run{}, plugin.Errorf("bad_params", "bad stash index")
		}
		if !fullHash.MatchString(p.Hash) {
			return run{}, plugin.Errorf("bad_params", "no stash commit")
		}
		// The entry is the one the UI showed: a stash pushed or dropped
		// meanwhile renumbers them.
		entry := "stash@{" + strconv.Itoa(p.Index) + "}"
		res, err := r.git(ctx, run{args: []string{"rev-parse", "-q", "--verify", entry}, ok: []int{1, 128}})
		if err != nil {
			return run{}, err
		}
		if res.code != 0 || !strings.EqualFold(strings.TrimSpace(string(res.out)), p.Hash) {
			return run{}, plugin.Errorf("stale", "%s is not %s", entry, p.Hash)
		}
		sub := strings.ToLower(strings.TrimPrefix(action, "stash"))
		return run{args: []string{"stash", sub, entry}}, nil

	case "fetch":
		args := []string{"fetch"}
		if p.Prune {
			args = append(args, "--prune")
		}
		if p.Remote == "" || p.All {
			return run{args: append(args, "--all")}, nil
		}
		if err := r.remote(ctx, p.Remote); err != nil {
			return run{}, err
		}
		return run{args: append(args, p.Remote)}, nil

	case "pull":
		// As the user's configuration says (pull.rebase, pull.ff) unless
		// asked to rebase; branches that diverged without one fail with
		// diverged.
		if p.Rebase {
			return run{args: []string{"pull", "--rebase"}}, nil
		}
		return run{args: []string{"pull"}}, nil

	case "push":
		args := []string{"push"}
		if p.ForceWithLease {
			args = append(args, "--force-with-lease")
		}
		if p.Remote == "" {
			if p.Branch != "" || p.Tag != "" || p.SetUpstream {
				return run{}, plugin.Errorf("bad_params", "a branch or tag needs a remote")
			}
			return run{args: args}, nil
		}
		if err := r.remote(ctx, p.Remote); err != nil {
			return run{}, err
		}
		switch {
		case p.Tag != "":
			if err := plainName(p.Tag); err != nil {
				return run{}, err
			}
			if err := r.refExists(ctx, "refs/tags/"+p.Tag); err != nil {
				return run{}, err
			}
			return run{args: append(args, p.Remote, "refs/tags/"+p.Tag)}, nil
		case p.Branch != "":
			if err := plainName(p.Branch); err != nil {
				return run{}, err
			}
			if err := r.refExists(ctx, "refs/heads/"+p.Branch); err != nil {
				return run{}, err
			}
			if p.SetUpstream {
				args = append(args, "--set-upstream")
			}
			return run{args: append(args, p.Remote, "refs/heads/"+p.Branch+":refs/heads/"+p.Branch)}, nil
		}
		return run{args: append(args, p.Remote)}, nil
	}
	return run{}, plugin.Errorf("bad_params", "unknown action %q", action)
}

// hasHead reports whether HEAD names a commit (not before the first one).
func (r *repo) hasHead(ctx context.Context) bool {
	res, err := r.git(ctx, run{args: []string{"rev-parse", "-q", "--verify", "HEAD"}, ok: []int{1, 128}})
	return err == nil && res.code == 0
}
